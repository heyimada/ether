import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chownWorkspaceArgs, containerRuntime, createArgs, DEFAULT_IMAGE, envScript, execArgs, instanceLabel, shellCommand } from "./ci-container";
import { loadSecrets } from "./ci-secrets";
import { parseWorkflow, WORKFLOW, type EnvValue, type Shell, type Step } from "./ci-workflow";
import { config } from "./config";
import { db } from "./db/client";
import { ciJob, ciRun, instanceSetting, repo, user } from "./db/schema";
import { record } from "./events";
import * as git from "./git";
import { LogMasker } from "./log-mask";

// CI runs workflows from .ether/ci.yml, so it is opt-in twice: an admin allows it for the server,
// and an owner turns it on per repository. Jobs run one at a time from a fresh checkout. By default
// each job runs in its own container (see ci-container.ts) and sees nothing of the server; an admin
// can instead let jobs run on the host as Ether's own user, which gives every writer the server.
// Repository secrets are only ever passed to container jobs.

const MAX_LOG = 1024 * 1024;
export type Isolation = "container" | "host";

const setting = (key: string) => db.select().from(instanceSetting).where(eq(instanceSetting.key, key)).get()?.value;
export const ciAllowed = () => setting("ciEnabled") === "true";
// Containers unless an admin chose the host explicitly.
export const ciIsolation = (): Isolation => (setting("ciIsolation") === "host" ? "host" : "container");

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

const ciVars = (r: { owner: string; name: string; sha: string; ref: string }) => ({ CI: "true", CI_REPOSITORY: `${r.owner}/${r.name}`, CI_COMMIT_SHA: r.sha, CI_REF: r.ref });

// On the host, only what tools need to work: no ETHER_* settings, auth secret or tokens.
function hostEnv() {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "ProgramFiles"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

const secretNames = (steps: Step[]) => [...new Set(steps.flatMap((s) => Object.values(s.env ?? {}).flatMap((v) => (typeof v === "string" ? [] : [v.secret]))))];
const resolveEnv = (env: Record<string, EnvValue> | undefined, secrets: Map<string, string>) =>
  Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : secrets.get(v.secret)!]));

