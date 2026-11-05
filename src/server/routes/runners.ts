import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { LABEL_RE, MAX_LABELS, PROTOCOL, RESULTS, type Isolation, type JobResult } from "../../runner/protocol";
import { HttpError, requireAdmin, requireRepo, requireUser, secret, sha256 } from "../access";
import { abandonRemoteJobs, claimJob, finishRemoteJob, RUNNER_ONLINE_MS, remoteJob, reportJob, resumePump } from "../ci";
import { db } from "../db/client";
import { ciRunner, ciRunnerRegistration } from "../db/schema";
import { requireOrgOwner } from "./orgs";

// External runners (see ../../runner/main.ts). An admin creates a one-time token, a machine trades it for a
// token of its own and then asks for work; while it runs a job it reports with a token for that job alone.
// Runners always call in, so their machines need no open port.

const REGISTRATION_TTL = 3600 * 1000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_REPORT = 256 * 1024;

const bearer = (request: Request) => /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;

function isolationOf(raw: unknown): Isolation {
  if (raw !== "container" && raw !== "host") throw new HttpError(400, "isolation must be container or host");
  return raw;
}

function requireRunner(request: Request) {
  const token = bearer(request);
  const row = token ? db.select().from(ciRunner).where(eq(ciRunner.tokenHash, sha256(token))).get() : null;
  if (!row) throw new HttpError(401, "Unknown runner");
  return row;
}

function requireJob(request: Request, id: string) {
  const job = remoteJob(Number(id), bearer(request) ?? "");
  // Finished, cancelled by a restart, or never this runner's: either way it should stop working on it.
  if (!job) throw new HttpError(404, "No such job");
  return job;
}

type Scope = { repoId: number | null; orgId: string | null };
type Params = Record<string, string>;

// Listing, adding and removing runners. Admins see every runner; owners of a repository or an organization
// manage the ones that run just their jobs, which can't reach anything else.
function manage(path: string, authorize: (request: Request, params: Params) => Promise<Scope | "all">) {
  const inScope = (r: typeof ciRunner.$inferSelect, scope: Scope | "all") => scope === "all" || (r.repoId === scope.repoId && r.orgId === scope.orgId);
  return new Elysia()
    .get(`${path}/runners`, async ({ request, params }) => {
      const scope = await authorize(request, params as Params);
      const rows = db.select().from(ciRunner).orderBy(desc(ciRunner.createdAt), desc(ciRunner.id)).all().filter((r) => inScope(r, scope));
      return {
        runners: rows.map((r) => ({
          id: r.id,
          name: r.name,
          isolation: r.isolation,
          labels: JSON.parse(r.labels) as string[],
          scope: r.repoId !== null ? "repository" : r.orgId !== null ? "organization" : "server",
          lastSeenAt: r.lastSeenAt,
          online: !!r.lastSeenAt && Date.now() - r.lastSeenAt.getTime() < RUNNER_ONLINE_MS,
        })),
      };
    })
    .post(`${path}/runners/registration`, async ({ request, params }) => {
      const scope = await authorize(request, params as Params);
      const token = secret("ethrr_");
      const expiresAt = new Date(Date.now() + REGISTRATION_TTL);
      db.insert(ciRunnerRegistration).values({ tokenHash: sha256(token), expiresAt, ...(scope === "all" ? {} : scope) }).run();
      return { token, expiresAt };
    })
    .delete(`${path}/runners/:id`, async ({ request, params }) => {
      const scope = await authorize(request, params as Params);
      const id = Number((params as Params).id);
      const row = db.select().from(ciRunner).where(eq(ciRunner.id, id)).get();
      if (!row || !inScope(row, scope)) throw new HttpError(404, "No such runner");
      db.delete(ciRunner).where(eq(ciRunner.id, id)).run();
      await abandonRemoteJobs(
        (j) => j.runnerId === id,
        () => `Runner ${row.name} was removed`,
      );
      // Without runners the built-in one takes over again.
      resumePump();
      return { ok: true };
    });
}

