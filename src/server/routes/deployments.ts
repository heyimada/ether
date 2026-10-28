import { Elysia } from "elysia";
import { allows, findUser, HttpError, isOrg, readerOrVisitor, repoAccess, requireRepo, requireUser, type RepoAccess } from "../access";
import { patternProblem } from "../branch-rules";
import { abandonEnvironment, reconsiderEnvironment, reviewDeployment, ReviewError } from "../ci";
import { deleteEnvironmentSecret, listEnvironmentSecrets, MAX_SECRET, SECRET_NAME_RE, setEnvironmentSecret } from "../ci-secrets";
import { ENVIRONMENT_RE } from "../ci-workflow";
import { db } from "../db/client";
import { environment } from "../db/schema";
import { ensureEnvironment, environmentsOverview, findEnvironment, listDeployments, reviewerIds, setEnvironmentRules } from "../deploy";
import { eq } from "drizzle-orm";

const MAX_REVIEWERS = 6;
const MAX_WAIT_MINUTES = 30 * 24 * 60;

function environmentOf(a: RepoAccess, name: string) {
  const env = findEnvironment(a.repo.id, name);
  if (!env) throw new HttpError(404, "No such environment");
  return env;
}

// Environments are shown to everyone who can read the repository; their rules and secrets are managed by owners.
export const deploymentRoutes = new Elysia()
  .get("/repos/:owner/:repo/environments", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    return { environments: environmentsOverview(a.repo.id) };
  })
  // Creates the environment if needed and replaces its rules; fields left out keep their value.
  .put("/repos/:owner/:repo/environments/:name", async ({ request, params, body }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "owner");
    if (!ENVIRONMENT_RE.test(params.name)) throw new HttpError(400, "Environment names are letters, digits, '.', '_' or '-', up to 64 characters");
    const b = (body ?? {}) as { branches?: unknown; reviewers?: unknown; waitMinutes?: unknown };
    // Everything is checked before the environment is created, so a refused request leaves nothing behind.
    const existing = findEnvironment(a.repo.id, params.name);

    let branches = existing ? (JSON.parse(existing.branches) as string[]) : [];
    if (b.branches !== undefined) {
      if (!Array.isArray(b.branches) || b.branches.length > 20 || b.branches.some((p) => typeof p !== "string")) throw new HttpError(400, "branches must be a list of up to 20 branch patterns");
      branches = [...new Set((b.branches as string[]).map((p) => p.trim()).filter(Boolean))];
      for (const p of branches) {
        const problem = patternProblem(p);
        if (problem) throw new HttpError(400, `${p}: ${problem}`);
      }
    }

    let reviewers = existing ? reviewerIds(existing.id) : [];
    if (b.reviewers !== undefined) {
      if (!Array.isArray(b.reviewers) || b.reviewers.some((u) => typeof u !== "string")) throw new HttpError(400, "reviewers must be a list of usernames");
      const names = [...new Set(b.reviewers as string[])];
      if (names.length > MAX_REVIEWERS) throw new HttpError(400, `An environment can have at most ${MAX_REVIEWERS} reviewers`);
      reviewers = names.map((name) => {
        const u = findUser(name);
        if (!u || isOrg(u.id)) throw new HttpError(400, `No such user: ${name}`);
        // Reviewers decide what reaches the environment, so they need write access to the repository.
        const access = repoAccess(u, a.owner, a.repo.name);
        if (!access || !allows(access.role, "write")) throw new HttpError(400, `${name} needs write access to this repository to review deployments`);
        return u.id;
      });
    }

    let waitMinutes = existing?.waitMinutes ?? 0;
    if (b.waitMinutes !== undefined) {
      if (!Number.isInteger(b.waitMinutes) || (b.waitMinutes as number) < 0 || (b.waitMinutes as number) > MAX_WAIT_MINUTES)
        throw new HttpError(400, `waitMinutes must be a whole number from 0 to ${MAX_WAIT_MINUTES}`);
      waitMinutes = b.waitMinutes as number;
    }

    setEnvironmentRules(existing ?? ensureEnvironment(a.repo.id, params.name), { branches, reviewers, waitMinutes });
    reconsiderEnvironment(a.repo.id, params.name);
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/environments/:name", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "owner");
    const env = environmentOf(a, params.name);
    // Its deployment history and secrets go with it; jobs that name it again start a fresh one.
    await abandonEnvironment(a.repo.id, env.name);
    db.delete(environment).where(eq(environment.id, env.id)).run();
    return { ok: true };
  })
  .get("/repos/:owner/:repo/environments/:name/secrets", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "owner");
    return { secrets: listEnvironmentSecrets(environmentOf(a, params.name).id) };
  })
  .put("/repos/:owner/:repo/environments/:name/secrets/:secret", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const env = environmentOf(a, params.name);
    if (!SECRET_NAME_RE.test(params.secret)) throw new HttpError(400, "Secret names are upper-case letters, digits and _, not starting with a digit, and not CI or CI_…");
    const value = (body as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "Enter a value");
    if (value.length > MAX_SECRET) throw new HttpError(413, "Secrets can be at most 64 KB");
    setEnvironmentSecret(env.id, params.secret, value, viewer.id);
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/environments/:name/secrets/:secret", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "owner");
    if (!deleteEnvironmentSecret(environmentOf(a, params.name).id, params.secret)) throw new HttpError(404, "No such secret");
    return { ok: true };
  })
  .get("/repos/:owner/:repo/deployments", async ({ request, params, query }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const name = typeof query.environment === "string" ? query.environment : undefined;
    const env = name ? environmentOf(a, name) : undefined;
    return { deployments: listDeployments(a.repo.id, env?.id) };
  })
  // A reviewer approves or rejects a deploy job that waits for one.
  .post("/repos/:owner/:repo/ci/jobs/:id/review", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const approve = (body as { approve?: unknown } | undefined)?.approve;
    if (typeof approve !== "boolean") throw new HttpError(400, "approve must be true or false");
    if (!/^\d{1,15}$/.test(params.id)) throw new HttpError(400, "Invalid job id");
    try {
      await reviewDeployment(Number(params.id), a.repo.id, viewer.id, approve);
    } catch (e) {
      if (e instanceof ReviewError) throw new HttpError(e.status, e.message);
      throw e;
    }
    return { ok: true };
  });
