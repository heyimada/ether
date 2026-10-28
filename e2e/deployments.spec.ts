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
  throw new Error(`run for ${sha} didn't settle`);
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

    // A pull request from a feature branch: staging takes it, production refuses the branch outright.
    gitOk(src, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(src, "app.txt"), "v2\n");
    gitOk(src, ["commit", "-qam", "v2"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "feature"], auth);
    const v2 = gitOk(src, ["rev-parse", "HEAD"]).trim();
    ({ run, jobs } = await settled(owner.ctx, api, v2, ["success", "failure"]));
    expect(run.status).toBe("failure");
    expect(jobs.staging.status).toBe("success");
    expect(jobs.production.status).toBe("failure");
    expect(jobs.production.log).toContain("feature isn't allowed to deploy here");
    expect(jobs.production.deployment!.status).toBe("rejected");
    const { pull } = await (await owner.ctx.post(`${api}/pulls`, { data: { title: "v2", body: "", base: "main", head: "feature" }, headers: headers() })).json();
    await page.goto(`${baseURL()}/${owner.username}/${repo}/pull/${pull.number}`);
    await expect(page.getByRole("link", { name: "Deployed to staging" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Deployed to production" })).toHaveCount(0);

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
    expect(deployments.map((d: { status: string }) => d.status)).toEqual(["cancelled", "rejected", "rejected", "success"]);

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
  } finally {
    await admin.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
