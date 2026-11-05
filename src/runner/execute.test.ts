import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJob } from "./execute";
import type { JobAssignment, RunnerStep } from "./protocol";

// A repository to check out; no database or server anywhere in sight.
const repo = mkdtempSync(join(tmpdir(), "ether-runner-test-"));
const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
git("init", "-q");
writeFileSync(join(repo, "first.txt"), "first\n");
git("add", "-A");
git("commit", "-q", "-m", "first");
const first = git("rev-parse", "HEAD");
writeFileSync(join(repo, "second.txt"), "second\n");
git("add", "-A");
git("commit", "-q", "-m", "second");
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const step = (run: string, more: Partial<RunnerStep> = {}): RunnerStep => ({ name: run, run, shell: "sh", timeoutMinutes: 1, env: {}, ...more });
const assignment = (steps: RunnerStep[], more: Partial<JobAssignment> = {}): JobAssignment => ({
  jobId: 1,
  runId: 1,
  isolation: "host",
  image: null,
  checkout: { url: repo, sha: first },
  vars: { CI: "true" },
  mask: [],
  steps,
  ...more,
});

async function run(job: JobAssignment) {
  let log = "";
  // An assignment has to survive the trip to a runner on another machine.
  const result = await startJob(JSON.parse(JSON.stringify(job)), { log: (t) => void (log += t) }, "test").done;
  return { result, log };
}

test("a job runs its steps in a checkout of its commit, with the run's variables and each step's env", async () => {
  const { result, log } = await run(assignment([step("ls"), step('echo "$CI/$ONE/$TWO"', { env: { ONE: "uno" } }), step('echo "second step: $ONE."')], { vars: { CI: "true", TWO: "dos" } }));
  expect(result).toBe("success");
  expect(log).toContain("first.txt");
  expect(log).not.toContain("second.txt");
  expect(log).toContain("true/uno/dos");
  // env is the step's own.
  expect(log).toContain("second step: .");
});

test("a failing step fails the job and skips the steps after it", async () => {
  const { result, log } = await run(assignment([step("exit 3"), step("echo never")]));
  expect(result).toBe("failure");
  expect(log).toContain("✖ exit 3 (exit 3,");
  expect(log).not.toContain("▶ echo never");
});

test("secrets stay out of the log, in step names too", async () => {
  const secret = "hunter2-very-secret";
  const { result, log } = await run(assignment([step(`echo ${secret}`), step('echo "$TOKEN"', { env: { TOKEN: secret } })], { mask: [secret] }));
  expect(result).toBe("success");
  expect(log).not.toContain(secret);
  expect(log).toContain("▶ echo ***");
});

test("a checkout that can't be made is an error, not a failed step", async () => {
  const { result, log } = await run(assignment([step("echo never")], { checkout: { url: repo, sha: "0".repeat(40) } }));
  expect(result).toBe("error");
  expect(log).toContain("Could not check out");
  expect(log).not.toContain("never");
});

test("stopping a job ends what its step started", async () => {
  let log = "";
  const started = Date.now();
  const job = startJob(assignment([step("echo started; sleep 60 & wait"), step("echo never")]), { log: (t) => void (log += t) }, "test");
  while (!log.includes("started")) await Bun.sleep(20);
  job.stop();
  expect(await job.done).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(log).not.toContain("▶ echo never");
});

test("a job stopped during its checkout ends there", async () => {
  let log = "";
  const job = startJob(assignment([step("echo never")], { isolation: "container", image: "example/never" }), { log: (t) => void (log += t) }, "test");
  job.stop();
  expect(await job.done).toBe("cancelled");
  expect(log).toBe("");
});

test("a step that runs out of time fails the job", async () => {
  const { result, log } = await run(assignment([step("sleep 60", { timeoutMinutes: 0.01 })]));
  expect(result).toBe("failure");
  expect(log).toContain("Timed out");
});

test("the runner stands on its own: it reaches into the server only for the pure modules it shares", () => {
  const shared = new Set(["../server/ci-container", "../server/log-mask"]);
  for (const file of readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    for (const [, from] of source.matchAll(/from "([^"]+)"/g)) expect(from.startsWith("node:") || from.startsWith("./") || shared.has(from), `${file} imports ${from}`).toBe(true);
  }
  for (const file of shared) expect(readFileSync(join(import.meta.dirname, `${file}.ts`), "utf8")).not.toMatch(/^import /m);
});
