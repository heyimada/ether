import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chownWorkspaceArgs, cli, collect, containerRuntime, createArgs, DEFAULT_IMAGE, envScript, execArgs, instanceLabel, shellCommand } from "./ci-container";
import { loadSecrets } from "./ci-secrets";
import { parseWorkflow, WORKFLOW, type EnvValue, type Shell, type Step } from "./ci-workflow";
import { config } from "./config";
import { db } from "./db/client";
import { ciJob, ciRun, deployment, instanceSetting, repo, user } from "./db/schema";
import { cancelDeployments, deploymentOfJob, ensureEnvironment, environmentOfJob, reviewerIds, rulesOf, setDeployment, type Environment } from "./deploy";
import { gate } from "./deploy-rules";
import { record } from "./events";
import * as git from "./git";
import { LogMasker } from "./log-mask";

// CI runs workflows from .ether/ci.yml, so it is opt-in twice: an admin allows it for the server,
// and an owner turns it on per repository. Jobs run one at a time from a fresh checkout. By default
// each job runs in its own container (see ci-container.ts) and sees nothing of the server; an admin
// can instead let jobs run on the host as Ether's own user, which gives every writer the server.
// Repository secrets are only ever passed to container jobs. A job that names an environment is a
// deployment (see deploy.ts): it may first have to wait for a reviewer or a timer, which it does outside
// the queue, so other runs go on meanwhile.

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

const instance = () => instanceLabel(resolve(config.dataDir));

const removeContainer = (runtime: string, name: string) => Bun.spawn([runtime, "rm", "--force", name], { stdout: "ignore", stderr: "ignore" }).exited;

// ---------- queue ----------

let running: { runId: number; proc: ReturnType<typeof Bun.spawn> | null; container: { runtime: string; name: string } | null } | null = null;
let draining = false;

// The startup sweep of leftover containers; nothing may start a job until it's done (see resumeQueue).
let sweep: Promise<void> = Promise.resolve();

