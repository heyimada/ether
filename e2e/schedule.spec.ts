import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

type Run = { id: number; sha: string; workflowName: string; event: string; status: string; ref: string; message: string };
const runsOf = async (ctx: APIRequestContext, api: string): Promise<Run[]> => (await (await ctx.get(`${api}/ci/runs`)).json()).runs;

test("a workflow on a schedule runs from the default branch in the minute its cron names", async ({ page }, info) => {
  test.setTimeout(4 * 60_000);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  try {
    const owner = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("cron"));
    const api = `/api/repos/${owner.username}/${repo}`;
    const auth = { username: owner.username, token: owner.token };
    expect((await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() })).ok()).toBe(true);
    const remote = cloneUrl(owner.username, repo);

    // The next minute that's far enough off for the push to land first, as a cron for just that minute.
    let due = Math.ceil(Date.now() / 60_000) * 60_000;
    if (due - Date.now() < 20_000) due += 60_000;
    const when = new Date(due);
    const cron = `${when.getUTCMinutes()} ${when.getUTCHours()} * * *`;

    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    writeFileSync(
      join(src, ".ether", "workflows", "nightly.yml"),
      `name: Nightly\non:\n  schedule:\n    - cron: "${cron}"\njobs:\n  check:\n    steps:\n      - shell: bash\n        run: echo "event=$CI_EVENT ref=$CI_REF cron=\${{ github.event.schedule }}"\n`,
    );
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "nightly"]);
    gitOk(src, ["push", "-q", remote, "main"], auth);
    // Only on the default branch: the same workflow on another branch doesn't run.
    gitOk(src, ["push", "-q", remote, "main:other"], auth);
    const sha = gitOk(src, ["rev-parse", "HEAD"]).trim();

    // The push itself starts nothing, and the CI tab says when it will run.
    await uiLogin(page, owner.username, owner.password);
    await page.goto(`${baseURL()}/${owner.username}/${repo}/ci?workflow=.ether%2Fworkflows%2Fnightly.yml`);
    await expect(page.getByText(`runs on a schedule (${cron}, UTC)`)).toBeVisible();
    await info.attach("scheduled-workflow", { body: await page.screenshot(), contentType: "image/png" });
    expect(await runsOf(owner.ctx, api)).toEqual([]);

    let runs: Run[] = [];
    while (Date.now() < due + 60_000) {
      runs = await runsOf(owner.ctx, api);
      if (runs.length && runs.every((r) => !["queued", "running"].includes(r.status))) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(runs.map((r) => [r.workflowName, r.event, r.ref, r.sha, r.status])).toEqual([["Nightly", "schedule", "main", sha, "success"]]);
    const { jobs } = await (await owner.ctx.get(`${api}/ci/runs/${runs[0].id}`)).json();
    expect(jobs[0].log).toContain(`event=schedule ref=main cron=${cron}`);
    await page.goto(`${baseURL()}/${owner.username}/${repo}/ci`);
    await expect(page.getByText(`#${runs[0].id} · scheduled`)).toBeVisible();

    // A cron that can't be read is refused on the push that brings it, like any workflow that doesn't parse.
    writeFileSync(join(src, ".ether", "workflows", "nightly.yml"), `on:\n  schedule:\n    - cron: "* * * * *"\njobs:\n  check:\n    steps:\n      - run: echo hi\n`);
    gitOk(src, ["commit", "-qam", "too often"]);
    gitOk(src, ["push", "-q", remote, "main"], auth);
    const bad = gitOk(src, ["rev-parse", "HEAD"]).trim();
    await expect.poll(async () => (await runsOf(owner.ctx, api)).find((r) => r.sha === bad)?.message ?? "").toContain("more often than every 5 minutes");
  } finally {
    await (await loginAdmin()).put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
