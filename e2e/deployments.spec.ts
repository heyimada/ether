import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

const WORKFLOW = `jobs:
  build:
    steps:
      - run: echo built
  staging:
    environment: staging
    steps:
      - name: Deploy
        shell: bash
        run: echo "deploying to $CI_ENVIRONMENT"
  production:
    environment:
      name: production
      url: https://prod.example.test
    steps:
      - shell: bash
        run: echo "live on $CI_ENVIRONMENT"
`;

type Job = { id: number; name: string; status: string; log: string; deployment: { environment: string; status: string; canReview: boolean } | null };

// The run for a commit once it stops moving: finished, or waiting for a deployment review.
async function settled(ctx: APIRequestContext, api: string, sha: string, want = ["success", "failure", "waiting", "cancelled", "error"]) {
  for (let i = 0; i < 300; i++) {
    const { runs } = await (await ctx.get(`${api}/ci/runs`)).json();
    const run = runs.find((r: { sha: string }) => r.sha === sha);
    if (run && want.includes(run.status)) {
      const detail = await (await ctx.get(`${api}/ci/runs/${run.id}`)).json();
      return { run, jobs: Object.fromEntries((detail.jobs as Job[]).map((j) => [j.name, j])) as Record<string, Job> };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const { runs } = await (await ctx.get(`${api}/ci/runs`)).json();
  throw new Error(`run for ${sha} didn't settle: ${JSON.stringify(runs.map((r: { sha: string; status: string; subject: string; jobs: unknown }) => ({ sha: r.sha.slice(0, 7), subject: r.subject, status: r.status, jobs: r.jobs })))}`);
}

test("deploy jobs go to environments, wait for a reviewer where required, and show on the repository and pull requests", async ({ page }, info) => {
  test.setTimeout(3 * 60_000);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  try {
    const owner = await createUser(admin);
    const reviewer = await createUser(admin);
    const writer = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("deploy"));
    const api = `/api/repos/${owner.username}/${repo}`;
    const auth = { username: owner.username, token: owner.token };
    for (const u of [reviewer, writer]) await owner.ctx.put(`${api}/collaborators/${u.username}`, { data: { role: "write" }, headers: headers() });
    expect((await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() })).ok()).toBe(true);

    // Production: only main, and someone has to approve. Reviewers need write access.
    expect((await owner.ctx.put(`${api}/environments/production`, { data: { branches: ["main"], reviewers: [reviewer.username] }, headers: headers() })).ok()).toBe(true);
    const reader = await createUser(admin);
    await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });
    expect((await owner.ctx.put(`${api}/environments/production`, { data: { reviewers: [reader.username] }, headers: headers() })).status()).toBe(400);
    expect((await writer.ctx.put(`${api}/environments/production`, { data: { reviewers: [writer.username] }, headers: headers() })).status()).toBe(403);
    expect((await owner.ctx.put(`${api}/environments/production`, { data: { branches: ["refs/heads/main"] }, headers: headers() })).status()).toBe(400);

    const src = workdir();
    gitOk(src, ["init", "-q"]);
    mkdirSync(join(src, ".ether"));
    writeFileSync(join(src, ".ether", "ci.yml"), WORKFLOW);
    writeFileSync(join(src, "app.txt"), "v1\n");
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "v1"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    const v1 = gitOk(src, ["rev-parse", "HEAD"]).trim();

    // Staging (made on first use, no rules) deploys; production waits for its reviewer.
    let { run, jobs } = await settled(owner.ctx, api, v1);
    expect(run.status).toBe("waiting");
    expect(jobs.build.status).toBe("success");
    expect(jobs.staging.status).toBe("success");
    expect(jobs.staging.log).toContain("deploying to staging");
    expect(jobs.production.status).toBe("waiting");
    expect(jobs.production.deployment).toMatchObject({ environment: "production", status: "waiting", canReview: false });

    // Only a reviewer may answer: not another writer, not even the owner.
    for (const who of [writer, owner])
      expect((await who.ctx.post(`${api}/ci/jobs/${jobs.production.id}/review`, { data: { approve: true }, headers: headers() })).status()).toBe(403);

    await uiLogin(page, reviewer.username, reviewer.password);
    await page.goto(`${baseURL()}/${owner.username}/${repo}/ci/${run.id}`);
    const prod = page.getByRole("region", { name: "Job production" });
    await expect(prod).toContainText("Deploys to production");
    await expect(prod).toContainText(`Waiting for ${reviewer.username} to approve.`);
    await info.attach("waiting-for-review", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await prod.getByRole("button", { name: "Approve and deploy" }).click();
    ({ run, jobs } = await settled(owner.ctx, api, v1, ["success", "failure"]));
    expect(run.status).toBe("success");
    expect(jobs.production.log).toContain(`Approved by ${reviewer.username}`);
    expect(jobs.production.log).toContain("live on production");
    expect((await reviewer.ctx.post(`${api}/ci/jobs/${jobs.production.id}/review`, { data: { approve: true }, headers: headers() })).status()).toBe(409);

    // The repository home shows what runs where.
    await page.goto(`${baseURL()}/${owner.username}/${repo}`);
    const side = page.getByRole("list", { name: "Environments" });
    await expect(side.getByRole("listitem", { name: "Environment production" })).toContainText(v1.slice(0, 7));
    await expect(side.getByRole("listitem", { name: "Environment staging" })).toContainText(v1.slice(0, 7));
    await info.attach("repo-deployments", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // A pull request from a feature branch: staging takes it, production skips the branch, and with
    // required checks the pull request can still merge, since deployments aren't checks.
    expect((await owner.ctx.patch(api, { data: { requireChecks: true }, headers: headers() })).ok()).toBe(true);
    gitOk(src, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(src, "app.txt"), "v2\n");
    gitOk(src, ["commit", "-qam", "v2"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "feature"], auth);
    const v2 = gitOk(src, ["rev-parse", "HEAD"]).trim();
    ({ run, jobs } = await settled(owner.ctx, api, v2, ["success", "failure"]));
    expect(run.status).toBe("success");
    expect(jobs.staging.status).toBe("success");
    expect(jobs.production.status).toBe("skipped");
    expect(jobs.production.log).toContain("feature isn't allowed to deploy here");
    expect(jobs.production.deployment).toBeNull();
    const { pull } = await (await owner.ctx.post(`${api}/pulls`, { data: { title: "v2", body: "", base: "main", head: "feature" }, headers: headers() })).json();
    await page.goto(`${baseURL()}/${owner.username}/${repo}/pull/${pull.number}`);
    await expect(page.getByRole("link", { name: "Deployed to staging" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Deployed to production" })).toHaveCount(0);
    await expect(page.getByText("All checks have passed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Merge pull request" })).toBeEnabled();

    // A deploy job waiting for its review doesn't hold the pull request's checks either.
    await owner.ctx.put(`${api}/environments/staging`, { data: { reviewers: [reviewer.username] }, headers: headers() });
    writeFileSync(join(src, "app.txt"), "v2b\n");
    gitOk(src, ["commit", "-qam", "v2b"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "feature"], auth);
    const v2b = gitOk(src, ["rev-parse", "HEAD"]).trim();
    ({ run, jobs } = await settled(owner.ctx, api, v2b));
    expect(run.status).toBe("waiting");
    expect((await (await owner.ctx.get(`${api}/pulls/${pull.number}`)).json()).checks.status).toBe("success");
    expect((await owner.ctx.post(`${api}/ci/runs/${run.id}/cancel`, { headers: headers() })).ok()).toBe(true);
    // Dropping the waiting deployment by cancelling the run leaves the passed checks alone.
    ({ run } = await settled(owner.ctx, api, v2b, ["cancelled"]));
    expect((await (await owner.ctx.get(`${api}/pulls/${pull.number}`)).json()).checks.status).toBe("success");
    await owner.ctx.put(`${api}/environments/staging`, { data: { reviewers: [] }, headers: headers() });

    // A reviewer can turn a deployment down, which fails the run; a waiting run can also be cancelled.
    gitOk(src, ["checkout", "-q", "main"]);
    writeFileSync(join(src, "app.txt"), "v3\n");
    gitOk(src, ["commit", "-qam", "v3"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    const v3 = gitOk(src, ["rev-parse", "HEAD"]).trim();
    ({ run, jobs } = await settled(owner.ctx, api, v3));
    expect((await reviewer.ctx.post(`${api}/ci/jobs/${jobs.production.id}/review`, { data: { approve: false }, headers: headers() })).ok()).toBe(true);
    ({ run, jobs } = await settled(owner.ctx, api, v3, ["success", "failure"]));
    expect(run.status).toBe("failure");
    expect(jobs.production.log).toContain(`Rejected by ${reviewer.username}`);
    expect(jobs.production.deployment!.status).toBe("rejected");
    // A rejection is a decision, not broken checks, so the pusher's feed doesn't report it as one.
    const feed = (await (await owner.ctx.get("/api/feed")).json()).events as { kind: string; repo: string; payload: { sha?: string } }[];
    expect(feed.filter((e) => e.kind === "ci_failed" && e.payload.sha === v3)).toEqual([]);

    writeFileSync(join(src, "app.txt"), "v4\n");
    gitOk(src, ["commit", "-qam", "v4"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    const v4 = gitOk(src, ["rev-parse", "HEAD"]).trim();
    ({ run } = await settled(owner.ctx, api, v4));
    expect(run.status).toBe("waiting");
    expect((await owner.ctx.post(`${api}/ci/runs/${run.id}/cancel`, { headers: headers() })).ok()).toBe(true);
    ({ run, jobs } = await settled(owner.ctx, api, v4, ["cancelled"]));
    expect(jobs.production.status).toBe("cancelled");
    expect(jobs.production.deployment!.status).toBe("cancelled");

    // Production still runs the approved v1; its history lists every attempt.
    const { environments } = await (await reader.ctx.get(`${api}/environments`)).json();
    const production = environments.find((e: { name: string }) => e.name === "production");
    expect(production.active.sha).toBe(v1);
    expect(production.reviewers).toEqual([reviewer.username]);
    const { deployments } = await (await reader.ctx.get(`${api}/deployments?environment=production`)).json();
    // The skipped feature-branch run left no deployment behind.
    expect(deployments.map((d: { status: string }) => d.status)).toEqual(["cancelled", "rejected", "success"]);

    // Owners see the rules in Settings, and environment secrets are owner-only.
    await page.context().clearCookies();
    await uiLogin(page, owner.username, owner.password);
    await page.goto(`${baseURL()}/${owner.username}/${repo}/settings`);
    await expect(page.getByRole("listitem", { name: "Environment production" })).toContainText(`only main · approval by ${reviewer.username}`);
    await page.getByRole("button", { name: "Edit environment staging" }).click();
    await page.getByRole("listitem", { name: "Environment staging" }).getByLabel("Wait timer (minutes)").fill("5");
    await page.getByRole("listitem", { name: "Environment staging" }).getByRole("button", { name: "Save environment" }).click();
    await expect(page.getByRole("listitem", { name: "Environment staging" })).toContainText("any branch · no approval · waits 5 min");
    expect((await writer.ctx.get(`${api}/environments/production/secrets`)).status()).toBe(403);
    expect((await owner.ctx.put(`${api}/environments/production/secrets/DEPLOY_TOKEN`, { data: { value: "s3cret" }, headers: headers() })).ok()).toBe(true);
    expect(JSON.stringify(await (await owner.ctx.get(`${api}/environments/production/secrets`)).json())).not.toContain("s3cret");

    const pushMain = async (content: string) => {
      writeFileSync(join(src, "app.txt"), `${content}\n`);
      gitOk(src, ["commit", "-qam", content]);
      gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
      const sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
      const settledRun = await settled(owner.ctx, api, sha);
      return { sha, ...settledRun };
    };
    const activeSha = async () => (await (await reader.ctx.get(`${api}/environments`)).json()).environments.find((e: { name: string }) => e.name === "production").active.sha;
    const approve = (jobId: number) => reviewer.ctx.post(`${api}/ci/jobs/${jobId}/review`, { data: { approve: true }, headers: headers() });

    // Staging's wait timer from the editor above would hold every run below for 5 minutes.
    expect((await owner.ctx.put(`${api}/environments/staging`, { data: { waitMinutes: 0 }, headers: headers() })).ok()).toBe(true);

    // A newer run approved first deploys, and the older one waiting for approval is superseded rather than
    // put the older commit back later.
    const v5 = await pushMain("v5");
    const v6 = await pushMain("v6");
    expect((await approve(v6.jobs.production.id)).ok()).toBe(true);
    await settled(owner.ctx, api, v6.sha, ["success"]);
    const old = await settled(owner.ctx, api, v5.sha, ["success"]);
    expect(old.jobs.production.status).toBe("skipped");
    expect(old.jobs.production.log).toContain("a newer run of main deploys to production");
    expect((await approve(v5.jobs.production.id)).status()).toBe(409);
    expect(await activeSha()).toBe(v6.sha);

    // Dropping the reviewers lets a deployment that waits for one go ahead.
    const v7 = await pushMain("v7");
    expect(v7.run.status).toBe("waiting");
    expect((await owner.ctx.put(`${api}/environments/production`, { data: { reviewers: [] }, headers: headers() })).ok()).toBe(true);
    expect((await settled(owner.ctx, api, v7.sha, ["success", "failure"])).run.status).toBe("success");
    expect(await activeSha()).toBe(v7.sha);

    // Deleting an environment fails what waits for it instead of leaving it waiting for good.
    await owner.ctx.put(`${api}/environments/production`, { data: { reviewers: [reviewer.username] }, headers: headers() });
    const v8 = await pushMain("v8");
    expect(v8.run.status).toBe("waiting");
    expect((await owner.ctx.delete(`${api}/environments/production`, { headers: headers() })).ok()).toBe(true);
    const gone = await settled(owner.ctx, api, v8.sha, ["success", "failure"]);
    expect(gone.run.status).toBe("failure");
    expect(gone.jobs.production.log).toContain("the environment production was deleted");

    // A refused request doesn't create the environment it names.
    expect((await owner.ctx.put(`${api}/environments/newenv`, { data: { reviewers: ["nobody-here"] }, headers: headers() })).status()).toBe(400);
    const names = (await (await owner.ctx.get(`${api}/environments`)).json()).environments.map((e: { name: string }) => e.name);
    expect(names).not.toContain("newenv");
  } finally {
    await admin.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
