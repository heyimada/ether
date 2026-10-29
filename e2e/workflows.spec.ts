import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

const FILES: Record<string, string> = {
  "test.yml": `name: Tests
on:
  push:
    branches: [main]
    paths-ignore: ["docs/**"]
jobs:
  unit:
    steps:
      - shell: bash
        run: echo "event=$CI_EVENT workflow=$CI_WORKFLOW ref=$CI_REF"
`,
  "pr.yml": `name: PR checks
on:
  pull_request:
    branches: [main]
jobs:
  check:
    steps:
      - shell: bash
        run: echo "pull=$CI_PULL_REQUEST base=$CI_BASE_REF head=$CI_REF"
`,
  "release.yml": `name: Release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    steps:
      - shell: bash
        run: echo "releasing $CI_REF_TYPE $CI_REF"
`,
  "manual.yml": `name: Manual
on:
  workflow_dispatch:
    inputs:
      target:
        type: choice
        options: [staging, production]
      dry-run:
        type: boolean
        description: Only pretend
      note:
        description: Why
        required: true
jobs:
  go:
    steps:
      - shell: bash
        run: echo "target=$CI_INPUT_TARGET dry=$CI_INPUT_DRY_RUN note=$CI_INPUT_NOTE"
`,
};

type Run = { id: number; sha: string; workflowName: string; event: string; status: string; pullNumber: number | null; ref: string; message: string };

const runsOf = async (ctx: APIRequestContext, api: string): Promise<Run[]> => (await (await ctx.get(`${api}/ci/runs`)).json()).runs;

// Every run for a commit, once none of them is still going.
async function finished(ctx: APIRequestContext, api: string, sha: string, count: number) {
  for (let i = 0; i < 300; i++) {
    const runs = (await runsOf(ctx, api)).filter((r) => r.sha === sha);
    if (runs.length >= count && runs.every((r) => !["queued", "running"].includes(r.status))) return runs;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`runs for ${sha} didn't finish: ${JSON.stringify((await runsOf(ctx, api)).map((r) => [r.sha.slice(0, 7), r.workflowName, r.status]))}`);
}

const log = async (ctx: APIRequestContext, api: string, id: number) => ((await (await ctx.get(`${api}/ci/runs/${id}`)).json()).jobs as { log: string }[]).map((j) => j.log).join("\n");

