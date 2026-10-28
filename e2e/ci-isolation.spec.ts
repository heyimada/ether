import { expect, test, type APIRequestContext } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

// The container runtime the server would find, if any.
const runtime = ["docker", "podman"].find((cli) => spawnSync(cli, ["version"], { stdio: "ignore" }).status === 0) ?? null;

async function waitForRun(ctx: APIRequestContext, api: string, sha: string) {
  for (let i = 0; i < 900; i++) {
    const { runs } = await (await ctx.get(`${api}/ci/runs`)).json();
    const run = runs.find((r: { sha: string }) => r.sha === sha);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("CI run did not finish");
}

const jobLogs = async (ctx: APIRequestContext, api: string, runId: number) =>
  Object.fromEntries(((await (await ctx.get(`${api}/ci/runs/${runId}`)).json()).jobs as { name: string; status: string; log: string }[]).map((j) => [j.name, j]));

const DEPLOY_KEY = "-----BEGIN TEST KEY-----\nQUFBQUJCQkJDQ0NDREREREVFRUU=\n-----END TEST KEY-----";
const TOKEN = "tok-9f8e7d6c5b4a";

test("owners manage CI secrets that can't be read back; writers and readers can't see them", async ({ page }) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const writer = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("secrets"));
  const api = `/api/repos/${owner.username}/${repo}`;
  await owner.ctx.put(`${api}/collaborators/${writer.username}`, { data: { role: "write" }, headers: headers() });

  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}/settings`);
  await page.getByLabel("Secret name").fill("deploy_key");
  await expect(page.getByLabel("Secret name")).toHaveValue("DEPLOY_KEY");
  await page.getByLabel("Secret value").fill(DEPLOY_KEY);
  await page.getByRole("button", { name: "Save secret" }).click();
  const list = page.getByRole("list", { name: "CI secrets" });
  await expect(list).toContainText("DEPLOY_KEY");
  await expect(list).toContainText(`by ${owner.username}`);
  await expect(page.locator("body")).not.toContainText("QUFBQUJCQkJDQ0NDREREREVFRUU=");

  const listed = await (await owner.ctx.get(`${api}/ci/secrets`)).json();
  expect(JSON.stringify(listed)).not.toContain("QUFBQUJC");
  expect(listed.secrets.map((s: { name: string }) => s.name)).toEqual(["DEPLOY_KEY"]);
  expect((await writer.ctx.get(`${api}/ci/secrets`)).status()).toBe(403);
  expect((await writer.ctx.put(`${api}/ci/secrets/STOLEN`, { data: { value: "x" }, headers: headers() })).status()).toBe(403);
  expect((await owner.ctx.put(`${api}/ci/secrets/lower`, { data: { value: "x" }, headers: headers() })).status()).toBe(400);
  expect((await owner.ctx.put(`${api}/ci/secrets/CI_TOKEN`, { data: { value: "x" }, headers: headers() })).status()).toBe(400);
  expect((await owner.ctx.put(`${api}/ci/secrets/EMPTY`, { data: { value: "" }, headers: headers() })).status()).toBe(400);
  expect((await owner.ctx.delete(`${api}/ci/secrets/NOPE`, { headers: headers() })).status()).toBe(404);

  await page.getByRole("button", { name: "Remove DEPLOY_KEY" }).click();
  await expect(page.getByRole("list", { name: "CI secrets" })).toHaveCount(0);
});

// A repository with both secrets and a workflow that checks isolation, pushed with CI turned on as `isolation`.
async function pushIsolationWorkflow(isolation: "container" | "host") {
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: isolation }, headers: headers() });
  const owner = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("isolated"));
  const api = `/api/repos/${owner.username}/${repo}`;
  for (const [name, value] of [["DEPLOY_KEY", DEPLOY_KEY], ["TOKEN", TOKEN]])
    expect((await owner.ctx.put(`${api}/ci/secrets/${name}`, { data: { value }, headers: headers() })).ok()).toBe(true);
  expect((await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() })).ok()).toBe(true);

  const hostDb = join(process.env.ETHER_DATA!, "ether.db");
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "README.md"), "# isolated\n");
  mkdirSync(join(src, ".ether"));
  writeFileSync(
    join(src, ".ether", "ci.yml"),
    `jobs:
  build:
    image: alpine:3.20
    env:
      TOKEN: \${{ secrets.TOKEN }}
      DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}
      HOST_DB: "${hostDb}"
      # Only for the job: the host's container CLI must not pick it up, or it would talk to another daemon.
      DOCKER_HOST: tcp://127.0.0.1:9
    steps:
      - name: Checkout is here
        run: test -f README.md && test "$CI_REPOSITORY" = "${owner.username}/${repo}" && echo "checkout ok"
      - name: Host files are not
        run: test ! -e "$HOST_DB" && test -z "$ETHER_DATA" && echo "host hidden"
      - name: Job variables stay in the job
        run: test "$DOCKER_HOST" = "tcp://127.0.0.1:9" && test ! -e /tmp/.ether-step-env && echo "env contained"
      - name: Secrets arrive and are masked
        run: |
          test "$TOKEN" = "${TOKEN}"
          echo "token is $TOKEN"
          printf '%s\\n' "$DEPLOY_KEY" | wc -l | tr -d ' ' | sed 's/^/key lines: /'
          echo "$DEPLOY_KEY"
  nonroot:
    # Runs as user 101: the checkout has to be theirs, and variables can't depend on root-owned files.
    image: nginxinc/nginx-unprivileged:1.27-alpine
    env:
      TOKEN: \${{ secrets.TOKEN }}
    steps:
      - name: Not root, but the checkout is writable and variables arrive
        run: test "$(id -u)" != 0 && touch README.md written-by-step && test "$TOKEN" = "${TOKEN}" && echo "non-root ok"
  missing:
    image: alpine:3.20
    steps:
      - run: echo never
        env:
          X: \${{ secrets.NOT_SET }}
