import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

const WORKFLOW = `jobs:
  build:
    steps:
      - name: Say hello
        shell: bash
        run: echo "hello from $(basename "$PWD")" && test -f README.md
      - name: Secrets stay out
        shell: bash
        run: test -z "$BETTER_AUTH_SECRET" && test -z "$ETHER_DATA" && echo "clean environment"
  lint:
    steps:
      - name: Fails on purpose
        shell: bash
        run: echo "about to fail" && exit 3
`;

async function waitForRun(ctx: APIRequestContext, api: string, sha: string) {
  for (let i = 0; i < 150; i++) {
    const { runs } = await (await ctx.get(`${api}/ci/runs`)).json();
    const run = runs.find((r: { sha: string }) => r.sha === sha);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("CI run did not finish");
}

test("CI runs workflows on push when enabled, shows logs, and gates merges on checks", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("ci"));
  const api = `/api/repos/${owner.username}/${repo}`;
  const auth = { username: owner.username, token: owner.token };

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "README.md"), "# CI\n");
  mkdirSync(join(src, ".ether"));
  writeFileSync(join(src, ".ether", "ci.yml"), WORKFLOW);
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "with ci"]);

  // Nothing runs until both the server and the repository allow it.
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
  await new Promise((r) => setTimeout(r, 1000));
  expect((await (await owner.ctx.get(`${api}/ci/runs`)).json()).runs).toEqual([]);
  expect((await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() })).status()).toBe(400);

  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/site-admin`);
  await page.getByRole("checkbox", { name: /Run CI jobs/ }).check();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  // This test covers jobs on the host; e2e/ci-isolation.spec.ts covers containers.
  await page.getByRole("radio", { name: /On this machine, as the user Ether runs as/ }).check();
  await expect(page.getByRole("radio", { name: /On this machine/ })).toBeChecked();
  try {
    expect((await owner.ctx.patch(api, { data: { ciEnabled: true, requireChecks: true }, headers: headers() })).ok()).toBe(true);

    // A push now starts a run: one job passes, one fails.
    writeFileSync(join(src, "README.md"), "# CI\n\nsecond\n");
    gitOk(src, ["commit", "-qam", "trigger"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    const sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const run = await waitForRun(owner.ctx, api, sha);
    expect(run.status).toBe("failure");

    await page.context().clearCookies();
    await uiLogin(page, owner.username, owner.password);
    // The person whose push failed hears about it on their dashboard.
    const failed = page.getByRole("region", { name: "Feed" }).getByRole("listitem").filter({ hasText: /Checks failed/ }).first();
    await expect(failed).toContainText(`${owner.username}/${repo}`);
    await expect(failed.getByRole("link", { name: "trigger" })).toBeVisible();
    await page.goto(`${baseURL()}/${owner.username}/${repo}`);
    await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "CI" }).click();
    await page.getByRole("list", { name: "CI runs" }).getByRole("link", { name: "trigger" }).click();
    const build = page.getByRole("region", { name: "Job build" });
    const lint = page.getByRole("region", { name: "Job lint" });
    await expect(build).toContainText("Passed");
    await expect(build.getByRole("log").first()).toContainText("hello from");
    await expect(build).toContainText("clean environment");
    await expect(lint).toContainText("Failed");
    await expect(lint.getByRole("log").first()).toContainText("about to fail");
    await info.attach("ci-run", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // Pull requests show the head's checks; failing checks block the merge when required.
    gitOk(src, ["checkout", "-q", "-b", "fix"]);
    writeFileSync(join(src, ".ether", "ci.yml"), WORKFLOW.replace('echo "about to fail" && exit 3', 'echo "fixed"'));
    gitOk(src, ["commit", "-qam", "fix lint"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "fix"], auth);
    const fixSha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const { pull } = await (await owner.ctx.post(`${api}/pulls`, { data: { title: "Fix lint", body: "", base: "main", head: "fix" }, headers: headers() })).json();
    expect((await waitForRun(owner.ctx, api, fixSha)).status).toBe("success");
    await page.goto(`${baseURL()}/${owner.username}/${repo}/pull/${pull.number}`);
    await expect(page.getByText("All checks have passed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Merge pull request" })).toBeEnabled();

    gitOk(src, ["checkout", "-q", "-b", "broken"]);
    writeFileSync(join(src, ".ether", "ci.yml"), WORKFLOW);
    gitOk(src, ["commit", "-qam", "break it"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "broken"], auth);
    const badSha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const bad = await (await owner.ctx.post(`${api}/pulls`, { data: { title: "Break", body: "", base: "main", head: "broken" }, headers: headers() })).json();
    await waitForRun(owner.ctx, api, badSha);
    await page.goto(`${baseURL()}/${owner.username}/${repo}/pull/${bad.pull.number}`);
    await expect(page.getByText("Some checks failed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Merge pull request" })).toBeDisabled();
    expect((await owner.ctx.post(`${api}/pulls/${bad.pull.number}/merge`, { data: {}, headers: headers() })).status()).toBe(409);
  } finally {
    const adminCtx = await loginAdmin();
    await adminCtx.put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
  // Readers can't re-run anything.
  const reader = await createUser(admin);
  await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });
  const { runs } = await (await owner.ctx.get(`${api}/ci/runs`)).json();
  expect((await reader.ctx.post(`${api}/ci/runs/${runs[0].id}/rerun`, { headers: headers() })).status()).toBe(403);
  // Failed checks are news for whoever pushed, not for everyone who can read the repository.
  const theirs = (await (await reader.ctx.get("/api/feed")).json()).events as { kind: string; repo: string }[];
  expect(theirs.filter((e) => e.repo === repo).map((e) => e.kind)).not.toContain("ci_failed");
});
