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

async function removeAllServerWide(admin: APIRequestContext) {
  const { runners } = await (await admin.get("/api/admin/runners")).json();
  for (const r of runners) if (r.scope === "server") await admin.delete(`/api/admin/runners/${r.id}`, { headers: headers() });
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

    proc = spawn("bun", ["src/runner/main.ts", "run", "--config", config], { stdio: "ignore" });
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
    expect((await post("/runner/claim", "nope", {})).status).toBe(401);

    const { token: registration } = await (await admin.post("/api/admin/runners/registration", { headers: headers() })).json();
    expect((await post("/runner/register", null, { token: registration, name: "bad name!", isolation: "host" })).status).toBe(400);
    const { token: runnerToken } = await (await post("/runner/register", null, { token: registration, name: "by-hand", isolation: "host" })).json();
    expect(runnerToken).toBeTruthy();
    expect((await post("/runner/claim", runnerToken, {})).status).toBe(204);

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
      claimed = await post("/runner/claim", runnerToken, {});
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
    const { token: secondRegistration } = await (await admin.post("/api/admin/runners/registration", { headers: headers() })).json();
    const { token: containerToken } = await (await post("/runner/register", null, { token: secondRegistration, name: "in-containers", isolation: "container" })).json();
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), SECRET);
    gitOk(src, ["commit", "-qam", "secret"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    // A runner on its host leaves a job with secrets to the one with containers, whoever asks first.
    await runOf(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim(), ["queued"]);
    expect((await post("/runner/claim", runnerToken, {})).status).toBe(204);
    // Saying it has containers doesn't make it so: a host runner's token is within reach of the jobs it runs.
    expect((await post("/runner/claim", runnerToken, { isolation: "container" })).status).toBe(204);
    await expect(async () => {
      claimed = await post("/runner/claim", containerToken, {});
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

    // A runner shutting down doesn't cancel the run: the job didn't finish, so the check mustn't pass.
    gitOk(src, ["commit", "-q", "--allow-empty", "-m", "runner stops"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    await expect(async () => {
      claimed = await post("/runner/claim", containerToken, {});
      expect(claimed.status).toBe(200);
    }).toPass({ timeout: 10_000 });
    const stopping = await claimed!.json();
    await post(`/runner/jobs/${stopping.assignment.jobId}/finish`, stopping.token, { result: "cancelled" });
    const unfinished = await runOf(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim(), FINISHED);
    expect(unfinished.run.status).toBe("failure");
    expect(unfinished.jobs.deploy.status).toBe("failure");
    expect(unfinished.jobs.deploy.log).toContain("Runner in-containers stopped before this job finished");
  } finally {
    const fresh = await loginAdmin();
    await removeAllRunners(fresh);
    await fresh.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});

test("a runner that gets removed ends what it runs before it exits", async () => {
  test.setTimeout(2 * 60_000);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  let proc: ChildProcess | null = null;
  try {
    const owner = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("removed"));
    const api = `/api/repos/${owner.username}/${repo}`;
    await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() });
    const { token } = await (await admin.post("/api/admin/runners/registration", { headers: headers() })).json();
    const config = join(mkdtempSync(join(tmpdir(), "ether-runner-e2e-")), "config.json");
    expect(runner(["register", "--url", baseURL(), "--token", token, "--name", "goes-away", "--isolation", "host", "--config", config]).status).toBe(0);
    // Two slots: the idle one is the first to hear the runner is gone.
    const started = spawn("bun", ["src/runner/main.ts", "run", "--jobs", "2", "--config", config], { stdio: "ignore" });
    proc = started;
    const exited = new Promise<number | null>((resolve) => started.on("exit", resolve));

    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), `on: push\njobs:\n  long:\n    steps:\n      - shell: bash\n        run: sleep 120 & echo "pid=$!"; wait\n`);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "w"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], { username: owner.username, token: owner.token });
    const { run } = await runOf(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim(), ["running"]);
    let pid = 0;
    await expect(async () => {
      const { jobs } = await (await owner.ctx.get(`${api}/ci/runs/${run.id}`)).json();
      pid = Number(/pid=(\d+)/.exec(jobs[0].log)?.[1]);
      expect(pid).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });

    await removeAllRunners(admin);
    expect(await exited).toBe(1);
    expect(() => process.kill(pid, 0)).toThrow();
    const { jobs } = await (await owner.ctx.get(`${api}/ci/runs/${run.id}`)).json();
    expect(jobs[0].log).toContain("Runner goes-away was removed");
  } finally {
    proc?.kill("SIGKILL");
    const fresh = await loginAdmin();
    await removeAllRunners(fresh);
    await fresh.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});