// A container CLI call whose output goes to the job's log; resolves with its exit code.
async function cli(runtime: string, args: string[], append: (s: string) => void, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn([runtime, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of s) append(decoder.decode(chunk, { stream: true }));
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  clearTimeout(timer);
  return proc.exited;
}

const instance = () => instanceLabel(resolve(config.dataDir));

const removeContainer = (runtime: string, name: string) => Bun.spawn([runtime, "rm", "--force", name], { stdout: "ignore", stderr: "ignore" }).exited;

// ---------- queue ----------

let running: { runId: number; proc: ReturnType<typeof Bun.spawn> | null; container: { runtime: string; name: string } | null } | null = null;
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
  running = { runId: run.id, proc: null, container: null };
  db.update(ciRun).set({ status: "running", startedAt: new Date() }).where(eq(ciRun.id, run.id)).run();
  let ok = true;
  for (const job of db.select().from(ciJob).where(eq(ciJob.runId, run.id)).orderBy(asc(ciJob.id)).all()) {
    if (currentStatus(run.id) === "cancelled") break;
    const result = await executeJob(job, r.repo.id, path, { owner: r.owner!, name: r.repo.name, sha: run.sha, ref: run.ref });
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

async function executeJob(job: typeof ciJob.$inferSelect, repoId: number, repoPath: string, ctx: { owner: string; name: string; sha: string; ref: string }) {
  let log = "";
  const append = (s: string) => {
    if (log.length < MAX_LOG) log += s.slice(0, MAX_LOG - log.length);
  };
  const save = (status?: typeof ciJob.$inferInsert.status) =>
    db.update(ciJob).set({ log, ...(status ? { status } : {}) }).where(eq(ciJob.id, job.id)).run();
  db.update(ciJob).set({ status: "running", startedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
  const dir = mkdtempSync(join(tmpdir(), "ether-ci-"));
  const steps = JSON.parse(job.steps) as Step[];
  const isolation = ciIsolation();
  let box: { runtime: string; name: string } | null = null;
  let status: "success" | "failure" | "error" = "success";
  const fail = (message: string) => {
    append(`${message}\n`);
    status = "error";
    return status;
  };
  try {
    const wanted = secretNames(steps);
    if (wanted.length && isolation === "host")
      return fail(`This job uses secrets (${wanted.join(", ")}), which are only passed to jobs that run in containers. An admin can switch CI to containers under Admin → Access.`);
    const secrets = loadSecrets(repoId, wanted);
    const values = [...secrets.values()];

    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--no-checkout", repoPath, dir]);
    const checkout = clone.exitCode === 0 ? Bun.spawnSync(["git", "-C", dir, "checkout", "--quiet", "--detach", ctx.sha]) : clone;
    if (checkout.exitCode !== 0) return fail(`Could not check out ${ctx.sha}: ${new TextDecoder().decode(checkout.stderr)}`);

    if (isolation === "container") {
      const runtime = containerRuntime();
      if (!runtime) return fail("No container runtime found: install Docker or Podman on the server, or let an admin run CI on the host under Admin → Access (unsafe).");
      const image = job.image ?? DEFAULT_IMAGE;
      box = { runtime, name: `ether-ci-${job.runId}-${job.id}-${randomBytes(4).toString("hex")}` };
      if (running) running.container = box;
      append(`▶ Starting ${image} with ${basename(runtime)}\n`);
      save();
      // Creating pulls the image when it isn't there yet, which can take a while.
      if ((await cli(runtime, createArgs(box.name, image, instance()), append, 15 * 60_000)) !== 0) return fail(`✖ Could not create a container from ${image}`);
      if ((await cli(runtime, ["cp", `${dir}/.`, `${box.name}:/workspace`], append, 10 * 60_000)) !== 0) return fail("✖ Could not copy the checkout into the container");
      if ((await cli(runtime, ["start", box.name], append, 60_000)) !== 0) return fail("✖ Could not start the container");
      // `cp` leaves the checkout owned by root; an image that runs as another user needs it to be theirs.
      const who = Bun.spawnSync([runtime, "exec", box.name, "sh", "-c", 'echo "$(id -u):$(id -g)"'], { stdout: "pipe", stderr: "pipe" });
      const owner = new TextDecoder().decode(who.stdout).trim();
      if (who.exitCode === 0 && /^\d+:\d+$/.test(owner) && owner !== "0:0" && (await cli(runtime, chownWorkspaceArgs(box.name, owner), append, 5 * 60_000)) !== 0)
        append(`Could not hand /workspace to the image's user ${owner}; steps may not be able to write to it\n`);
      append("\n");
    }

    for (const step of steps) {
      if (currentStatus(job.runId) === "cancelled") break;
      append(`▶ ${step.name}\n`);
      save();
      const started = Date.now();
      const vars = { ...ciVars(ctx), ...resolveEnv(step.env, secrets) };
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        if (box) {
          // The job's variables go in on stdin; the CLI keeps Ether's own environment.
          const script = envScript(vars);
          const exec = Bun.spawn([box.runtime, ...execArgs(box.name, shellCommand(step.shell, step.run))], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
          exec.stdin.write(script);
          await exec.stdin.end();
          proc = exec;
        } else proc = Bun.spawn(command(step.shell, step.run), { cwd: dir, env: { ...hostEnv(), ...vars }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      } catch (e) {
        return fail(`✖ ${step.name}: ${(e as Error).message}`);
      }
      if (running) running.proc = proc;
      const timer = setTimeout(() => {
        append(`\n✖ Timed out after ${step.timeoutMinutes} minutes\n`);
        proc.kill();
      }, step.timeoutMinutes * 60_000);
      // One masker and decoder per stream, so a secret or a character split across chunks stays whole.
      const pump = async (s: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        const mask = new LogMasker(values);
        for await (const chunk of s) {
          append(mask.push(decoder.decode(chunk, { stream: true })));
          save();
        }
        append(mask.flush());
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
    if (box) await removeContainer(box.runtime, box.name);
    if (running) running.container = null;
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
    tx.insert(ciJob).values(jobs.map((j) => ({ runId: run.id, name: j.name, image: j.image, steps: JSON.stringify(j.steps), status: "queued" as const }))).run();
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
  if (running?.runId === runId) {
    running.proc?.kill();
    // Killing the CLI doesn't stop what it started inside the container.
    if (running.container) void removeContainer(running.container.runtime, running.container.name);
  }
  return true;
}

// The newest run for a commit, which is what pull requests show as their checks.
export const latestRun = (repoId: number, sha: string) =>
  db.select().from(ciRun).where(and(eq(ciRun.repoId, repoId), eq(ciRun.sha, sha))).orderBy(desc(ciRun.id)).get() ?? null;

// Runs interrupted by a restart can't resume mid-step; queued ones simply continue.
export function resumeQueue() {
  // Containers of this server's jobs that a crash or restart interrupted; another Ether's on the same daemon stay.
  const runtime = containerRuntime();
  if (runtime) {
    const list = Bun.spawnSync([runtime, "ps", "--all", "--quiet", "--filter", "label=ether.ci=1", "--filter", `label=ether.ci.instance=${instance()}`]);
    const ids = list.exitCode === 0 ? new TextDecoder().decode(list.stdout).split(/\s+/).filter(Boolean) : [];
    if (ids.length) Bun.spawnSync([runtime, "rm", "--force", ...ids]);
  }
  db.update(ciRun).set({ status: "error", message: "Ether restarted while this run was in progress", finishedAt: new Date() }).where(eq(ciRun.status, "running")).run();
  db.update(ciJob).set({ status: "cancelled" }).where(eq(ciJob.status, "running")).run();
  void drain();
}