`,
  );
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "isolated ci"]);
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], { username: owner.username, token: owner.token });
  const run = await waitForRun(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim());
  return { admin, run, jobs: await jobLogs(owner.ctx, api, run.id) };
}

test("on the host, jobs that use secrets are refused before anything runs", async () => {
  const { admin, jobs } = await pushIsolationWorkflow("host");
  try {
    expect(jobs.build.status).toBe("failure");
    expect(jobs.build.log).toContain("only passed to jobs that run in containers");
    expect(jobs.build.log).not.toContain("checkout ok");
  } finally {
    await admin.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});

test("in a container, a job gets its checkout and secrets (masked in the log) but none of the host's files", async () => {
  test.skip(!runtime, "needs Docker or Podman on this machine");
  test.setTimeout(10 * 60_000);
  const { admin, run, jobs } = await pushIsolationWorkflow("container");
  try {
    expect(run.status).toBe("failure");
    expect(jobs.build.status, jobs.build.log).toBe("success");
    expect(jobs.build.log).toContain(`Starting alpine:3.20 with ${runtime}`);
    expect(jobs.build.log).toContain("checkout ok");
    expect(jobs.build.log).toContain("host hidden");
    expect(jobs.build.log).toContain("env contained");
    expect(jobs.build.log).toContain("token is ***");
    expect(jobs.build.log).toContain("key lines: 3");
    expect(jobs.build.log).not.toContain(TOKEN);
    expect(jobs.build.log).not.toContain("QUFBQUJCQkJDQ0NDREREREVFRUU=");
    expect(jobs.nonroot.status, jobs.nonroot.log).toBe("success");
    expect(jobs.nonroot.log).toContain("non-root ok");
    expect(jobs.missing.status).toBe("failure");
    expect(jobs.missing.log).toContain("The secret NOT_SET isn't set");
    // Every job's container is gone afterwards.
    expect(spawnSync(runtime!, ["ps", "--all", "--quiet", "--filter", "label=ether.ci=1"], { encoding: "utf8" }).stdout.trim()).toBe("");
  } finally {
    await admin.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