export const runnerRoutes = new Elysia()
  .use(
    manage("/admin", async (request) => {
      await requireAdmin(request);
      return "all";
    }),
  )
  .use(
    manage("/repos/:owner/:repo", async (request, params) => ({
      repoId: requireRepo(await requireUser(request), params.owner, params.repo, "owner").repo.id,
      orgId: null,
    })),
  )
  .use(
    manage("/orgs/:org", async (request, params) => ({
      repoId: null,
      orgId: requireOrgOwner(await requireUser(request), params.org).id,
    })),
  )
  .post("/runner/register", ({ body }) => {
    const { token, name, isolation, labels } = (body ?? {}) as { token?: unknown; name?: unknown; isolation?: unknown; labels?: unknown };
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new HttpError(400, "A runner's name is letters, digits, '.', '_' or '-'");
    const chosen = isolationOf(isolation);
    const offered = labels ?? [];
    if (!Array.isArray(offered) || offered.length > MAX_LABELS || offered.some((l) => typeof l !== "string" || !LABEL_RE.test(l))) throw new HttpError(400, `labels must be up to ${MAX_LABELS} of letters, digits, '.', '_' or '-'`);
    if (typeof token !== "string") throw new HttpError(401, "That registration token isn't valid");
    // Marking it used is the check, so one token can't register two runners.
    const used = db
      .update(ciRunnerRegistration)
      .set({ usedAt: new Date() })
      .where(and(eq(ciRunnerRegistration.tokenHash, sha256(token)), isNull(ciRunnerRegistration.usedAt), gt(ciRunnerRegistration.expiresAt, new Date())))
      .returning({ repoId: ciRunnerRegistration.repoId, orgId: ciRunnerRegistration.orgId })
      .all();
    if (used.length === 0) throw new HttpError(401, "That registration token isn't valid");
    const own = secret("ethr_");
    const runner = db.insert(ciRunner).values({ name, isolation: chosen, labels: JSON.stringify([...new Set(offered as string[])]), repoId: used[0].repoId, orgId: used[0].orgId, tokenHash: sha256(own) }).returning({ id: ciRunner.id }).get();
    return { id: runner.id, token: own };
  })
  // Returns at once with a job or 204; a runner with nothing to do asks again a few seconds later.
  .post("/runner/claim", ({ request, body }) => {
    const runner = requireRunner(request);
    if ((body as { protocol?: unknown } | null)?.protocol !== PROTOCOL) return Response.json({ error: "This version of ether-runner doesn't go with this server" }, { status: 426 });
    db.update(ciRunner).set({ lastSeenAt: new Date() }).where(eq(ciRunner.id, runner.id)).run();
    // The isolation it registered with, not what a request says: the jobs of a runner on its host can read
    // its token, and mustn't be able to pass as a runner with containers to get secrets.
    return claimJob(runner) ?? new Response(null, { status: 204 });
  })
  .post("/runner/jobs/:id/report", ({ request, params, body }) => {
    const job = requireJob(request, params.id);
    const text = (body as { text?: unknown } | null)?.text ?? "";
    if (typeof text !== "string" || text.length > MAX_REPORT) throw new HttpError(400, `A report is a text of at most ${MAX_REPORT} characters`);
    db.update(ciRunner).set({ lastSeenAt: new Date() }).where(eq(ciRunner.id, job.runnerId)).run();
    return reportJob(job, text);
  })
  .post("/runner/jobs/:id/finish", async ({ request, params, body }) => {
    const job = requireJob(request, params.id);
    const { result, outputs } = (body ?? {}) as { result?: unknown; outputs?: unknown };
    if (!RESULTS.includes(result as JobResult)) throw new HttpError(400, `result must be one of ${RESULTS.join(", ")}`);
    await finishRemoteJob(job, result as JobResult, outputs);
    return { ok: true };
  });
