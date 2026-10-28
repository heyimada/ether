import { and, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, requireRepo, requireUser } from "../access";
import { db } from "../db/client";
import { deployKey } from "../db/schema";
import { keyInUse, parsePublicKey } from "../ssh";

// Like collaborators, only owners see and manage a repository's deploy keys.
export const deployKeyRoutes = new Elysia()
  .get("/repos/:owner/:repo/deploy-keys", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    return {
      keys: db
        .select({
          id: deployKey.id,
          title: deployKey.title,
          keyType: deployKey.keyType,
          fingerprint: deployKey.fingerprint,
          readOnly: deployKey.readOnly,
          createdAt: deployKey.createdAt,
          lastUsedAt: deployKey.lastUsedAt,
        })
        .from(deployKey)
        .where(eq(deployKey.repoId, a.repo.id))
        .orderBy(desc(deployKey.createdAt))
        .all(),
    };
  })
  .post("/repos/:owner/:repo/deploy-keys", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const { title, key, write } = (body ?? {}) as { title?: unknown; key?: unknown; write?: unknown };
    if (typeof key !== "string") throw new HttpError(400, "Paste a public key");
    if (write !== undefined && typeof write !== "boolean") throw new HttpError(400, "write must be true or false");
    let parsed;
    try {
      parsed = parsePublicKey(key);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (keyInUse(parsed.blob)) throw new HttpError(409, "That key is already in use, by an account or as a deploy key");
    const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 100) : parsed.keyType;
    db.insert(deployKey)
      .values({ repoId: a.repo.id, title: name, ...parsed, readOnly: write !== true, createdBy: viewer.id })
      .run();
    return { ok: true, fingerprint: parsed.fingerprint };
  })
  .delete("/repos/:owner/:repo/deploy-keys/:id", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    db.delete(deployKey).where(and(eq(deployKey.id, Number(params.id)), eq(deployKey.repoId, a.repo.id))).run();
    return { ok: true };
  });
