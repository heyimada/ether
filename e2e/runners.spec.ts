import { expect, test, type APIRequestContext } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, git, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });
const runner = (args: string[]) => spawnSync("bun", ["src/runner/main.ts", ...args], { encoding: "utf8" });

const WORKFLOW = `on: push
jobs:
  build:
    steps:
      - name: look around
        shell: bash
        run: |
          echo "checked out: $(cat a.txt)"
          echo "commit $CI_COMMIT_SHA"
          echo "--- git config"; cat .git/config; echo "--- env"; env
`;
const SECRET = `on: push
jobs:
  deploy:
    steps:
      - shell: bash
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        run: echo never
`;
const SLOW = `on: push
jobs:
  slow:
    steps:
      - shell: bash
        run: echo started && sleep 120
`;

type Job = { id: number; name: string; status: string; log: string; runner: string | null };

async function runOf(ctx: APIRequestContext, api: string, sha: string, want: string[]) {
  for (let i = 0; i < 300; i++) {
    const { runs } = await (await ctx.get(`${api}/ci/runs`)).json();
    const run = runs.find((r: { sha: string }) => r.sha === sha);
    if (run && want.includes(run.status)) {
      const { jobs } = await (await ctx.get(`${api}/ci/runs/${run.id}`)).json();
      return { run, jobs: Object.fromEntries((jobs as Job[]).map((j) => [j.name, j])) as Record<string, Job> };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run for ${sha} never became ${want.join(" or ")}`);
}
const FINISHED = ["success", "failure", "cancelled", "error"];

async function removeAllRunners(admin: APIRequestContext) {
  const { runners } = await (await admin.get("/api/admin/runners")).json();
  for (const r of runners) await admin.delete(`/api/admin/runners/${r.id}`, { headers: headers() });
}

test("a runner on another machine registers, runs jobs, reports back and can be stopped", async ({ page }, info) => {
  test.setTimeout(3 * 60_000);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  let proc: ChildProcess | null = null;
  try {
    const owner = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("runner"));
    const api = `/api/repos/${owner.username}/${repo}`;
    const auth = { username: owner.username, token: owner.token };
    expect((await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() })).ok()).toBe(true);

    // An admin adds a runner: the page shows the command to run on the other machine.
    await uiLogin(page, "admin", "admin-password-1");
    await page.goto(`${baseURL()}/site-admin`);
    const section = page.getByRole("region", { name: "Runners" });
    await expect(section).toContainText("Jobs run on this machine until you add a runner");
    await section.getByRole("button", { name: "Add runner" }).click();
    const command = await section.getByLabel("Runner registration command").innerText();
    expect(command).toContain(`--url ${baseURL()}`);
    const token = /--token (\S+)/.exec(command)![1];

    const dir = mkdtempSync(join(tmpdir(), "ether-runner-e2e-"));
    const config = join(dir, "config.json");
    const registered = runner(["register", "--url", baseURL(), "--token", token, "--name", "far-away", "--isolation", "host", "--config", config]);
    expect(registered.status, registered.stderr).toBe(0);
    // The token works once.
    const again = runner(["register", "--url", baseURL(), "--token", token, "--config", join(dir, "other.json")]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("isn't valid");

    proc = spawn("bun", ["src/runner/main.ts", "run", "--config", config], { stdio: "ignore", env: { ...process.env, ETHER_RUNNER_HEARTBEAT_MS: "2000" } });
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("list", { name: "Registered runners" })).toContainText("far-away");
      await expect(page.getByRole("list", { name: "Registered runners" })).toContainText("Online", { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await info.attach("runners", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // A job goes to the runner, which checks out the private repository over HTTP with its job's token.
    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    writeFileSync(join(src, "a.txt"), "from the repository\n");
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), WORKFLOW);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "w"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    let sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const first = await runOf(owner.ctx, api, sha, FINISHED);
    expect(first.run.status, first.jobs.build.log).toBe("success");
    expect(first.jobs.build.runner).toBe("far-away");
    expect(first.jobs.build.log).toContain("checked out: from the repository");
    expect(first.jobs.build.log).toContain(`commit ${sha}`);
    // Neither the checkout nor the step's environment hold the job's token.
    expect(first.jobs.build.log).toContain("--- git config");
    expect(first.jobs.build.log).not.toContain("ethj_");
    expect(first.jobs.build.log).not.toContain("extraHeader");
    expect(first.jobs.build.log).not.toContain("GIT_CONFIG");

    // A runner on its host doesn't get secrets, as with the built-in one.
    expect((await owner.ctx.put(`${api}/ci/secrets/DEPLOY_TOKEN`, { data: { value: "s3cret-value" }, headers: headers() })).ok()).toBe(true);
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), SECRET);
    gitOk(src, ["commit", "-qam", "secret"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const refused = await runOf(owner.ctx, api, sha, FINISHED);
    expect(refused.run.status).toBe("failure");
    expect(refused.jobs.deploy.log).toContain("only passed to jobs that run in containers");
    expect(refused.jobs.deploy.log).toContain("Runner far-away runs jobs on its host");

    // Cancelling reaches the runner, which ends the step.
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), SLOW);
    gitOk(src, ["commit", "-qam", "slow"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const started = await runOf(owner.ctx, api, sha, ["running"]);
    await expect(async () => {
      const { jobs } = await (await owner.ctx.get(`${api}/ci/runs/${started.run.id}`)).json();
      expect(jobs[0].log).toContain("started");
    }).toPass({ timeout: 20_000 });
    expect((await owner.ctx.post(`${api}/ci/runs/${started.run.id}/cancel`, { headers: headers() })).ok()).toBe(true);
    await expect(async () => {
      const { jobs } = await (await owner.ctx.get(`${api}/ci/runs/${started.run.id}`)).json();
      expect(jobs[0].status).toBe("cancelled");
      expect(jobs[0].finishedAt).toBeTruthy();
    }).toPass({ timeout: 20_000 });

    // A runner that dies loses its job once it has been silent for too long.
    gitOk(src, ["commit", "-q", "--allow-empty", "-m", "dies"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const dying = await runOf(owner.ctx, api, sha, ["running"]);
    await expect(async () => {
      const { jobs } = await (await owner.ctx.get(`${api}/ci/runs/${dying.run.id}`)).json();
      expect(jobs[0].log).toContain("started");
    }).toPass({ timeout: 20_000 });
    proc.kill("SIGKILL");
    const lost = await runOf(owner.ctx, api, sha, FINISHED);
    expect(lost.run.status).toBe("failure");
    expect(lost.jobs.slow.log).toContain("Lost contact with runner far-away");

    // While a runner is registered, jobs wait for it rather than land on this machine.
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), WORKFLOW);
    gitOk(src, ["commit", "-qam", "waits"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    await new Promise((r) => setTimeout(r, 3000));
    expect((await runOf(owner.ctx, api, sha, ["queued"])).jobs.build.status).toBe("queued");

    // Removing the last runner brings the built-in one back.
    await page.reload();
    await page.getByRole("button", { name: "Remove runner far-away" }).click();
    await expect(page.getByRole("region", { name: "Runners" })).toContainText("Jobs run on this machine until you add a runner");
    const local = await runOf(owner.ctx, api, sha, FINISHED);
    expect(local.run.status, local.jobs.build.log).toBe("success");
    expect(local.jobs.build.runner).toBeNull();
  } finally {
    proc?.kill("SIGKILL");
    const fresh = await loginAdmin();
    await removeAllRunners(fresh);
    await fresh.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});

test("a job's token opens its own repository, read-only, while the job runs; runners need their own token", async () => {
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  try {
    const owner = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("jobtoken"));
    const other = await createRepo(owner.ctx, unique("jobtoken-other"));
    const api = `/api/repos/${owner.username}/${repo}`;
    const auth = { username: owner.username, token: owner.token };
    await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() });
    const post = (path: string, token: string | null, data: unknown) =>
      fetch(`${baseURL()}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });

    // Only admins hand out registration tokens, and bad ones get nowhere.
    expect((await owner.ctx.post("/api/admin/runners/registration", { headers: headers() })).status()).toBe(403);
    expect((await owner.ctx.get("/api/admin/runners")).status()).toBe(403);
    expect((await post("/runner/register", null, { token: "nope", name: "x", isolation: "host" })).status).toBe(401);
    expect((await post("/runner/claim", "nope", { isolation: "host" })).status).toBe(401);

    const { token: registration } = await (await admin.post("/api/admin/runners/registration", { headers: headers() })).json();
    expect((await post("/runner/register", null, { token: registration, name: "bad name!", isolation: "host" })).status).toBe(400);
    const { token: runnerToken } = await (await post("/runner/register", null, { token: registration, name: "by-hand", isolation: "host" })).json();
    expect(runnerToken).toBeTruthy();
    expect((await post("/runner/claim", runnerToken, { isolation: "host" })).status).toBe(204);

    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), WORKFLOW);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "w"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, other), "main"], auth);

    let claimed: Response | null = null;
    await expect(async () => {
      claimed = await post("/runner/claim", runnerToken, { isolation: "host" });
      expect(claimed.status).toBe(200);
    }).toPass({ timeout: 10_000 });
    const { assignment, token } = await claimed!.json();
    expect(assignment.checkout.url).toBe(`/${owner.username}/${repo}.git`);
    const jobAuth = { username: "ether-job", token };

    // Its own repository, for reading.
    const into = () => join(workdir(), "clone");
    expect(git(workdir(), ["clone", "-q", cloneUrl(owner.username, repo), into()], jobAuth).code).toBe(0);
    expect(git(workdir(), ["clone", "-q", cloneUrl(owner.username, other), into()], jobAuth).code).not.toBe(0);
    expect(git(src, ["push", "-q", cloneUrl(owner.username, repo), "main:refs/heads/from-job"], jobAuth).code).not.toBe(0);
    // Not the API, and not another job's reports.
    expect((await fetch(`${baseURL()}${api}`, { headers: { Authorization: `Bearer ${token}` } })).status).not.toBe(200);
    expect((await post(`/runner/jobs/${assignment.jobId + 1000}/report`, token, { text: "x" })).status).toBe(404);
    expect((await post(`/runner/jobs/${assignment.jobId}/report`, runnerToken, { text: "x" })).status).toBe(404);

    // The log comes through what the runner reports, and the result ends the job and its token.
    const progress = await post(`/runner/jobs/${assignment.jobId}/report`, token, { text: "hello from far away\n" });
    expect(await progress.json()).toEqual({ stop: false });
    expect((await post(`/runner/jobs/${assignment.jobId}/finish`, token, { result: "nonsense" })).status).toBe(400);
    expect((await post(`/runner/jobs/${assignment.jobId}/finish`, token, { result: "success" })).ok).toBe(true);
    const done = await runOf(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim(), FINISHED);
    expect(done.run.status).toBe("success");
    expect(done.jobs.build.log).toContain("hello from far away");
    expect(done.jobs.build.runner).toBe("by-hand");
    expect((await post(`/runner/jobs/${assignment.jobId}/report`, token, { text: "late" })).status).toBe(404);
    expect(git(workdir(), ["clone", "-q", cloneUrl(owner.username, repo), into()], jobAuth).code).not.toBe(0);

    // A runner with containers gets the job's secrets, and what it reports is masked here as well.
    expect((await owner.ctx.put(`${api}/ci/secrets/DEPLOY_TOKEN`, { data: { value: "s3cret-value" }, headers: headers() })).ok()).toBe(true);
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), SECRET);
    gitOk(src, ["commit", "-qam", "secret"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    await expect(async () => {
      claimed = await post("/runner/claim", runnerToken, { isolation: "container" });
      expect(claimed.status).toBe(200);
    }).toPass({ timeout: 10_000 });
    const withSecret = await claimed!.json();
    expect(withSecret.assignment.isolation).toBe("container");
    expect(withSecret.assignment.steps[0].env.TOKEN).toBe("s3cret-value");
    expect(withSecret.assignment.mask).toEqual(["s3cret-value"]);
    await post(`/runner/jobs/${withSecret.assignment.jobId}/report`, withSecret.token, { text: "oops s3cret-" });
    await post(`/runner/jobs/${withSecret.assignment.jobId}/report`, withSecret.token, { text: "value leaked\n" });
    await post(`/runner/jobs/${withSecret.assignment.jobId}/finish`, withSecret.token, { result: "success" });
    const masked = await runOf(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim(), FINISHED);
    expect(masked.jobs.deploy.log).toContain("oops *** leaked");
  } finally {
    const fresh = await loginAdmin();
    await removeAllRunners(fresh);
    await fresh.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
