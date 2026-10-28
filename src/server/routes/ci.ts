import { and, asc, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, readerOrVisitor, requireRepo, requireUser, type RepoAccess } from "../access";
import { cancel, enqueue } from "../ci";
import { deleteSecret, listSecrets, MAX_SECRET, SECRET_NAME_RE, setSecret } from "../ci-secrets";
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
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const run = findRun(a, params.id);
    const id = await enqueue(a.repo.id, a.path, run.sha, run.ref, viewer.id);
    if (!id) throw new HttpError(409, "CI is turned off, or that commit has no .ether/ci.yml");
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