test("workflows in .ether/workflows run on the events their on: names", async ({ page }, info) => {
  test.setTimeout(3 * 60_000);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  try {
    const owner = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("wf"));
    const api = `/api/repos/${owner.username}/${repo}`;
    const auth = { username: owner.username, token: owner.token };
    expect((await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() })).ok()).toBe(true);
    const remote = cloneUrl(owner.username, repo);

    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    mkdirSync(join(src, "docs"));
    for (const [name, text] of Object.entries(FILES)) writeFileSync(join(src, ".ether", "workflows", name), text);
    writeFileSync(join(src, "app.txt"), "v1\n");
    writeFileSync(join(src, "docs", "guide.md"), "# Guide\n");
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "workflows"]);
    gitOk(src, ["push", "-q", remote, "main"], auth);
    const v1 = gitOk(src, ["rev-parse", "HEAD"]).trim();

    // A push to main runs only the workflow that asks for it.
    const first = await finished(owner.ctx, api, v1, 1);
    expect(first.map((r) => [r.workflowName, r.event, r.status])).toEqual([["Tests", "push", "success"]]);
    expect(await log(owner.ctx, api, first[0].id)).toContain("event=push workflow=Tests ref=main");

    // A change only under docs/ is ignored by its paths-ignore.
    writeFileSync(join(src, "docs", "guide.md"), "# Guide\n\nmore\n");
    gitOk(src, ["commit", "-qam", "docs only"]);
    gitOk(src, ["push", "-q", remote, "main"], auth);
    const docs = gitOk(src, ["rev-parse", "HEAD"]).trim();

    // A pushed tag runs the release workflow, for the commit it points at.
    gitOk(src, ["tag", "-a", "v1.0", "-m", "v1.0"]);
    gitOk(src, ["push", "-q", remote, "v1.0"], auth);
    const [release] = await finished(owner.ctx, api, docs, 1);
    expect([release.workflowName, release.ref, release.status]).toEqual(["Release", "v1.0", "success"]);
    expect(await log(owner.ctx, api, release.id)).toContain("releasing tag v1.0");
    expect((await runsOf(owner.ctx, api)).filter((r) => r.sha === docs).map((r) => r.workflowName)).toEqual(["Release"]);

    // A feature branch push runs nothing (Tests only takes main); opening a pull request runs PR checks.
    gitOk(src, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(src, "app.txt"), "v2\n");
    gitOk(src, ["commit", "-qam", "v2"]);
    gitOk(src, ["push", "-q", remote, "feature"], auth);
    const v2 = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const { pull } = await (await owner.ctx.post(`${api}/pulls`, { data: { title: "v2", body: "", base: "main", head: "feature" }, headers: headers() })).json();
    const [opened] = await finished(owner.ctx, api, v2, 1);
    expect([opened.workflowName, opened.event, opened.pullNumber, opened.status]).toEqual(["PR checks", "pull_request", pull.number, "success"]);
    expect(await log(owner.ctx, api, opened.id)).toContain(`pull=${pull.number} base=main head=feature`);

    // Pushing to the pull request's branch runs its checks again, on the new head.
    writeFileSync(join(src, "app.txt"), "v3\n");
    gitOk(src, ["commit", "-qam", "v3"]);
    gitOk(src, ["push", "-q", remote, "feature"], auth);
    const v3 = gitOk(src, ["rev-parse", "HEAD"]).trim();
    expect((await finished(owner.ctx, api, v3, 1)).map((r) => [r.workflowName, r.event])).toEqual([["PR checks", "pull_request"]]);

    await uiLogin(page, owner.username, owner.password);
    await page.goto(`${baseURL()}/${owner.username}/${repo}/pull/${pull.number}`);
    await expect(page.getByText("All checks have passed")).toBeVisible();
    await expect(page.getByRole("list", { name: "Checks" }).getByRole("listitem")).toHaveText([/PR checks\s*\(pull request\)/]);

    // Merging moves main like a push, so Tests runs on the merge commit.
    const merged = await (await owner.ctx.post(`${api}/pulls/${pull.number}/merge`, { data: {}, headers: headers() })).json();
    expect((await finished(owner.ctx, api, merged.sha, 1)).map((r) => [r.workflowName, r.event, r.ref])).toEqual([["Tests", "push", "main"]]);

    // Manual runs: the CI tab lists the workflows, and Manual can be started with its inputs.
    await page.goto(`${baseURL()}/${owner.username}/${repo}/ci`);
    const nav = page.getByRole("navigation", { name: "Workflows" });
    await expect(nav.getByRole("link")).toHaveText(["All workflows", "Manual", "PR checks", "Release", "Tests"]);
    await nav.getByRole("link", { name: "Manual" }).click();
    await expect(page.getByText("runs on manual")).toBeVisible();
    await page.locator("summary", { hasText: "Run workflow" }).click();
    const form = page.getByRole("form", { name: "Run Manual" });
    await form.getByLabel("target").selectOption("production");
    await form.getByLabel("Only pretend").check();
    await form.getByLabel("note (required)").fill("hotfix; $(echo nope)");
    await info.attach("run-workflow", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await form.getByRole("button", { name: "Run workflow" }).click();
    await expect(page).toHaveURL(/\/ci\/\d+$/);
    await expect(page.getByText("manual on")).toBeVisible();
    await expect(page.getByLabel("Inputs")).toContainText("production");
    // Inputs are plain values: nothing in them runs.
    await expect(page.getByRole("log").first()).toContainText("target=production dry=true note=hotfix; $(echo nope)", { timeout: 30_000 });
    await info.attach("manual-run", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // Inputs are checked, and only workflows with workflow_dispatch can be started by hand.
    const dispatch = (data: object) => owner.ctx.post(`${api}/ci/workflows/dispatch`, { data, headers: headers() });
    expect((await dispatch({ workflow: ".ether/workflows/manual.yml", ref: "main", inputs: {} })).status()).toBe(400);
    expect(await (await dispatch({ workflow: ".ether/workflows/manual.yml", ref: "main", inputs: { note: "x", target: "prod" } })).text()).toContain("one of staging, production");
    expect(await (await dispatch({ workflow: ".ether/workflows/test.yml", ref: "main" })).text()).toContain("doesn't include workflow_dispatch");
    expect((await dispatch({ workflow: "../../etc/passwd", ref: "main" })).status()).toBe(400);
    const reader = await createUser(admin);
    await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });
    expect((await reader.ctx.post(`${api}/ci/workflows/dispatch`, { data: { workflow: ".ether/workflows/manual.yml", ref: "main", inputs: { note: "x" } }, headers: headers() })).status()).toBe(403);

    // Manual runs aren't checks, and the run list filters by workflow.
    const manual = (await (await owner.ctx.get(`${api}/ci/runs?workflow=${encodeURIComponent(".ether/workflows/manual.yml")}`)).json()).runs as Run[];
    expect(manual.map((r) => [r.workflowName, r.event])).toEqual([["Manual", "workflow_dispatch"]]);

    // A workflow file that doesn't parse shows up as an errored run on the next push, and in the list.
    gitOk(src, ["checkout", "-q", "main"]);
    gitOk(src, ["pull", "-q", remote, "main"], auth);
    writeFileSync(join(src, ".ether", "workflows", "broken.yml"), "jobs:\n  x:\n    steps: [{ run: x }]\n");
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-qm", "broken workflow"]);
    gitOk(src, ["push", "-q", remote, "main"], auth);
    const broken = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const runs = await finished(owner.ctx, api, broken, 2);
    const bad = runs.find((r) => r.workflowName === "broken")!;
    expect(bad.status).toBe("error");
    expect(bad.message).toContain('.ether/workflows/broken.yml needs "on"');
    expect(runs.find((r) => r.workflowName === "Tests")?.status).toBe("success");
  } finally {
    await (await loginAdmin()).put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
