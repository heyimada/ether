import { and, asc, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, readerOrVisitor, requireRepo, requireUser, type RepoAccess } from "../access";
import { cancel, enqueue } from "../ci";
import { db } from "../db/client";
import { ciJob, ciRun } from "../db/schema";
import * as git from "../git";

function findRun(a: RepoAccess, id: string) {
  const run = db.select().from(ciRun).where(and(eq(ciRun.id, Number(id)), eq(ciRun.repoId, a.repo.id))).get();
  if (!run) throw new HttpError(404, "No such run");
  return run;
}

async function subject(path: string, sha: string) {
  return (await git.log(path, sha, { limit: 1 }).catch(() => []))[0]?.subject ?? "";
}

export const ciRoutes = new Elysia()
  .get("/repos/:owner/:repo/ci/runs", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const runs = db.select().from(ciRun).where(eq(ciRun.repoId, a.repo.id)).orderBy(desc(ciRun.id)).limit(50).all();
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
  .get("/repos/:owner/:repo/ci/runs/:id", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const run = findRun(a, params.id);
    const jobs = db.select().from(ciJob).where(eq(ciJob.runId, run.id)).orderBy(asc(ciJob.id)).all();
    return {
      run: { ...run, subject: await subject(a.path, run.sha) },
      jobs: jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, log: j.log, steps: JSON.parse(j.steps), startedAt: j.startedAt, finishedAt: j.finishedAt })),
    };
  })
  .post("/repos/:owner/:repo/ci/runs/:id/rerun", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const run = findRun(a, params.id);
    const id = await enqueue(a.repo.id, a.path, run.sha, run.ref);
    if (!id) throw new HttpError(409, "CI is turned off, or that commit has no .ether/ci.yml");
    return { run: { id } };
  })
  .post("/repos/:owner/:repo/ci/runs/:id/cancel", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const run = findRun(a, params.id);
    if (!cancel(run.id)) throw new HttpError(409, "That run has already finished");
    return { ok: true };
  });