async function drain() {
  if (draining) return;
  draining = true;
  try {
    // The sweep selects by label, which a job started now would share, so it has to finish first.
    await sweep;
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
  db.update(ciRun).set({ status: "running", startedAt: run.startedAt ?? new Date() }).where(eq(ciRun.id, run.id)).run();
  const ctx = { owner: r.owner!, name: r.repo.name, sha: run.sha, ref: run.ref };
  // A run comes back here after a deploy job was approved or its timer ran out; jobs that already
  // finished, or still wait, are left alone.
  for (const job of db.select().from(ciJob).where(and(eq(ciJob.runId, run.id), eq(ciJob.status, "queued"))).orderBy(asc(ciJob.id)).all()) {
    if (currentStatus(run.id) === "cancelled") break;
    const env = environmentOfJob(job, r.repo.id);
    if (env && !admit(job, env, run)) continue;
    if (env) setDeployment(job.id, { status: "in_progress" });
    const result = await executeJob(job, r.repo.id, path, ctx, env);
    if (env && currentStatus(run.id) !== "cancelled") setDeployment(job.id, { status: result === "success" ? "success" : "failure", finishedAt: new Date() });
  }
  running = null;
  await settle(run.id, path);
}

// Whether a deploy job may start now. If not, it waits (for a reviewer or until its timer runs out) or is turned down.
function admit(job: typeof ciJob.$inferSelect, env: Environment, run: typeof ciRun.$inferSelect): boolean {
  const d = deploymentOfJob(job.id);
  const review = d?.reviewedAt ? { approved: d.status !== "rejected", at: d.reviewedAt } : null;
  const g = gate(rulesOf(env), run.ref, review, run.createdAt, new Date());
  if (g.action === "run") return true;
  if (g.action === "reject") {
    const log = `${job.log}✖ Not deployed to ${env.name}: ${g.reason}.\n`;
    db.update(ciJob).set({ status: "failure", log, startedAt: job.startedAt ?? new Date(), finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
    setDeployment(job.id, { status: "rejected", finishedAt: new Date() });
    return false;
  }
  const notBefore = g.action === "wait-until" ? g.at : null;
  const why = g.action === "wait-until" ? `Waiting until ${g.at.toISOString()} before deploying to ${env.name}.` : `Waiting for a reviewer to approve deploying to ${env.name}.`;
  db.update(ciJob).set({ status: "waiting", notBefore, log: `${job.log}${why}\n` }).where(eq(ciJob.id, job.id)).run();
  setDeployment(job.id, { status: "waiting" });
  if (notBefore) wakeAt(job.id, notBefore);
  return false;
}

// A run's status from its jobs once nothing of it is running: waiting while a deploy job waits, then success or failure.
async function settle(runId: number, path: string) {
  const run = db.select().from(ciRun).where(eq(ciRun.id, runId)).get();
  if (!run) return;
  const jobs = db.select({ status: ciJob.status }).from(ciJob).where(eq(ciJob.runId, runId)).all();
  if (run.status === "cancelled") {
    db.update(ciJob).set({ status: "cancelled" }).where(and(eq(ciJob.runId, runId), inArray(ciJob.status, ["queued", "waiting", "running"]))).run();
    cancelDeployments(runId);
    db.update(ciRun).set({ finishedAt: run.finishedAt ?? new Date() }).where(eq(ciRun.id, runId)).run();
    return;
  }
  if (jobs.some((j) => j.status === "queued")) return void db.update(ciRun).set({ status: "queued" }).where(eq(ciRun.id, runId)).run();
  if (jobs.some((j) => j.status === "waiting")) return void db.update(ciRun).set({ status: "waiting" }).where(eq(ciRun.id, runId)).run();
  const ok = jobs.every((j) => j.status === "success");
  db.update(ciRun).set({ status: ok ? "success" : "failure", finishedAt: new Date() }).where(eq(ciRun.id, runId)).run();
  if (!ok) await reportFailure(run, path, "failure");
}

// ---------- waiting deploy jobs ----------

const timers = new Map<number, ReturnType<typeof setTimeout>>();

// Puts a waiting job (and its run) back in the queue.
function requeue(jobId: number) {
  timers.delete(jobId);
  const job = db.select().from(ciJob).where(eq(ciJob.id, jobId)).get();
  if (!job || job.status !== "waiting" || currentStatus(job.runId) === "cancelled") return;
  db.update(ciJob).set({ status: "queued", notBefore: null }).where(eq(ciJob.id, jobId)).run();
  db.update(ciRun).set({ status: "queued" }).where(and(eq(ciRun.id, job.runId), inArray(ciRun.status, ["waiting", "running"]))).run();
  void drain();
}

function wakeAt(jobId: number, at: Date) {
  clearTimeout(timers.get(jobId));
  // setTimeout can't wait longer than about 24.8 days; check again then.
  const ms = Math.min(Math.max(0, at.getTime() - Date.now()), 2 ** 31 - 1);
  timers.set(jobId, setTimeout(() => (Date.now() >= at.getTime() ? requeue(jobId) : wakeAt(jobId, at)), ms));
}

export class ReviewError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// A reviewer's answer to a deploy job that waits for one. Approving sends it on (to its timer, if any);
// rejecting fails it, and the run once nothing else of it is left.
export async function reviewDeployment(jobId: number, repoId: number, reviewerId: string, approve: boolean) {
  const job = db.select().from(ciJob).where(eq(ciJob.id, jobId)).get();
  const run = job && db.select().from(ciRun).where(and(eq(ciRun.id, job.runId), eq(ciRun.repoId, repoId))).get();
  const env = job && run ? environmentOfJob(job, repoId) : null;
  const d = job ? deploymentOfJob(job.id) : null;
  if (!job || !run || !env || !d) throw new ReviewError(404, "No such deployment");
  if (job.status !== "waiting" || d.reviewedAt) throw new ReviewError(409, "This deployment isn't waiting for a review");
  if (!reviewerIds(env.id).includes(reviewerId)) throw new ReviewError(403, `Only ${env.name}'s reviewers can review this deployment`);
  const reviewer = db.select({ username: user.username }).from(user).where(eq(user.id, reviewerId)).get()?.username ?? "a reviewer";
  setDeployment(job.id, { reviewedBy: reviewerId, reviewedAt: new Date(), ...(approve ? {} : { status: "rejected", finishedAt: new Date() }) });
  if (approve) {
    db.update(ciJob).set({ log: `${job.log}✔ Approved by ${reviewer}.\n` }).where(eq(ciJob.id, job.id)).run();
    requeue(job.id);
    return;
  }
  db.update(ciJob).set({ status: "failure", log: `${job.log}✖ Rejected by ${reviewer}; not deployed to ${env.name}.\n`, finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
  const r = db.select({ owner: user.username, name: repo.name }).from(repo).innerJoin(user, eq(user.id, repo.ownerId)).where(eq(repo.id, repoId)).get()!;
  if (running?.runId !== run.id) await settle(run.id, git.repoPath(r.owner!, r.name));
}

// Failed checks go into the feed of whoever started the run.
async function reportFailure(run: { id: number; repoId: number; sha: string; ref: string; actorId: string | null }, path: string, status: string) {
  if (!run.actorId) return;
  const [commit] = await git.log(path, run.sha, { limit: 1 }).catch(() => []);
  record(run.repoId, run.actorId, "ci_failed", { runId: run.id, ref: run.ref, sha: run.sha, subject: commit?.subject ?? "", status });
}

const currentStatus = (runId: number) => db.select({ s: ciRun.status }).from(ciRun).where(eq(ciRun.id, runId)).get()?.s;

async function executeJob(job: typeof ciJob.$inferSelect, repoId: number, repoPath: string, ctx: { owner: string; name: string; sha: string; ref: string }, env: Environment | null) {
  // A deploy job already says whether it waited and who approved it.
  let log = job.log ?? "";
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
    const secrets = loadSecrets(repoId, wanted, env?.id ?? null);
    if (env) append(`▶ Deploying to ${env.name}${job.url ? ` (${job.url})` : ""}\n`);
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
      // The image decides what `sh` and `id` do here, so this runs like every other call: async and with a timeout.
      const who = await collect(runtime, ["exec", box.name, "sh", "-c", 'echo "$(id -u):$(id -g)"'], 30_000);
      // stdout and stderr arrive together, so pick out the uid:gid line.
      const owner = who.code === 0 ? (/^(\d+:\d+)$/m.exec(who.output)?.[1] ?? null) : null;
      if (owner && owner !== "0:0" && (await cli(runtime, chownWorkspaceArgs(box.name, owner), append, 5 * 60_000)) !== 0)
        append(`Could not hand /workspace to the image's user ${owner}; steps may not be able to write to it\n`);
      append("\n");
    }

    for (const step of steps) {
      if (currentStatus(job.runId) === "cancelled") break;
      append(`▶ ${step.name}\n`);
      save();
      const started = Date.now();
      const vars = { ...ciVars(ctx), ...(env ? { CI_ENVIRONMENT: env.name } : {}), ...resolveEnv(step.env, secrets) };
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
  // Environments a job names are created on first use.
  const envs = new Map(jobs.flatMap((j) => (j.environment ? [[j.environment.name, ensureEnvironment(repoId, j.environment.name)] as const] : [])));
  const id = db.transaction((tx) => {
    const run = tx.insert(ciRun).values({ repoId, sha, ref, actorId, status: "queued" }).returning({ id: ciRun.id }).get();
    for (const j of jobs) {
      const job = tx
        .insert(ciJob)
        .values({ runId: run.id, name: j.name, image: j.image, environment: j.environment?.name ?? null, url: j.environment?.url ?? null, steps: JSON.stringify(j.steps), status: "queued" as const })
        .returning({ id: ciJob.id })
        .get();
      if (j.environment)
        tx.insert(deployment).values({ repoId, environmentId: envs.get(j.environment.name)!.id, runId: run.id, jobId: job.id, sha, ref, actorId, status: "queued", url: j.environment.url }).run();
    }
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
  if (s !== "queued" && s !== "running" && s !== "waiting") return false;
  db.update(ciRun).set({ status: "cancelled", finishedAt: new Date() }).where(eq(ciRun.id, runId)).run();
  if (running?.runId === runId) {
    running.proc?.kill();
    // Killing the CLI doesn't stop what it started inside the container.
    if (running.container) void removeContainer(running.container.runtime, running.container.name);
    return true;
  }
  // Not running: nothing else will mark its jobs and deployments.
  db.update(ciJob).set({ status: "cancelled" }).where(and(eq(ciJob.runId, runId), inArray(ciJob.status, ["queued", "waiting"]))).run();
  cancelDeployments(runId);
  for (const j of db.select({ id: ciJob.id }).from(ciJob).where(eq(ciJob.runId, runId)).all()) clearTimeout(timers.get(j.id)), timers.delete(j.id);
  return true;
}

// The newest run for a commit, which is what pull requests show as their checks.
export const latestRun = (repoId: number, sha: string) =>
  db.select().from(ciRun).where(and(eq(ciRun.repoId, repoId), eq(ciRun.sha, sha))).orderBy(desc(ciRun.id)).get() ?? null;

// Runs interrupted by a restart can't resume mid-step; queued ones simply continue.
// Containers of this server's jobs that a crash or restart interrupted; another Ether's on the same daemon stay.
// Async and with timeouts, so a slow or wedged daemon can't hold up the server's start.
async function removeLeftoverContainers() {
  const runtime = containerRuntime();
  if (!runtime) return;
  const list = await collect(runtime, ["ps", "--all", "--quiet", "--filter", "label=ether.ci=1", "--filter", `label=ether.ci.instance=${instance()}`], 30_000);
  const ids = list.code === 0 ? list.output.split(/\s+/).filter(Boolean) : [];
  if (ids.length) await collect(runtime, ["rm", "--force", ...ids], 60_000);
}

export function resumeQueue() {
  db.update(ciRun).set({ status: "error", message: "Ether restarted while this run was in progress", finishedAt: new Date() }).where(eq(ciRun.status, "running")).run();
  db.update(ciJob).set({ status: "cancelled" }).where(eq(ciJob.status, "running")).run();
  db.update(deployment).set({ status: "cancelled", finishedAt: new Date() }).where(eq(deployment.status, "in_progress")).run();
  // Deploy jobs waiting on a timer pick it up again; those waiting for a reviewer just keep waiting.
  for (const j of db.select({ id: ciJob.id, notBefore: ciJob.notBefore }).from(ciJob).where(eq(ciJob.status, "waiting")).all()) if (j.notBefore) wakeAt(j.id, j.notBefore);
  // In the background so a slow daemon doesn't hold up the server's start; drain() waits for it, also
  // when a push queues a run meanwhile, since the sweep would match that job's container too.
  sweep = removeLeftoverContainers().catch((e) => console.error("Removing leftover CI containers failed:", e));
  void drain();
}
