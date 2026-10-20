import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { db } from "./db/client";
import { ciJob, ciRun, instanceSetting, repo, user } from "./db/schema";
import { record } from "./events";
import * as git from "./git";

// CI runs workflows from .ether/ci.yml on this machine, so it is opt-in twice: an admin allows
// it for the server, and an owner turns it on per repository. Jobs run one at a time in a fresh
// checkout with a minimal environment that never includes Ether's own secrets.

const WORKFLOW = ".ether/ci.yml";
const MAX_LOG = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const SHELLS = ["bash", "sh", "pwsh", "powershell", "cmd"] as const;
type Shell = (typeof SHELLS)[number];
type Step = { name: string; run: string; shell: Shell | null; timeoutMinutes: number };

export const ciAllowed = () => db.select().from(instanceSetting).where(eq(instanceSetting.key, "ciEnabled")).get()?.value === "true";

// Validates the workflow and normalises it into jobs of steps; throws a readable message.
export function parseWorkflow(text: string): { name: string; steps: Step[] }[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`${WORKFLOW} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new Error(`${WORKFLOW} needs a "jobs" map`);
  const out = Object.entries(jobs as Record<string, unknown>).map(([name, job]) => {
    if (!NAME_RE.test(name)) throw new Error(`Job name "${name}" must be letters, digits, spaces, '.', '_' or '-'`);
    const steps = (job as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps) || steps.length === 0) throw new Error(`Job "${name}" needs a list of steps`);
    return {
      name,
      steps: steps.map((s, i): Step => {
        const step = s as { name?: unknown; run?: unknown; shell?: unknown; "timeout-minutes"?: unknown };
        if (typeof step?.run !== "string" || !step.run.trim()) throw new Error(`Step ${i + 1} of "${name}" needs a "run" command`);
        if (step.shell !== undefined && !SHELLS.includes(step.shell as Shell)) throw new Error(`Step ${i + 1} of "${name}": shell must be one of ${SHELLS.join(", ")}`);
        const minutes = Number(step["timeout-minutes"] ?? 10);
        return {
          name: typeof step.name === "string" && step.name.trim() ? step.name.trim().slice(0, 100) : step.run.split("\n")[0].slice(0, 100),
          run: step.run,
          shell: (step.shell as Shell | undefined) ?? null,
          timeoutMinutes: Math.min(60, Math.max(1, Number.isFinite(minutes) ? minutes : 10)),
        };
      }),
    };
  });
  if (out.length === 0 || out.length > 20) throw new Error(`${WORKFLOW} needs between 1 and 20 jobs`);
  return out;
}

function command(shell: Shell | null, run: string): string[] {
  const chosen = shell ?? (Bun.which("bash") ? "bash" : process.platform === "win32" ? "cmd" : "sh");
  switch (chosen) {
    case "bash":
      return [Bun.which("bash") ?? "bash", "-e", "-c", run];
    case "sh":
      return ["sh", "-e", "-c", run];
    case "pwsh":
      return ["pwsh", "-NoProfile", "-NonInteractive", "-Command", run];
    case "powershell":
      return ["powershell", "-NoProfile", "-NonInteractive", "-Command", run];
    case "cmd":
      return ["cmd", "/d", "/s", "/c", run];
  }
}

// Only what tools need to work: no ETHER_* settings, auth secret or tokens.
function stepEnv(r: { owner: string; name: string; sha: string; ref: string }) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "ProgramFiles"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return { ...env, CI: "true", CI_REPOSITORY: `${r.owner}/${r.name}`, CI_COMMIT_SHA: r.sha, CI_REF: r.ref };
}

// ---------- queue ----------

let running: { runId: number; proc: ReturnType<typeof Bun.spawn> | null } | null = null;
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const next = db.select().from(ciRun).where(eq(ciRun.status, "queued")).orderBy(asc(ciRun.id)).get();
      if (!next) break;
      await execute(next);
    }
  } finally {
    draining = false;
  }
}

async function execute(run: typeof ciRun.$inferSelect) {
  const r = db.select({ repo, owner: user.username }).from(repo).innerJoin(user, eq(user.id, repo.ownerId)).where(eq(repo.id, run.repoId)).get();
  if (!r) return;
  const path = git.repoPath(r.owner!, r.repo.name);
  running = { runId: run.id, proc: null };
  db.update(ciRun).set({ status: "running", startedAt: new Date() }).where(eq(ciRun.id, run.id)).run();
  let ok = true;
  for (const job of db.select().from(ciJob).where(eq(ciJob.runId, run.id)).orderBy(asc(ciJob.id)).all()) {
    if (currentStatus(run.id) === "cancelled") break;
    const result = await executeJob(job, path, { owner: r.owner!, name: r.repo.name, sha: run.sha, ref: run.ref });
    ok &&= result === "success";
  }
  running = null;
  if (currentStatus(run.id) === "cancelled") {
    db.update(ciJob).set({ status: "cancelled" }).where(and(eq(ciJob.runId, run.id), inArray(ciJob.status, ["queued", "running"]))).run();
    db.update(ciRun).set({ finishedAt: new Date() }).where(eq(ciRun.id, run.id)).run();
  } else {
    db.update(ciRun).set({ status: ok ? "success" : "failure", finishedAt: new Date() }).where(eq(ciRun.id, run.id)).run();
    if (!ok) await reportFailure(run, path, "failure");
  }
}

// Failed checks go into the feed of whoever started the run.
async function reportFailure(run: { id: number; repoId: number; sha: string; ref: string; actorId: string | null }, path: string, status: string) {
  if (!run.actorId) return;
  const [commit] = await git.log(path, run.sha, { limit: 1 }).catch(() => []);
  record(run.repoId, run.actorId, "ci_failed", { runId: run.id, ref: run.ref, sha: run.sha, subject: commit?.subject ?? "", status });
}

const currentStatus = (runId: number) => db.select({ s: ciRun.status }).from(ciRun).where(eq(ciRun.id, runId)).get()?.s;

async function executeJob(job: typeof ciJob.$inferSelect, repoPath: string, ctx: { owner: string; name: string; sha: string; ref: string }) {
  let log = "";
  const append = (s: string) => {
    if (log.length < MAX_LOG) log += s.slice(0, MAX_LOG - log.length);
  };
  const save = (status?: typeof ciJob.$inferInsert.status) =>
    db.update(ciJob).set({ log, ...(status ? { status } : {}) }).where(eq(ciJob.id, job.id)).run();
  db.update(ciJob).set({ status: "running", startedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
  const dir = mkdtempSync(join(tmpdir(), "ether-ci-"));
  let status: "success" | "failure" | "error" = "success";
  try {
    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--no-checkout", repoPath, dir]);
    const checkout = clone.exitCode === 0 ? Bun.spawnSync(["git", "-C", dir, "checkout", "--quiet", "--detach", ctx.sha]) : clone;
    if (checkout.exitCode !== 0) {
      append(`Could not check out ${ctx.sha}: ${new TextDecoder().decode(checkout.stderr)}\n`);
      status = "error";
      return status;
    }
    for (const step of JSON.parse(job.steps) as Step[]) {
      append(`▶ ${step.name}\n`);
      save();
      const started = Date.now();
      const proc = Bun.spawn(command(step.shell, step.run), { cwd: dir, env: stepEnv(ctx), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      if (running) running.proc = proc;
      const timer = setTimeout(() => {
        append(`\n✖ Timed out after ${step.timeoutMinutes} minutes\n`);
        proc.kill();
      }, step.timeoutMinutes * 60_000);
      const decoder = new TextDecoder();
      const pump = async (s: ReadableStream<Uint8Array>) => {
        for await (const chunk of s) {
          append(decoder.decode(chunk, { stream: true }));
          save();
        }
      };
      await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
      const code = await proc.exited;
      clearTimeout(timer);
      if (running) running.proc = null;
      append(`${code === 0 ? "✔" : "✖"} ${step.name} (exit ${code}, ${((Date.now() - started) / 1000).toFixed(1)}s)\n\n`);
      if (code !== 0) {
        status = "failure";
        break;
      }
    }
    return status;
  } catch (e) {
    append(`\nRunner error: ${(e as Error).message}\n`);
    status = "error";
    return status;
  } finally {
    db.update(ciJob).set({ log, status: currentStatus(job.runId) === "cancelled" ? "cancelled" : status === "success" ? "success" : "failure", finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------- triggers ----------

// Queues a run for one commit if CI is allowed and the commit has a workflow.
export async function enqueue(repoId: number, repoPath: string, sha: string, ref: string, actorId: string | null = null): Promise<number | null> {
  const r = db.select().from(repo).where(eq(repo.id, repoId)).get();
  if (!r?.ciEnabled || !ciAllowed()) return null;
  const file = await git.readBlob(repoPath, sha, WORKFLOW).catch(() => null);
  if (!file?.content) return null;
  let jobs: ReturnType<typeof parseWorkflow>;
  try {
    jobs = parseWorkflow(file.content);
  } catch (e) {
    const id = db.insert(ciRun).values({ repoId, sha, ref, actorId, status: "error", message: (e as Error).message, finishedAt: new Date() }).returning({ id: ciRun.id }).get().id;
    await reportFailure({ id, repoId, sha, ref, actorId }, repoPath, "error");
    return id;
  }
  const id = db.transaction((tx) => {
    const run = tx.insert(ciRun).values({ repoId, sha, ref, actorId, status: "queued" }).returning({ id: ciRun.id }).get();
    tx.insert(ciJob).values(jobs.map((j) => ({ runId: run.id, name: j.name, steps: JSON.stringify(j.steps), status: "queued" as const }))).run();
    return run.id;
  });
  void drain();
  return id;
}

// After a push: one run per branch that moved to a new commit.
export async function onPush(repoId: number, repoPath: string, before: git.Ref[], after: git.Ref[], actorId: string) {
  for (const ref of after) {
    if (ref.kind !== "branch") continue;
    if (before.some((b) => b.kind === "branch" && b.name === ref.name && b.sha === ref.sha)) continue;
    await enqueue(repoId, repoPath, ref.sha, ref.name, actorId);
  }
}

export function cancel(runId: number) {
  const s = currentStatus(runId);
  if (s !== "queued" && s !== "running") return false;
  db.update(ciRun).set({ status: "cancelled", finishedAt: new Date() }).where(eq(ciRun.id, runId)).run();
  if (running?.runId === runId) running.proc?.kill();
  return true;
}

// The newest run for a commit, which is what pull requests show as their checks.
export const latestRun = (repoId: number, sha: string) =>
  db.select().from(ciRun).where(and(eq(ciRun.repoId, repoId), eq(ciRun.sha, sha))).orderBy(desc(ciRun.id)).get() ?? null;

// Runs interrupted by a restart can't resume mid-step; queued ones simply continue.
export function resumeQueue() {
  db.update(ciRun).set({ status: "error", message: "Ether restarted while this run was in progress", finishedAt: new Date() }).where(eq(ciRun.status, "running")).run();
  db.update(ciJob).set({ status: "cancelled" }).where(eq(ciJob.status, "running")).run();
  void drain();
}