test("runs-on, an environment's labels and a runner's scope decide who takes a job", async ({ page }, info) => {
  test.setTimeout(2 * 60_000);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  try {
    const owner = await createUser(admin);
    const outsider = await createUser(admin);
    const own = await createRepo(owner.ctx, unique("scoped"));
    const plain = await createRepo(owner.ctx, unique("plain"));
    const ownApi = `/api/repos/${owner.username}/${own}`;
    const plainApi = `/api/repos/${owner.username}/${plain}`;
    const auth = { username: owner.username, token: owner.token };
    for (const api of [ownApi, plainApi]) await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() });

    const post = (path: string, token: string | null, data: unknown = {}) =>
      fetch(`${baseURL()}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
    const register = async (ctx: APIRequestContext, path: string, name: string, labels: string[]) => {
      const { token } = await (await ctx.post(`${path}/runners/registration`, { headers: headers() })).json();
      return (await (await post("/runner/register", null, { token, name, isolation: "container", labels })).json()).token as string;
    };
    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    let n = 0;
    const push = (repo: string, job: string, namespace = owner.username) => {
      writeFileSync(join(src, ".ether", "workflows", "w.yml"), `on: push\njobs:\n  job:\n${job}    steps:\n      - run: echo ${n++}\n`);
      gitOk(src, ["add", "-A"]);
      gitOk(src, ["commit", "-q", "-m", `w${n}`]);
      gitOk(src, ["push", "-q", "--force", cloneUrl(namespace, repo), "main"], auth);
      return gitOk(src, ["rev-parse", "HEAD"]).trim();
    };
    const claim = (token: string) => post("/runner/claim", token);
    // The runner that should get the job takes it and finishes it; the others are offered nothing.
    const onlyFor = async (winner: string, losers: string[], api: string, sha: string) => {
      await runOf(owner.ctx, api, sha, ["queued"]);
      for (const loser of losers) expect((await claim(loser)).status).toBe(204);
      const res = await claim(winner);
      expect(res.status).toBe(200);
      const { assignment, token } = await res.json();
      expect(assignment.checkout.sha).toBe(sha);
      await post(`/runner/jobs/${assignment.jobId}/finish`, token, { result: "success" });
      await runOf(owner.ctx, api, sha, FINISHED);
    };

    // Who may add runners where.
    await owner.ctx.put(`${ownApi}/collaborators/${outsider.username}`, { data: { role: "write" }, headers: headers() });
    expect((await outsider.ctx.post(`${ownApi}/runners/registration`, { headers: headers() })).status()).toBe(403);
    expect((await outsider.ctx.get(`${ownApi}/runners`)).status()).toBe(403);
    const org = unique("runnerorg").toLowerCase();
    expect((await owner.ctx.post("/api/orgs", { data: { name: org }, headers: headers() })).ok()).toBe(true);
    const orgRepo = unique("inorg");
    expect((await owner.ctx.post("/api/repos", { data: { name: orgRepo, owner: org }, headers: headers() })).ok()).toBe(true);
    const orgApi = `/api/repos/${org}/${orgRepo}`;
    await owner.ctx.patch(orgApi, { data: { ciEnabled: true }, headers: headers() });
    expect((await outsider.ctx.post(`/api/orgs/${org}/runners/registration`, { headers: headers() })).status()).toBe(403);

    const server = await register(admin, "/api/admin", "server-wide", ["linux"]);
    const repoOnly = await register(owner.ctx, ownApi, "repo-only", ["gpu"]);
    const listed = await (await owner.ctx.get(`${ownApi}/runners`)).json();
    expect(listed.runners.map((r: { name: string }) => r.name)).toEqual(["repo-only"]);
    const everyone = await (await admin.get("/api/admin/runners")).json();
    expect(everyone.runners.find((r: { name: string }) => r.name === "repo-only")).toMatchObject({ scope: "repository", labels: ["gpu"] });
    // An owner can't touch a runner outside their scope.
    const serverId = everyone.runners.find((r: { name: string }) => r.name === "server-wide").id;
    expect((await owner.ctx.delete(`${ownApi}/runners/${serverId}`, { headers: headers() })).status()).toBe(404);

    // A repository's runner stays with its repository, and labels pick among those that can.
    await onlyFor(server, [repoOnly], plainApi, push(plain, ""));
    await onlyFor(server, [repoOnly], plainApi, push(plain, "    runs-on: linux\n"));
    await onlyFor(repoOnly, [server], ownApi, push(own, "    runs-on: gpu\n"));
    // So does an organization's, across its repositories.
    const orgOnly = await register(owner.ctx, `/api/orgs/${org}`, "org-only", ["fast"]);
    await onlyFor(orgOnly, [server, repoOnly], orgApi, push(orgRepo, "    runs-on: fast\n", org));
    expect((await claim(orgOnly)).status).toBe(204);
    await onlyFor(server, [orgOnly, repoOnly], plainApi, push(plain, ""));

    // Nobody has these labels: the job waits and says why.
    const stuck = push(plain, "    runs-on: [linux, gpu]\n");
    const waiting = await runOf(owner.ctx, plainApi, stuck, ["queued"]);
    const { jobs } = await (await owner.ctx.get(`${plainApi}/ci/runs/${waiting.run.id}`)).json();
    expect(jobs[0].runnerProblem).toBe("none");
    expect((await claim(server)).status).toBe(204);
    await owner.ctx.post(`${plainApi}/ci/runs/${waiting.run.id}/cancel`, { headers: headers() });

    // An environment's labels hold whatever the workflow says.
    expect((await owner.ctx.put(`${plainApi}/environments/production`, { data: { runners: ["secure"] }, headers: headers() })).ok()).toBe(true);
    expect((await owner.ctx.put(`${plainApi}/environments/production`, { data: { runners: ["not valid"] }, headers: headers() })).status()).toBe(400);
    await uiLogin(page, owner.username, owner.password);
    await page.goto(`${baseURL()}/${owner.username}/${own}/settings`);
    const section = page.getByRole("region", { name: "Runners" });
    await expect(section.getByRole("list", { name: "Registered runners" })).toContainText("repo-only");
    await expect(section.getByRole("list", { name: "Registered runners" })).toContainText("gpu");
    await expect(section.getByRole("list", { name: "Registered runners" })).not.toContainText("server-wide");
    await info.attach("repo-runners", { body: await section.screenshot(), contentType: "image/png" });
    await page.goto(`${baseURL()}/${owner.username}/${plain}/settings`);
    await expect(page.getByRole("listitem", { name: "Environment production" })).toContainText("on runners with secure");
    const deploy = push(plain, "    environment: production\n    runs-on: linux\n");
    await runOf(owner.ctx, plainApi, deploy, ["queued"]);
    expect((await claim(server)).status).toBe(204);
    const secure = await register(admin, "/api/admin", "secure-one", ["linux", "secure"]);
    await onlyFor(secure, [server, repoOnly, orgOnly], plainApi, deploy);

    // Without a server-wide runner the built-in one is back for the rest, while the repository keeps its own.
    await removeAllServerWide(admin);
    const local = await runOf(owner.ctx, plainApi, push(plain, ""), FINISHED);
    expect(local.jobs.job.runner).toBeNull();
    const held = push(own, "");
    await new Promise((r) => setTimeout(r, 1500));
    await runOf(owner.ctx, ownApi, held, ["queued"]);
    await onlyFor(repoOnly, [], ownApi, held);

    // The run shows all a job waits for, its environment's labels too; clearing those lets the built-in one take it.
    const gated = push(plain, "    environment: production\n");
    const gatedRun = await runOf(owner.ctx, plainApi, gated, ["queued"]);
    const gatedJobs = (await (await owner.ctx.get(`${plainApi}/ci/runs/${gatedRun.run.id}`)).json()).jobs;
    expect(gatedJobs[0].runsOn).toEqual(["secure"]);
    expect(gatedJobs[0].runnerProblem).toBe("none");
    await page.goto(`${baseURL()}/${owner.username}/${plain}/ci/${gatedRun.run.id}`);
    await expect(page.getByRole("region", { name: "Job job" })).toContainText("Waiting for a runner with secure: none that can take this job is registered.");
    expect((await owner.ctx.put(`${plainApi}/environments/production`, { data: { runners: [] }, headers: headers() })).ok()).toBe(true);
    expect((await runOf(owner.ctx, plainApi, gated, FINISHED)).jobs.job.runner).toBeNull();

    // Deleting a repository takes its runners along.
    expect((await owner.ctx.delete(ownApi, { headers: headers() })).ok()).toBe(true);
    expect((await claim(repoOnly)).status).toBe(401);
  } finally {
    const fresh = await loginAdmin();
    await removeAllRunners(fresh);
    await fresh.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});

test("the built program runs a job in a container, with its secret masked", async () => {
  const runtime = ["docker", "podman"].find((cli) => spawnSync(cli, ["version"], { stdio: "ignore" }).status === 0);
  test.skip(!runtime, "needs Docker or Podman on this machine");
  test.setTimeout(10 * 60_000);
  const dir = mkdtempSync(join(tmpdir(), "ether-runner-built-"));
  const binary = join(dir, "ether-runner");
  const built = spawnSync("bun", ["build", "--compile", "src/runner/main.ts", "--outfile", binary], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true }, headers: headers() });
  let proc: ChildProcess | null = null;
  try {
    const owner = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("built"));
    const api = `/api/repos/${owner.username}/${repo}`;
    await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() });
    await owner.ctx.put(`${api}/ci/secrets/DEPLOY_TOKEN`, { data: { value: "s3cret-value" }, headers: headers() });
    const { token } = await (await admin.post("/api/admin/runners/registration", { headers: headers() })).json();
    const config = join(dir, "config.json");
    const registered = spawnSync(binary, ["register", "--url", baseURL(), "--token", token, "--name", "built", "--config", config], { encoding: "utf8" });
    expect(registered.status, registered.stderr).toBe(0);
    proc = spawn(binary, ["run", "--config", config], { stdio: "ignore" });

    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    writeFileSync(join(src, "a.txt"), "from the repository\n");
    writeFileSync(join(src, ".ether", "workflows", "w.yml"), `on: push\njobs:\n  build:\n    steps:\n      - shell: sh\n        env:\n          TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n        run: cat a.txt; pwd; echo "token=$TOKEN"\n`);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "w"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], { username: owner.username, token: owner.token });
    const { run, jobs } = await runOf(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim(), FINISHED);
    expect(run.status, jobs.build.log).toBe("success");
    expect(jobs.build.runner).toBe("built");
    expect(jobs.build.log).toContain("from the repository");
    expect(jobs.build.log).toContain("/workspace");
    expect(jobs.build.log).toContain("token=***");
    expect(jobs.build.log).not.toContain("s3cret-value");
  } finally {
    proc?.kill("SIGTERM");
    const fresh = await loginAdmin();
    await removeAllRunners(fresh);
    await fresh.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
