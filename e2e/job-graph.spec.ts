import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

const GRAPH = `name: Graph
on: push
jobs:
  build:
    steps:
      - shell: bash
        run: sleep 2 && echo built
  lint:
    steps:
      - shell: bash
        run: sleep 2 && echo linted
  test:
    needs: build
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - shell: bash
        run: echo "shard $CI_MATRIX_SHARD of $CI_JOB" && test "$CI_MATRIX_SHARD" != 3
  report:
    needs: test
    if: failure()
    steps:
      - run: echo reporting
  ship:
    needs: [test, lint]
    steps:
      - run: echo shipping
  cleanup:
    needs: ship
    if: \${{ always() }}
    steps:
      - run: echo cleaning up
  notify:
    needs: ship
    if: failure()
    steps:
      - run: echo notifying
  archive:
    needs: cleanup
    steps:
      - run: echo archiving
`;

// Two deploy jobs for one environment, which would otherwise run at the same time.
const DEPLOY = `name: Deploy
on: push
jobs:
  deploy:
    environment: staging
    strategy:
      matrix:
        part: [a, b]
    steps:
      - shell: bash
        run: sleep 2 && echo "deployed $CI_MATRIX_PART"
`;

const FAST = `name: Fast
on: push
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - shell: bash
        run: if [ "$CI_MATRIX_SHARD" = 1 ]; then exit 1; else sleep 60; fi
`;

type Job = { name: string; key: string; status: string; log: string; needs: string[]; startedAt: string | null; finishedAt: string | null };

async function finishedRun(ctx: APIRequestContext, api: string, sha: string) {
  for (let i = 0; i < 300; i++) {
    const { runs } = await (await ctx.get(`${api}/ci/runs`)).json();
    const run = runs.find((r: { sha: string }) => r.sha === sha);
    if (run && !["queued", "running", "waiting"].includes(run.status)) {
      const detail = await (await ctx.get(`${api}/ci/runs/${run.id}`)).json();
      return { run, jobs: Object.fromEntries((detail.jobs as Job[]).map((j) => [j.name, j])) as Record<string, Job> };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run for ${sha} didn't finish`);
}

const at = (s: string | null) => new Date(s!).getTime();

test("jobs wait for their needs, run side by side, fan out over a matrix and follow if:", async ({ page }, info) => {
  test.setTimeout(3 * 60_000);
  const admin = await loginAdmin();
  await admin.put("/api/admin/settings", { data: { ciEnabled: true, ciIsolation: "host" }, headers: headers() });
  try {
    const owner = await createUser(admin);
    const repo = await createRepo(owner.ctx, unique("graph"));
    const api = `/api/repos/${owner.username}/${repo}`;
    const auth = { username: owner.username, token: owner.token };
    expect((await owner.ctx.patch(api, { data: { ciEnabled: true }, headers: headers() })).ok()).toBe(true);

    const src = workdir();
    gitOk(src, ["init", "-q", "-b", "main"]);
    mkdirSync(join(src, ".ether", "workflows"), { recursive: true });
    writeFileSync(join(src, ".ether", "workflows", "graph.yml"), GRAPH);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "graph"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    const sha = gitOk(src, ["rev-parse", "HEAD"]).trim();
    const { run, jobs } = await finishedRun(owner.ctx, api, sha);

    // build and lint have no needs, so they ran at the same time.
    expect(at(jobs.lint.startedAt)).toBeLessThan(at(jobs.build.finishedAt));
    expect(at(jobs.build.startedAt)).toBeLessThan(at(jobs.lint.finishedAt));
    // The matrix fans test out into one job per shard, each started only after build finished.
    for (const shard of [1, 2, 3]) {
      const t = jobs[`test (${shard})`];
      expect(t.key).toBe("test");
      expect(at(t.startedAt)).toBeGreaterThanOrEqual(at(jobs.build.finishedAt));
      expect(t.log).toContain(`shard ${shard} of test`);
    }
    expect([jobs["test (1)"].status, jobs["test (2)"].status, jobs["test (3)"].status]).toEqual(["success", "success", "failure"]);
    // A failed need skips what needs it, unless its if: says otherwise.
    expect(jobs.report.status).toBe("success");
    expect(jobs.ship.status).toBe("skipped");
    expect(jobs.ship.log).toContain("test (3) didn't succeed");
    expect(jobs.cleanup.status).toBe("success");
    // failure() looks up the whole chain: ship was only skipped, but test (3) before it failed.
    expect(jobs.notify.status).toBe("success");
    // cleanup succeeded, but archive is still skipped for what failed before it, and says which job that was.
    expect(jobs.archive.status).toBe("skipped");
    expect(jobs.archive.log).toContain("test (3) didn't succeed");
    expect(run.status).toBe("failure");

    await uiLogin(page, owner.username, owner.password);
    await page.goto(`${baseURL()}/${owner.username}/${repo}/ci/${run.id}`);
    await expect(page.getByRole("region", { name: "Job ship" })).toContainText("needs test, lint");
    await expect(page.getByRole("region", { name: "Job cleanup" })).toContainText("if always()");
    await expect(page.getByRole("region", { name: "Job test (3)" })).toContainText("Failed");
    await info.attach("job-graph", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // An environment takes one deployment at a time.
    writeFileSync(join(src, ".ether", "workflows", "graph.yml"), DEPLOY);
    gitOk(src, ["commit", "-qam", "deploy"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    const deploy = await finishedRun(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim());
    const [a, b] = [deploy.jobs["deploy (a)"], deploy.jobs["deploy (b)"]];
    expect([a.status, b.status]).toEqual(["success", "success"]);
    expect(at(b.startedAt)).toBeGreaterThanOrEqual(at(a.finishedAt));

    // fail-fast (the default): one shard failing cancels the others instead of letting them run out.
    writeFileSync(join(src, ".ether", "workflows", "graph.yml"), FAST);
    gitOk(src, ["commit", "-qam", "fast"]);
    const started = Date.now();
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
    const fast = await finishedRun(owner.ctx, api, gitOk(src, ["rev-parse", "HEAD"]).trim());
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(fast.jobs["test (1)"].status).toBe("failure");
    expect(fast.jobs["test (2)"].status).toBe("cancelled");
    expect(fast.run.status).toBe("failure");
  } finally {
    await (await loginAdmin()).put("/api/admin/settings", { data: { ciEnabled: false, ciIsolation: "container" }, headers: headers() });
  }
});
