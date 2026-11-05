import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import { resolve } from "node:path";
import { removeLeftoverContainers, startJob } from "../runner/execute";
import type { Claim, Isolation, JobAssignment, JobResult, RunningJob } from "../runner/protocol";
import { secret, sha256 } from "./access";
import { instanceLabel } from "./ci-container";
import { loadSecrets } from "./ci-secrets";
import { conditionHolds, matrixEnvName, type MatrixValues, type NeedStatus } from "./ci-graph";
import { inputEnvName, resolveInputs, starts, type PullAction, type Trigger } from "./ci-triggers";
import { isWorkflowFile, MAX_WORKFLOWS, parseWorkflow, WORKFLOW, WORKFLOW_DIR, defaultWorkflowName, type EnvValue, type ParsedWorkflow, type Step } from "./ci-workflow";
import { config } from "./config";
import { db } from "./db/client";
import { ciJob, ciRun, ciRunner, deployment, instanceSetting, issue, repo, user } from "./db/schema";
import { cancelDeployments, deploymentOfJob, ensureEnvironment, environmentOfJob, reviewerIds, rulesOf, setDeployment, type Environment } from "./deploy";
import { gate } from "./deploy-rules";
import { record } from "./events";
import * as git from "./git";
import { LogMasker } from "./log-mask";

// CI runs workflows from .ether/workflows/*.yml (and the older .ether/ci.yml) when what their `on:`
// names happens: a push, a pull request or someone starting one by hand. It is opt-in twice: an admin allows it for the server,
// and an owner turns it on per repository. This file decides what runs when; a runner (see
// ../runner/execute.ts) does the running, from an assignment that holds all it needs. By default each job
// runs in its own container and sees nothing of the server; an admin can instead let jobs run on the host
// as Ether's own user, which gives every writer the server.
// Repository secrets are only ever passed to container jobs. A job that names an environment is a
// deployment (see deploy.ts): it may first have to wait for a reviewer or a timer, which it does outside
// the queue, so other runs go on meanwhile.

const MAX_LOG = 1024 * 1024;

const setting = (key: string) => db.select().from(instanceSetting).where(eq(instanceSetting.key, key)).get()?.value;
export const ciAllowed = () => setting("ciEnabled") === "true";
// Containers unless an admin chose the host explicitly.
export const ciIsolation = (): Isolation => (setting("ciIsolation") === "host" ? "host" : "container");

type Run = typeof ciRun.$inferSelect;

// What every step of a run is told about it; a manual run's inputs come as CI_INPUT_<NAME>.
function ciVars(run: Run, owner: string, name: string): Record<string, string> {
  const inputs = Object.entries(JSON.parse(run.inputs) as Record<string, string>).map(([k, v]) => [inputEnvName(k), v]);
  return {
    CI: "true",
    CI_REPOSITORY: `${owner}/${name}`,
    CI_COMMIT_SHA: run.sha,
    CI_REF: run.ref,
    CI_REF_TYPE: run.refType,
    CI_EVENT: run.event,
    CI_WORKFLOW: run.workflowName,
    ...(run.pullNumber !== null ? { CI_PULL_REQUEST: String(run.pullNumber), CI_BASE_REF: pullBase(run) ?? "" } : {}),
    ...Object.fromEntries(inputs),
  };
}

const pullBase = (run: Run) =>
  run.pullNumber === null ? null : (db.select({ base: issue.baseRef }).from(issue).where(and(eq(issue.repoId, run.repoId), eq(issue.number, run.pullNumber))).get()?.base ?? null);

const secretNames = (steps: Step[]) => [...new Set(steps.flatMap((s) => Object.values(s.env ?? {}).flatMap((v) => (typeof v === "string" ? [] : [v.secret]))))];
const resolveEnv = (env: Record<string, EnvValue> | undefined, secrets: Map<string, string>) =>
  Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : secrets.get(v.secret)!]));

const instance = () => instanceLabel(resolve(config.dataDir));

// ---------- scheduler ----------

type Job = typeof ciJob.$inferSelect;
// Jobs run side by side up to this many at a time, across all runs; each container job gets its own
// ETHER_CI_MEMORY and ETHER_CI_CPUS.
const MAX_ACTIVE = Math.max(1, Math.floor(Number(process.env.ETHER_CI_JOBS) || 2));
// A running job: its runner's handle, so it can be stopped, and whether it was told to stop.
type Active = { runId: number; job: RunningJob | null; stopped: boolean };
const active = new Map<number, Active>();
// A job on an external runner, which is told to stop the next time it reports. Its token lives only here, so
// it ends with the job or with this process, and a runner told "no such job" stops working on it.
type RemoteJob = Active & { job: null; row: Job; begun: Begun; runnerId: number; runnerName: string; repoId: number; tokenHash: string; seen: number; masker: LogMasker; log: JobLog };
const remote = new Map<number, RemoteJob>();
const DONE = new Set<Job["status"]>(["success", "failure", "error", "cancelled", "skipped"]);
const FINISHED_RUN = new Set<Run["status"]>(["success", "failure", "cancelled", "error"]);

// The startup sweep of leftover containers; nothing may start a job until it's done (see resumeQueue).
let sweep: Promise<void> = Promise.resolve();
let swept = true;

