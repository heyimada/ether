import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, readerOrVisitor, requireRepo, requireUser, type RepoAccess } from "../access";
import { cancel, dispatch, DispatchError, isWorkflowPath, rerun, workflowFiles } from "../ci";
import { deleteSecret, listSecrets, MAX_SECRET, SECRET_NAME_RE, setSecret } from "../ci-secrets";
import { db } from "../db/client";
import { ciJob, ciRun, user } from "../db/schema";
import { parseWorkflow } from "../ci-workflow";
import { EVENTS } from "../ci-triggers";
import { deploymentOfJob, environmentOfJob, reviewerIds } from "../deploy";
import * as git from "../git";

function findRun(a: RepoAccess, id: string) {
  const run = db.select().from(ciRun).where(and(eq(ciRun.id, Number(id)), eq(ciRun.repoId, a.repo.id))).get();
  if (!run) throw new HttpError(404, "No such run");
  return run;
}

// What the run page shows about a deploy job: where it goes, who may approve it, and whether the viewer can.
function deploymentView(job: typeof ciJob.$inferSelect, repoId: number, viewerId: string) {
  const env = environmentOfJob(job, repoId);
  const d = deploymentOfJob(job.id);
  if (!env || !d) return null;
  const reviewers = reviewerIds(env.id);
  const names = (ids: string[]) => (ids.length ? db.select({ username: user.username }).from(user).where(inArray(user.id, ids)).all().map((u) => u.username!) : []);
  return {
    environment: env.name,
    url: d.url,
    status: d.status,
    reviewers: names(reviewers).sort(),
    reviewedBy: d.reviewedBy ? (names([d.reviewedBy])[0] ?? null) : null,
    notBefore: job.notBefore,
    canReview: job.status === "waiting" && !d.reviewedAt && reviewers.includes(viewerId),
  };
}

async function subject(path: string, sha: string) {
  return (await git.log(path, sha, { limit: 1 }).catch(() => []))[0]?.subject ?? "";
}

export const ciRoutes = new Elysia()
  // Newest first; ?workflow=<path> keeps one workflow's runs.
  .get("/repos/:owner/:repo/ci/runs", async ({ request, params, query }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const workflow = typeof query.workflow === "string" && query.workflow ? query.workflow : null;
    const runs = db
      .select()
      .from(ciRun)
      .where(workflow ? and(eq(ciRun.repoId, a.repo.id), eq(ciRun.workflowPath, workflow)) : eq(ciRun.repoId, a.repo.id))
      .orderBy(desc(ciRun.id))
      .limit(50)
      .all();
    return {
      enabled: a.repo.ciEnabled,
      runs: await Promise.all(
        runs.map(async (r) => ({
          ...r,
          subject: await subject(a.path, r.sha),
          jobs: db.select({ name: ciJob.name, status: ciJob.status }).from(ciJob).where(eq(ciJob.runId, r.id)).orderBy(asc(ciJob.id)).all(),
        })),
      ),
    };
  })
  // The default branch's workflows: when they run, what a manual run asks for, or why the file doesn't parse.
  .get("/repos/:owner/:repo/ci/workflows", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const branch = await git.headBranch(a.path).catch(() => null);
    const sha = branch ? await git.resolveCommit(a.path, `refs/heads/${branch}`) : null;
    const files = sha ? await workflowFiles(a.path, sha) : [];
    return {
      branch,
      workflows: files.map((f) => {
        try {
          const wf = parseWorkflow(f.content, f.path);
          return { path: f.path, name: wf.name, events: EVENTS.filter((e) => wf.on[e]), inputs: wf.on.workflow_dispatch?.inputs ?? null, error: null };
        } catch (e) {
          return { path: f.path, name: f.path, events: [], inputs: null, error: (e as Error).message };
        }
      }),
    };
  })
  // Runs a workflow that has workflow_dispatch, on a branch, with its inputs.
  .post("/repos/:owner/:repo/ci/workflows/dispatch", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const b = (body ?? {}) as { workflow?: unknown; ref?: unknown; inputs?: unknown };
    if (typeof b.workflow !== "string" || !isWorkflowPath(b.workflow)) throw new HttpError(400, "Name a workflow file, e.g. .ether/workflows/deploy.yml");
    if (typeof b.ref !== "string" || !b.ref || b.ref.length > 255) throw new HttpError(400, "Name the branch to run on");
    if (b.inputs !== undefined && (typeof b.inputs !== "object" || b.inputs === null || Array.isArray(b.inputs))) throw new HttpError(400, "inputs must be a map of names to values");
    try {
      return { run: { id: await dispatch(a.repo.id, a.path, b.workflow, b.ref, (b.inputs ?? {}) as Record<string, unknown>, viewer.id) } };
    } catch (e) {
      if (e instanceof DispatchError) throw new HttpError(e.message.startsWith("CI is turned off") ? 409 : 400, e.message);
      throw e;
    }
  })
  .get("/repos/:owner/:repo/ci/runs/:id", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const run = findRun(a, params.id);
    const jobs = db.select().from(ciJob).where(eq(ciJob.runId, run.id)).orderBy(asc(ciJob.id)).all();
    return {
      run: { ...run, subject: await subject(a.path, run.sha) },
      jobs: jobs.map((j) => ({
        id: j.id,
        key: j.key,
        name: j.name,
        needs: JSON.parse(j.needs) as string[],
        condition: j.condition,
        status: j.status,
        log: j.log,
        steps: JSON.parse(j.steps),
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        deployment: deploymentView(j, a.repo.id, viewer.id),
      })),
    };
  })
  .post("/repos/:owner/:repo/ci/runs/:id/rerun", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const run = findRun(a, params.id);
    const id = await rerun(run, a.path, viewer.id);
    if (!id) throw new HttpError(409, `CI is turned off, or that commit has no ${run.workflowPath}`);
    return { run: { id } };
  })
  .post("/repos/:owner/:repo/ci/runs/:id/cancel", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const run = findRun(a, params.id);
    if (!cancel(run.id)) throw new HttpError(409, "That run has already finished");
    return { ok: true };
  })
  // ---------- secrets: owners set and remove them; nobody can read a value back ----------
  .get("/repos/:owner/:repo/ci/secrets", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "owner");
    return { secrets: listSecrets(a.repo.id) };
  })
  .put("/repos/:owner/:repo/ci/secrets/:name", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    if (!SECRET_NAME_RE.test(params.name)) throw new HttpError(400, "Secret names are upper-case letters, digits and _, not starting with a digit, and not CI or CI_…");
    const value = (body as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "Enter a value");
    if (value.length > MAX_SECRET) throw new HttpError(413, "Secrets can be at most 64 KB");
    setSecret(a.repo.id, params.name, value, viewer.id);
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/ci/secrets/:name", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "owner");
    if (!deleteSecret(a.repo.id, params.name)) throw new HttpError(404, "No such secret");
    return { ok: true };
  });
