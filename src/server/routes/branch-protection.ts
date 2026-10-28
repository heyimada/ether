import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, requireRepo, requireUser } from "../access";
import { patternProblem } from "../branch-rules";
import { db } from "../db/client";
import { branchProtection } from "../db/schema";

const flag = (b: Record<string, unknown>, key: string) => {
  if (b[key] === undefined) return false;
  if (typeof b[key] !== "boolean") throw new HttpError(400, `${key} must be true or false`);
  return b[key] as boolean;
};

// Owners manage the rules; the pre-receive hook enforces them for everyone, owners included.
export const branchProtectionRoutes = new Elysia()
  .get("/repos/:owner/:repo/branch-protection", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    return {
      rules: db
        .select({
          id: branchProtection.id,
          pattern: branchProtection.pattern,
          requirePullRequest: branchProtection.requirePullRequest,
          allowForcePush: branchProtection.allowForcePush,
          allowDeletion: branchProtection.allowDeletion,
        })
        .from(branchProtection)
        .where(eq(branchProtection.repoId, a.repo.id))
        .orderBy(branchProtection.pattern)
        .all(),
    };
  })
  .post("/repos/:owner/:repo/branch-protection", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const b = (body ?? {}) as Record<string, unknown>;
    const pattern = typeof b.pattern === "string" ? b.pattern.trim() : "";
    const problem = patternProblem(pattern);
    if (problem) throw new HttpError(400, problem);
    const values = { requirePullRequest: flag(b, "requirePullRequest"), allowForcePush: flag(b, "allowForcePush"), allowDeletion: flag(b, "allowDeletion") };
    if (db.select().from(branchProtection).where(and(eq(branchProtection.repoId, a.repo.id), eq(branchProtection.pattern, pattern))).get())
      throw new HttpError(409, `There is already a rule for ${pattern}`);
    db.insert(branchProtection).values({ repoId: a.repo.id, pattern, ...values }).run();
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/branch-protection/:id", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    db.delete(branchProtection).where(and(eq(branchProtection.id, Number(params.id)), eq(branchProtection.repoId, a.repo.id))).run();
    return { ok: true };
  });