// Starts every job that may start, oldest first, while there's room. Called whenever a job is queued or finishes.
function pump() {
  // The sweep selects by label, which a job started now would share, so it has to finish first.
  if (!swept) return void sweep.then(() => ((swept = true), pump()));
  // Once a runner is registered, jobs wait for runners, even if none is online right now; a job that may
  // use secrets or deploy shouldn't land on this machine just because a runner is restarting.
  if (usesRunners()) return;
  while (active.size < MAX_ACTIVE) {
    const job = nextJob();
    if (!job) return;
    void runJob(job)
      .catch((e) => console.error(`CI job ${job.id} failed to run:`, e))
      .finally(pump);
  }
}

const runJobs = (runId: number) => db.select().from(ciJob).where(eq(ciJob.runId, runId)).orderBy(asc(ciJob.id)).all();
// The jobs a job waits for. Jobs queued before jobs had needs (key "") ran one after another, whatever
// the one before did, so they keep waiting for every earlier job of their run.
const needed = (job: Job, all: Job[]) => {
  if (!job.key) return all.filter((j) => j.id < job.id);
  const needs = JSON.parse(job.needs) as string[];
  return all.filter((j) => needs.includes(j.key));
};

// Every job a job comes after: its needs, theirs, and so on.
function ancestorsOf(job: Job, all: Job[]) {
  const seen = new Map<number, Job>();
  const visit = (j: Job) => needed(j, all).forEach((d) => !seen.has(d.id) && (seen.set(d.id, d), visit(d)));
  visit(job);
  return [...seen.values()];
}

// One deployment per environment at a time, in push order: two runs deploying to production at once could
// finish out of order and leave the older commit live. So a deploy job also waits while an older run of the
// same ref still has its deploy job for the environment queued behind that job's needs; otherwise a newer
// run whose build finished first would deploy, and the older one after it. Older jobs that wait for a review
// or a timer don't hold it back (nobody may ever approve them): it supersedes them once it starts.
type RunRef = Pick<Run, "id" | "repoId" | "ref" | "refType">;
const deploying = (run: RunRef, environment: string) =>
  !!db
    .select({ id: ciJob.id })
    .from(ciJob)
    .innerJoin(ciRun, eq(ciRun.id, ciJob.runId))
    .where(
      and(
        eq(ciRun.repoId, run.repoId),
        eq(ciJob.environment, environment),
        or(
          eq(ciJob.status, "running"),
          and(lt(ciJob.runId, run.id), eq(ciRun.ref, run.ref), eq(ciRun.refType, run.refType), eq(ciJob.status, "queued"), inArray(ciRun.status, ["queued", "running", "waiting"])),
        ),
      ),
    )
    .get();

