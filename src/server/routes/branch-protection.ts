import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, requireRepo, requireUser } from "../access";
import { patternProblem } from "../branch-rules";
import { db } from "../db/client";
import { branchProtection } from "../db/schema";

const FLAGS = ["requirePullRequest", "allowForcePush", "allowDeletion"] as const;
type Flags = Partial<Record<(typeof FLAGS)[number], boolean>>;

// The settings present in a request body, each true or false.
function flags(b: Record<string, unknown>): Flags {
  const out: Flags = {};
  for (const key of FLAGS) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "boolean") throw new HttpError(400, `${key} must be true or false`);
    out[key] = b[key] as boolean;
  }
  return out;
}

function ruleId(param: string): number {
  if (!/^\d{1,15}$/.test(param)) throw new HttpError(400, "Invalid rule id");
  return Number(param);
}

// The rule with this id in this repository, or a 404.
function findRule(repoId: number, id: number) {
  const row = db.select().from(branchProtection).where(and(eq(branchProtection.id, id), eq(branchProtection.repoId, repoId))).get();
  if (!row) throw new HttpError(404, "No such rule");
  return row;
}

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
    const values = flags(b);
    // The unique index decides, so two requests for the same pattern can't both get through.
    try {
      db.insert(branchProtection).values({ repoId: a.repo.id, pattern, ...values }).run();
    } catch (e) {
      if (/UNIQUE constraint failed/.test((e as Error).message)) throw new HttpError(409, `There is already a rule for ${pattern}`);
      throw e;
    }
    return { ok: true };
  })
  // Changes a rule's settings in place, so the branch is never unprotected in between.
  .patch("/repos/:owner/:repo/branch-protection/:id", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const rule = findRule(a.repo.id, ruleId(params.id));
    const values = flags((body ?? {}) as Record<string, unknown>);
    if (Object.keys(values).length === 0) throw new HttpError(400, `Change at least one of ${FLAGS.join(", ")}`);
    db.update(branchProtection).set(values).where(eq(branchProtection.id, rule.id)).run();
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/branch-protection/:id", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const rule = findRule(a.repo.id, ruleId(params.id));
    db.delete(branchProtection).where(eq(branchProtection.id, rule.id)).run();
    return { ok: true };
  });