// Older runs' deploy jobs of the same ref that wait for a review or a timer, once a newer one deploys: going
// ahead later would put the older commit back.
function supersede(run: RunRef, environment: string) {
  const older = db
    .select({ job: ciJob })
    .from(ciJob)
    .innerJoin(ciRun, eq(ciRun.id, ciJob.runId))
    .where(and(eq(ciRun.repoId, run.repoId), eq(ciJob.environment, environment), eq(ciJob.status, "waiting"), lt(ciJob.runId, run.id), eq(ciRun.ref, run.ref), eq(ciRun.refType, run.refType)))
    .all()
    .map((r) => r.job);
  for (const job of older) {
    clearTimeout(timers.get(job.id));
    timers.delete(job.id);
    // Its deployment stays, cancelled, so the environment's history shows it was waiting and why it ended.
    db.update(ciJob).set({ status: "skipped", log: `${job.log}Skipped: a newer run of ${run.ref} deploys to ${environment}.\n`, finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
    setDeployment(job.id, { status: "cancelled", finishedAt: new Date() });
    void refreshRun(job.runId);
  }
}

// The oldest queued job whose needs have all finished and whose if: holds. Jobs whose if: doesn't hold are
// skipped on the way, which can free others, so it looks again until it finds one or nothing changes.
function nextJob(): Job | null {
  for (;;) {
    const queued = db
      .select({ job: ciJob })
      .from(ciJob)
      .innerJoin(ciRun, eq(ciRun.id, ciJob.runId))
      .where(and(eq(ciJob.status, "queued"), inArray(ciRun.status, ["queued", "running", "waiting"])))
      .orderBy(asc(ciJob.id))
      .all()
      .map((r) => r.job);
    const byRun = new Map<number, Job[]>();
    let skipped = false;
    for (const job of queued) {
      const all = byRun.get(job.runId) ?? byRun.set(job.runId, runJobs(job.runId)).get(job.runId)!;
      const deps = needed(job, all);
      if (deps.some((d) => !DONE.has(d.status))) continue;
      const ancestors = ancestorsOf(job, all);
      if (job.key && !conditionHolds(job.condition, deps.map((d) => d.status as NeedStatus), ancestors.map((d) => d.status as NeedStatus))) {
        // When the direct needs succeeded, it was a job further up that failed; name that one.
        const failed = deps.filter((d) => d.status !== "success").map((d) => d.name);
        const why = failed.length ? failed : ancestors.filter((d) => d.status === "failure" || d.status === "error").map((d) => d.name);
        skipJob(job, job.condition ? `if: ${job.condition} is false` : `${why.join(", ")} didn't succeed`);
        skipped = true;
        break;
      }
      if (job.maxParallel && all.filter((j) => j.key === job.key && j.status === "running").length >= job.maxParallel) continue;
      if (job.environment) {
        const run = db.select({ id: ciRun.id, repoId: ciRun.repoId, ref: ciRun.ref, refType: ciRun.refType }).from(ciRun).where(eq(ciRun.id, job.runId)).get();
        if (!run || deploying(run, job.environment)) continue;
      }
      return job;
    }
    if (!skipped) return null;
  }
}

function skipJob(job: Job, why: string) {
  db.update(ciJob).set({ status: "skipped", log: `${job.log}Skipped: ${why}.\n`, finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
  // Nothing was deployed, so there is no deployment to keep either.
  if (job.environment) db.delete(deployment).where(eq(deployment.jobId, job.id)).run();
  void refreshRun(job.runId);
}

type Begun = { run: Run; owner: string; name: string; env: Environment | null };

// Takes a job the scheduler picked and marks it running, or settles it if it can't start (a deploy job that has
// to wait or is turned down). All synchronous, so pump() and claimJob() see it as taken before they look again.
function beginJob(job: Job): Begun | null {
  const run = db.select().from(ciRun).where(eq(ciRun.id, job.runId)).get();
  const r = run && db.select({ repo, owner: user.username }).from(repo).innerJoin(user, eq(user.id, repo.ownerId)).where(eq(repo.id, run.repoId)).get();
  if (!run || !r) return null;
  const env = environmentOfJob(job, r.repo.id);
  // Its environment was deleted since the push: don't run it as a plain job with none of the rules.
  if (job.environment && !env) {
    endWaitingJob(job, `✖ Not deployed: the environment ${job.environment} no longer exists.`);
    void refreshRun(run.id);
    return null;
  }
  if (env && !admit(job, env, run)) {
    void refreshRun(run.id);
    return null;
  }
  db.update(ciRun).set({ status: "running", startedAt: run.startedAt ?? new Date() }).where(and(eq(ciRun.id, run.id), inArray(ciRun.status, ["queued", "waiting", "running"]))).run();
  if (env) {
    setDeployment(job.id, { status: "in_progress" });
    supersede(run, env.name);
  }
  db.update(ciJob).set({ status: "running", startedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
  return { run, owner: r.owner!, name: r.repo.name, env };
}

type JobLog = { text: () => string; append: (text: string) => void };

// A deploy job already says whether it waited and who approved it.
function jobLog(job: Job): JobLog {
  let log = job.log ?? "";
  return {
    text: () => log,
    append(text) {
      if (log.length >= MAX_LOG) return;
      log += text.slice(0, MAX_LOG - log.length);
      db.update(ciJob).set({ log }).where(eq(ciJob.id, job.id)).run();
    },
  };
}

async function runJob(job: Job) {
  const begun = beginJob(job);
  if (!begun) return;
  const a: Active = { runId: begun.run.id, job: null, stopped: false };
  active.set(job.id, a);
  const log = jobLog(job);
  let result: JobResult = "error";
  try {
    const assignment = assignmentFor(job, begun, ciIsolation(), git.repoPath(begun.owner, begun.name), " An admin can switch CI to containers under Admin → Access.");
    if (typeof assignment === "string") log.append(`${assignment}\n`);
    else {
      if (begun.env) log.append(`▶ Deploying to ${begun.env.name}${job.url ? ` (${job.url})` : ""}\n`);
      a.job = startJob(assignment, { log: log.append }, instance());
      result = await a.job.done;
    }
  } catch (e) {
    log.append(`\nRunner error: ${(e as Error).message}\n`);
  }
  await finishJob(job, begun, a, result, log.text(), () => active.delete(job.id));
}

// What's left once a runner is done with a job: its status, its deployment, fail-fast and its run.
async function finishJob(job: Job, { run, env }: Begun, a: Active, result: JobResult, log: string, release: () => void) {
  const cancelled = a.stopped || result === "cancelled" || currentStatus(run.id) === "cancelled";
  db.update(ciJob).set({ log, status: cancelled ? "cancelled" : result === "success" ? "success" : "failure", finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
  release();
  const stopped = cancelled;
  if (env && !stopped) setDeployment(job.id, { status: result === "success" ? "success" : "failure", finishedAt: new Date() });
  if (env && stopped) setDeployment(job.id, { status: "cancelled", finishedAt: new Date() });
  // fail-fast: one combination of a matrix failing stops the others.
  if (result !== "success" && !stopped && job.failFast && job.key) {
    for (const sib of runJobs(run.id).filter((j) => j.key === job.key && j.id !== job.id && j.matrix !== "{}")) {
      if (sib.status === "queued" || sib.status === "waiting") {
        clearTimeout(timers.get(sib.id));
        timers.delete(sib.id);
        db.update(ciJob).set({ status: "cancelled", log: `${sib.log}Cancelled: ${job.name} failed (fail-fast).\n`, finishedAt: new Date() }).where(eq(ciJob.id, sib.id)).run();
        if (sib.environment) setDeployment(sib.id, { status: "cancelled", finishedAt: new Date() });
      }
      const other = active.get(sib.id) ?? remote.get(sib.id);
      if (other) stop(other);
    }
  }
  await refreshRun(run.id);
}

function stop(a: Active) {
  a.stopped = true;
  a.job?.stop();
}

// When Ether stops: host steps run in their own process group, so a signal to Ether no longer reaches them;
// stop them rather than let a deploy script carry on after the server that tracks it is gone.
export function stopAllJobs() {
  for (const a of active.values()) stop(a);
}

// Ids of the queued jobs that can't start before a waiting deploy job finishes, directly or through other jobs.
function blockedByWaiting(jobs: Job[]) {
  const blocked = new Set(jobs.filter((j) => j.status === "waiting").map((j) => j.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const j of jobs)
      if (j.status === "queued" && !blocked.has(j.id) && needed(j, jobs).some((d) => blocked.has(d.id))) blocked.add(j.id), (grew = true);
  }
  return blocked;
}

// A run's status from its jobs: running while any job runs, queued while one can still start, waiting while
// what's left waits for a deploy review or timer, and otherwise finished. Safe to call any time.
async function refreshRun(runId: number) {
  const run = db.select().from(ciRun).where(eq(ciRun.id, runId)).get();
  if (!run) return;
  const jobs = runJobs(runId);
  if (run.status === "cancelled") {
    db.update(ciJob).set({ status: "cancelled" }).where(and(eq(ciJob.runId, runId), inArray(ciJob.status, ["queued", "waiting"]))).run();
    cancelDeployments(runId);
    if (!jobs.some((j) => active.has(j.id) || remote.has(j.id))) db.update(ciRun).set({ finishedAt: run.finishedAt ?? new Date() }).where(eq(ciRun.id, runId)).run();
    return;
  }
  if (FINISHED_RUN.has(run.status)) return;
  const blocked = blockedByWaiting(jobs);
  const status: Run["status"] = jobs.some((j) => j.status === "running")
    ? "running"
    : jobs.some((j) => j.status === "queued" && !blocked.has(j.id))
      ? "queued"
      : jobs.some((j) => j.status === "waiting")
        ? "waiting"
        : jobs.every((j) => j.status === "success" || j.status === "skipped")
          ? "success"
          : "failure";
  if (!FINISHED_RUN.has(status)) return void db.update(ciRun).set({ status }).where(and(eq(ciRun.id, runId), inArray(ciRun.status, ["queued", "running", "waiting"]))).run();
  // Only the call that finishes the run reports it.
  const done = db
    .update(ciRun)
    .set({ status, finishedAt: new Date() })
    .where(and(eq(ciRun.id, runId), inArray(ciRun.status, ["queued", "running", "waiting"])))
    .returning({ id: ciRun.id })
    .all();
  if (status !== "failure" || done.length === 0) return;
  // "Checks failed" is news when something broke, not when a reviewer turned a deployment down on purpose.
  const rejected = new Set(db.select({ jobId: deployment.jobId }).from(deployment).where(and(eq(deployment.runId, runId), eq(deployment.status, "rejected"))).all().map((d) => d.jobId));
  if (!jobs.some((j) => (j.status === "failure" || j.status === "error") && !rejected.has(j.id))) return;
  const r = db.select({ owner: user.username, name: repo.name }).from(repo).innerJoin(user, eq(user.id, repo.ownerId)).where(eq(repo.id, run.repoId)).get();
  if (r) await reportFailure(run, git.repoPath(r.owner!, r.name), "failure");
}

// Whether a deploy job may start now. If not, it waits (for a reviewer or until its timer runs out) or is turned down.
function admit(job: typeof ciJob.$inferSelect, env: Environment, run: typeof ciRun.$inferSelect): boolean {
  const d = deploymentOfJob(job.id);
  const review = d?.reviewedAt ? { approved: d.status !== "rejected", at: d.reviewedAt } : null;
  const g = gate(rulesOf(env), run.ref, review, run.createdAt, new Date(), run.refType);
  if (g.action === "run") return true;
  if (g.action === "skip") {
    // Nothing was deployed, so there is no deployment to keep either.
    db.update(ciJob).set({ status: "skipped", log: `${job.log}Skipped: ${g.reason} (${env.name}).\n`, startedAt: job.startedAt ?? new Date(), finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
    db.delete(deployment).where(eq(deployment.jobId, job.id)).run();
    return false;
  }
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

// ---------- waiting deploy jobs ----------

// Fails a deploy job that can't go ahead any more.
function endWaitingJob(job: typeof ciJob.$inferSelect, why: string) {
  clearTimeout(timers.get(job.id));
  timers.delete(job.id);
  db.update(ciJob).set({ status: "failure", log: `${job.log}${why}\n`, startedAt: job.startedAt ?? new Date(), finishedAt: new Date() }).where(eq(ciJob.id, job.id)).run();
  setDeployment(job.id, { status: "cancelled", finishedAt: new Date() });
}

const waitingFor = (repoId: number, environmentName: string) =>
  db
    .select({ job: ciJob })
    .from(ciJob)
    .innerJoin(ciRun, eq(ciRun.id, ciJob.runId))
    .where(and(eq(ciRun.repoId, repoId), eq(ciJob.environment, environmentName), eq(ciJob.status, "waiting")))
    .all()
    .map((r) => r.job);

// After an environment's rules change, its waiting deploy jobs are checked again: without reviewers or a
// timer they go ahead, and with new ones they wait for those instead of for people who may no longer review.
// Approved jobs waiting on a timer are included, so a shorter, longer or removed timer applies to them too.
export function reconsiderEnvironment(repoId: number, environmentName: string) {
  for (const job of waitingFor(repoId, environmentName)) requeue(job.id);
}

// Before an environment is deleted: its waiting deploy jobs fail instead of waiting for good.
export async function abandonEnvironment(repoId: number, environmentName: string) {
  const runs = new Set<number>();
  for (const job of waitingFor(repoId, environmentName)) {
    endWaitingJob(job, `✖ Not deployed: the environment ${environmentName} was deleted.`);
    runs.add(job.runId);
  }
  // Jobs that needed them are skipped now, and their runs may be done.
  pump();
  for (const runId of runs) await refreshRun(runId);
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();

// Puts a waiting job (and its run) back in the queue.
function requeue(jobId: number) {
  clearTimeout(timers.get(jobId));
  timers.delete(jobId);
  const job = db.select().from(ciJob).where(eq(ciJob.id, jobId)).get();
  // Only a run that is still going can take the job back; an errored or cancelled one is over.
  const runStatus = job ? currentStatus(job.runId) : undefined;
  if (!job || job.status !== "waiting" || (runStatus !== "waiting" && runStatus !== "running" && runStatus !== "queued")) return;
  db.update(ciJob).set({ status: "queued", notBefore: null }).where(eq(ciJob.id, jobId)).run();
  void refreshRun(job.runId);
  pump();
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
  pump();
  await refreshRun(run.id);
}

// Failed checks go into the feed of whoever started the run.
async function reportFailure(run: { id: number; repoId: number; sha: string; ref: string; actorId: string | null }, path: string, status: string) {
  if (!run.actorId) return;
  const [commit] = await git.log(path, run.sha, { limit: 1 }).catch(() => []);
  record(run.repoId, run.actorId, "ci_failed", { runId: run.id, ref: run.ref, sha: run.sha, subject: commit?.subject ?? "", status });
}

const currentStatus = (runId: number) => db.select({ s: ciRun.status }).from(ciRun).where(eq(ciRun.id, runId)).get()?.s;

// All a runner needs for a job, secrets filled in, or why the job can't have one.
function assignmentFor(job: Job, { run, owner, name, env }: Begun, isolation: Isolation, checkoutUrl: string, hostHint: string): JobAssignment | string {
  const steps = JSON.parse(job.steps) as Step[];
  const wanted = secretNames(steps);
  if (wanted.length && isolation === "host") return `This job uses secrets (${wanted.join(", ")}), which are only passed to jobs that run in containers.${hostHint}`;
  const secrets = loadSecrets(run.repoId, wanted, env?.id ?? null);
  const matrix = Object.entries(JSON.parse(job.matrix) as MatrixValues).map(([k, v]) => [matrixEnvName(k), v]);
  return {
    jobId: job.id,
    runId: run.id,
    isolation,
    image: job.image,
    checkout: { url: checkoutUrl, sha: run.sha },
    vars: { ...ciVars(run, owner, name), CI_JOB: job.key || job.name, ...Object.fromEntries(matrix), ...(env ? { CI_ENVIRONMENT: env.name } : {}) },
    mask: [...secrets.values()],
    steps: steps.map((s) => ({ name: s.name, run: s.run, shell: s.shell, timeoutMinutes: s.timeoutMinutes, env: resolveEnv(s.env, secrets) })),
  };
}

// ---------- external runners ----------

export const resumePump = () => pump();

export const usesRunners = () => !!db.select({ id: ciRunner.id }).from(ciRunner).get();
// A runner that hasn't reported for this long has lost the job it was running.
const RUNNER_TIMEOUT = Math.max(1, Number(process.env.ETHER_CI_RUNNER_TIMEOUT) || 90) * 1000;
export const RUNNER_ONLINE_MS = RUNNER_TIMEOUT;
export const JOB_GIT_USER = "ether-job";

// Hands the oldest job that may start to a runner, or null when there's none.
export function claimJob(runner: { id: number; name: string }, isolation: Isolation): Claim | null {
  for (;;) {
    const job = nextJob();
    if (!job) return null;
    const begun = beginJob(job);
    if (!begun) continue;
    const log = jobLog(job);
    db.update(ciJob).set({ runner: runner.name }).where(eq(ciJob.id, job.id)).run();
    const a: Active = { runId: begun.run.id, job: null, stopped: false };
    try {
      const assignment = assignmentFor(job, begun, isolation, `/${begun.owner}/${begun.name}.git`, ` Runner ${runner.name} runs jobs on its host.`);
      if (typeof assignment === "string") {
        log.append(`${assignment}\n`);
        void finishJob(job, begun, a, "error", log.text(), () => {}).finally(pump);
        continue;
      }
      if (begun.env) log.append(`▶ Deploying to ${begun.env.name}${job.url ? ` (${job.url})` : ""}\n`);
      const token = secret("ethj_");
      remote.set(job.id, { ...a, job: null, row: job, begun, runnerId: runner.id, runnerName: runner.name, repoId: begun.run.repoId, tokenHash: sha256(token), seen: Date.now(), masker: new LogMasker(assignment.mask), log });
      assignment.checkout.authorization = `Basic ${btoa(`${JOB_GIT_USER}:${token}`)}`;
      return { assignment, token };
    } catch (e) {
      log.append(`\nRunner error: ${(e as Error).message}\n`);
      void finishJob(job, begun, a, "error", log.text(), () => {}).finally(pump);
    }
  }
}

// The job a job token is for, while the job runs.
export function remoteJob(jobId: number, token: string): RemoteJob | null {
  const job = remote.get(jobId);
  return job && job.tokenHash === sha256(token) ? job : null;
}

// Whether a job token may read this repository: the one its job is from, and only while it runs.
export function jobMayRead(token: string, repoId: number) {
  const hash = sha256(token);
  return [...remote.values()].some((j) => j.tokenHash === hash && j.repoId === repoId);
}

// A runner's report. The runner masks too; this is in case it's an older or a broken one.
export function reportJob(job: RemoteJob, text: string) {
  job.seen = Date.now();
  if (text) job.log.append(job.masker.push(text));
  return { stop: job.stopped };
}

export async function finishRemoteJob(job: RemoteJob, result: JobResult) {
  job.log.append(job.masker.flush());
  await finishJob(job.row, job.begun, job, result, job.log.text(), () => remote.delete(job.row.id));
  pump();
}

// Jobs of a runner that's gone: removed by an admin, or silent for too long.
export async function abandonRemoteJobs(match: (job: RemoteJob) => boolean, why: (job: RemoteJob) => string) {
  for (const job of [...remote.values()].filter(match)) {
    job.log.append(`\n✖ ${why(job)}\n`);
    await finishRemoteJob(job, "error");
  }
}

const expireRemoteJobs = () =>
  abandonRemoteJobs(
    (j) => Date.now() - j.seen > RUNNER_TIMEOUT,
    (j) => `Lost contact with runner ${j.runnerName}`,
  ).catch((e) => console.error("Ending jobs of silent runners failed:", e));

// ---------- triggers ----------

const ciOn = (repoId: number) => !!db.select({ on: repo.ciEnabled }).from(repo).where(eq(repo.id, repoId)).get()?.on && ciAllowed();

type WorkflowFile = { path: string; content: string };

// A commit's workflows: .ether/ci.yml and the first MAX_WORKFLOWS files in .ether/workflows (not its subfolders, as on GitHub).
export async function workflowFiles(repoPath: string, sha: string): Promise<WorkflowFile[]> {
  const entries = (await git.readTree(repoPath, sha, WORKFLOW_DIR).catch(() => null)) ?? [];
  const paths = [WORKFLOW, ...entries.filter((e) => e.type === "blob" && isWorkflowFile(e.name)).map((e) => e.path).slice(0, MAX_WORKFLOWS)];
  const files = await Promise.all(paths.map(async (path) => ({ path, content: (await git.readBlob(repoPath, sha, path).catch(() => null))?.content })));
  return files.filter((f): f is WorkflowFile => typeof f.content === "string" && f.content.length > 0);
}

export const isWorkflowPath = (path: string) => path === WORKFLOW || (path.startsWith(`${WORKFLOW_DIR}/`) && isWorkflowFile(path.slice(WORKFLOW_DIR.length + 1)));

type RunMeta = { ref: string; refType: Run["refType"]; event: Run["event"]; pullNumber: number | null; inputs: Record<string, string> };

function createRun(repoId: number, sha: string, actorId: string | null, path: string, wf: ParsedWorkflow, meta: RunMeta): number {
  // Environments a job names are created on first use.
  const envs = new Map(wf.jobs.flatMap((j) => (j.environment ? [[j.environment.name, ensureEnvironment(repoId, j.environment.name)] as const] : [])));
  return db.transaction((tx) => {
    const run = tx
      .insert(ciRun)
      .values({ repoId, sha, actorId, status: "queued", workflowPath: path, workflowName: wf.name, ...meta, inputs: JSON.stringify(meta.inputs) })
      .returning({ id: ciRun.id })
      .get();
    for (const j of wf.jobs) {
      const job = tx
        .insert(ciJob)
        .values({
          runId: run.id,
          key: j.key,
          name: j.name,
          needs: JSON.stringify(j.needs),
          condition: j.condition,
          matrix: JSON.stringify(j.matrix),
          failFast: j.failFast,
          maxParallel: j.maxParallel,
          image: j.image,
          environment: j.environment?.name ?? null,
          url: j.environment?.url ?? null,
          steps: JSON.stringify(j.steps),
          status: "queued" as const,
        })
        .returning({ id: ciJob.id })
        .get();
      if (j.environment)
        tx.insert(deployment).values({ repoId, environmentId: envs.get(j.environment.name)!.id, runId: run.id, jobId: job.id, sha, ref: meta.ref, actorId, status: "queued", url: j.environment.url }).run();
    }
    return run.id;
  });
}

// A workflow file that doesn't parse becomes a run that errored, so its author sees why nothing ran.
async function erroredRun(repoId: number, repoPath: string, sha: string, actorId: string | null, path: string, message: string, meta: RunMeta) {
  const values = { repoId, sha, actorId, status: "error" as const, message, finishedAt: new Date(), workflowPath: path, workflowName: defaultWorkflowName(path), ...meta, inputs: JSON.stringify(meta.inputs) };
  const id = db.insert(ciRun).values(values).returning({ id: ciRun.id }).get().id;
  await reportFailure({ id, repoId, sha, ref: meta.ref, actorId }, repoPath, "error");
  return id;
}

// Starts each of the commit's workflows whose `on:` takes this trigger. A file that doesn't parse is
// reported on pushes only: it can't say which events it wanted, and a pull request would repeat the push's error.
async function startWorkflows(repoId: number, repoPath: string, sha: string, trigger: Trigger, meta: RunMeta, actorId: string | null): Promise<number[]> {
  if (!ciOn(repoId)) return [];
  const ids: number[] = [];
  for (const file of await workflowFiles(repoPath, sha)) {
    let wf: ParsedWorkflow;
    try {
      wf = parseWorkflow(file.content, file.path);
    } catch (e) {
      if (trigger.event === "push") ids.push(await erroredRun(repoId, repoPath, sha, actorId, file.path, (e as Error).message, meta));
      continue;
    }
    if (starts(wf.on, trigger)) ids.push(createRun(repoId, sha, actorId, file.path, wf, meta));
  }
  pump();
  return ids;
}

const MAX_CHANGED = 1000;
const MAX_TAGS_PER_PUSH = 3;

// The files a push or pull request changes, for path filters; null when there are too many or git can't tell, which lets every filter through.
async function changedFiles(repoPath: string, range: string[]): Promise<string[] | null> {
  const res = await git.git(repoPath, ["diff", "--name-only", "-z", "--no-renames", "--end-of-options", ...range]);
  if (res.code !== 0) return null;
  const files = new TextDecoder().decode(res.stdout).split("\0").filter(Boolean);
  return files.length > MAX_CHANGED ? null : files;
}

// A new branch changed what it has beyond the default branch; the default branch's own first push changed everything.
async function newBranchChanges(repoPath: string, branch: string, sha: string) {
  const main = await git.headBranch(repoPath).catch(() => null);
  const mainSha = main && main !== branch ? await git.resolveCommit(repoPath, `refs/heads/${main}`) : null;
  return mainSha ? changedFiles(repoPath, [`${mainSha}...${sha}`]) : null;
}

// After a push, or a merge (which moves the base branch): push workflows for each branch and tag that moved
// to a new commit, and pull_request workflows for open pull requests whose head branch moved.
export async function onPush(repoId: number, repoPath: string, before: git.Ref[], after: git.Ref[], actorId: string) {
  const moved = after.filter((ref) => before.find((b) => b.kind === ref.kind && b.name === ref.name)?.sha !== ref.sha);
  // As on GitHub, pushing more than three tags at once (git push --tags, a mirror) starts nothing for them,
  // rather than queueing a run per tag in front of everyone else's.
  const tagEvents = moved.filter((r) => r.kind === "tag").length <= MAX_TAGS_PER_PUSH;
  for (const ref of moved) {
    const old = before.find((b) => b.kind === ref.kind && b.name === ref.name);
    if (ref.kind === "tag") {
      if (!tagEvents) continue;
      // An annotated tag names a tag object; runs are for the commit it points at.
      const sha = await git.resolveCommit(repoPath, ref.sha);
      if (sha) await startWorkflows(repoId, repoPath, sha, { event: "push", refType: "tag", ref: ref.name, changed: null }, { ref: ref.name, refType: "tag", event: "push", pullNumber: null, inputs: {} }, actorId);
      continue;
    }
    const changed = old ? await changedFiles(repoPath, [old.sha, ref.sha]) : await newBranchChanges(repoPath, ref.name, ref.sha);
    await startWorkflows(repoId, repoPath, ref.sha, { event: "push", refType: "branch", ref: ref.name, changed }, { ref: ref.name, refType: "branch", event: "push", pullNumber: null, inputs: {} }, actorId);
    const pulls = db
      .select({ number: issue.number })
      .from(issue)
      .where(and(eq(issue.repoId, repoId), eq(issue.isPull, true), eq(issue.state, "open"), eq(issue.headRef, ref.name)))
      .all();
    for (const p of pulls) await onPullRequest(repoId, repoPath, p.number, "synchronize", actorId);
  }
}

// When a pull request is opened or reopened, or its head branch moves: its workflows run on the head commit.
export async function onPullRequest(repoId: number, repoPath: string, number: number, action: PullAction, actorId: string) {
  const pr = db.select().from(issue).where(and(eq(issue.repoId, repoId), eq(issue.number, number))).get();
  if (!pr?.isPull || pr.state !== "open" || !pr.headRef || !pr.baseRef) return;
  const [head, base] = await Promise.all([git.resolveCommit(repoPath, `refs/heads/${pr.headRef}`), git.resolveCommit(repoPath, `refs/heads/${pr.baseRef}`)]);
  if (!head) return;
  // What the pull request would bring in: its changes since it left the base branch.
  const changed = base ? await changedFiles(repoPath, [`${base}...${head}`]) : null;
  await startWorkflows(repoId, repoPath, head, { event: "pull_request", action, base: pr.baseRef, changed }, { ref: pr.headRef, refType: "branch", event: "pull_request", pullNumber: number, inputs: {} }, actorId);
}

export class DispatchError extends Error {}

// Someone starts a workflow by hand on a branch, as the workflow is on that branch.
export async function dispatch(repoId: number, repoPath: string, path: string, branch: string, given: Record<string, unknown>, actorId: string): Promise<number> {
  if (!ciOn(repoId)) throw new DispatchError("CI is turned off for this repository");
  if (!isWorkflowPath(path)) throw new DispatchError("No such workflow");
  // A real branch, not a revision such as main~3 that rev-parse would also take.
  const sha = (await git.listRefs(repoPath)).find((r) => r.kind === "branch" && r.name === branch)?.sha;
  if (!sha) throw new DispatchError(`No branch named ${branch}`);
  const file = await git.readBlob(repoPath, sha, path).catch(() => null);
  if (!file?.content) throw new DispatchError(`${branch} has no ${path}`);
  let id: number;
  try {
    const wf = parseWorkflow(file.content, path);
    if (!wf.on.workflow_dispatch) throw new Error(`${wf.name} can't be run by hand on ${branch}: its "on" doesn't include workflow_dispatch`);
    const inputs = resolveInputs(wf.on.workflow_dispatch.inputs, given);
    id = createRun(repoId, sha, actorId, path, wf, { ref: branch, refType: "branch", event: "workflow_dispatch", pullNumber: null, inputs });
  } catch (e) {
    throw new DispatchError((e as Error).message);
  }
  pump();
  return id;
}

// The same workflow for the same commit and event again, as the file is at that commit.
export async function rerun(run: Run, repoPath: string, actorId: string): Promise<number | null> {
  if (!ciOn(run.repoId)) return null;
  const file = await git.readBlob(repoPath, run.sha, run.workflowPath).catch(() => null);
  if (!file?.content) return null;
  const meta: RunMeta = { ref: run.ref, refType: run.refType, event: run.event, pullNumber: run.pullNumber, inputs: JSON.parse(run.inputs) };
  let wf: ParsedWorkflow;
  try {
    wf = parseWorkflow(file.content, run.workflowPath);
  } catch (e) {
    return erroredRun(run.repoId, repoPath, run.sha, actorId, run.workflowPath, (e as Error).message, meta);
  }
  const id = createRun(run.repoId, run.sha, actorId, run.workflowPath, wf, meta);
  pump();
  return id;
}

export function cancel(runId: number) {
  const s = currentStatus(runId);
  if (s !== "queued" && s !== "running" && s !== "waiting") return false;
  db.update(ciRun).set({ status: "cancelled", finishedAt: new Date() }).where(eq(ciRun.id, runId)).run();
  for (const a of [...active.values(), ...remote.values()]) if (a.runId === runId) stop(a);
  // Its running jobs mark themselves cancelled as they stop; the rest are marked here.
  db.update(ciJob).set({ status: "cancelled" }).where(and(eq(ciJob.runId, runId), inArray(ciJob.status, ["queued", "waiting"]))).run();
  cancelDeployments(runId);
  for (const j of db.select({ id: ciJob.id }).from(ciJob).where(eq(ciJob.runId, runId)).all()) clearTimeout(timers.get(j.id)), timers.delete(j.id);
  return true;
}

// A pull request's checks: the newest run of each workflow and event for its head commit. Of pull_request
// runs only its own count; another pull request from the same branch may run other workflows, or none.
// Manual runs aren't checks: someone started them for their own reasons, not to judge the change.
export function commitChecks(repoId: number, sha: string, pullNumber: number) {
  const seen = new Set<string>();
  const runs = db
    .select()
    .from(ciRun)
    .where(and(eq(ciRun.repoId, repoId), eq(ciRun.sha, sha), or(eq(ciRun.event, "push"), and(eq(ciRun.event, "pull_request"), eq(ciRun.pullNumber, pullNumber)))))
    .orderBy(desc(ciRun.id))
    .all()
    .filter((r) => !seen.has(`${r.workflowPath}\0${r.event}`) && !!seen.add(`${r.workflowPath}\0${r.event}`))
    .sort((a, b) => a.workflowName.localeCompare(b.workflowName) || a.event.localeCompare(b.event));
  if (!runs.length) return null;
  const checks = runs.map((r) => ({ id: r.id, workflow: r.workflowName, event: r.event, status: checkStatus(r) }));
  const has = (...s: string[]) => checks.some((c) => s.includes(c.status));
  const status: Run["status"] = has("failure", "error") ? "failure" : has("cancelled") ? "cancelled" : has("running") ? "running" : has("queued") ? "queued" : "success";
  return { status, runs: checks };
}

// A run's result as a pull request's checks: its jobs without the deploy jobs. A deployment waiting for a
// review, skipped, failed or cancelled says nothing about whether the change is good to merge.
export function checkStatus(run: typeof ciRun.$inferSelect): typeof ciRun.$inferSelect.status {
  const all = db.select({ status: ciJob.status, environment: ciJob.environment }).from(ciJob).where(eq(ciJob.runId, run.id)).all();
  const jobs = all.filter((j) => !j.environment);
  // A cancelled or cut-off run passes only if every plain job had already passed; one that never got jobs doesn't.
  if (run.status === "cancelled" || run.status === "error") return all.length && jobs.every((j) => j.status === "success" || j.status === "skipped") ? "success" : run.status;
  if (jobs.some((j) => j.status === "failure" || j.status === "error")) return "failure";
  if (jobs.some((j) => j.status === "queued" || j.status === "running")) return run.status === "queued" ? "queued" : "running";
  return "success";
}

// Runs interrupted by a restart can't resume mid-step; queued ones simply continue.
export function resumeQueue() {
  // Runs a restart cut off end as errored, with everything of them that hadn't finished: their running job,
  // and also queued or waiting deploy jobs, which nothing would pick up again.
  const cutOff = db.select({ id: ciRun.id }).from(ciRun).where(eq(ciRun.status, "running")).all().map((r) => r.id);
  db.update(ciRun).set({ status: "error", message: "Ether restarted while this run was in progress", finishedAt: new Date() }).where(eq(ciRun.status, "running")).run();
  db.update(ciJob).set({ status: "cancelled" }).where(eq(ciJob.status, "running")).run();
  if (cutOff.length) {
    db.update(ciJob).set({ status: "cancelled" }).where(and(inArray(ciJob.runId, cutOff), inArray(ciJob.status, ["queued", "waiting"]))).run();
    for (const id of cutOff) cancelDeployments(id);
  }
  db.update(deployment).set({ status: "cancelled", finishedAt: new Date() }).where(eq(deployment.status, "in_progress")).run();
  // Deploy jobs waiting on a timer pick it up again; those waiting for a reviewer just keep waiting.
  for (const j of db.select({ id: ciJob.id, notBefore: ciJob.notBefore }).from(ciJob).where(eq(ciJob.status, "waiting")).all()) if (j.notBefore) wakeAt(j.id, j.notBefore);
  // In the background so a slow daemon doesn't hold up the server's start; pump() waits for it, also
  // when a push queues a run meanwhile, since the sweep would match that job's container too.
  setInterval(expireRemoteJobs, Math.min(15_000, RUNNER_TIMEOUT / 2)).unref();
  swept = false;
  sweep = removeLeftoverContainers(instance()).catch((e) => console.error("Removing leftover CI containers failed:", e));
  pump();
}
