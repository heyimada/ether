import { and, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, requireUser } from "../access";
import { db } from "../db/client";
import { sshKey } from "../db/schema";
import { keyInUse, parsePublicKey } from "../ssh";

export const sshKeyRoutes = new Elysia()
  .get("/me/ssh-keys", async ({ request }) => {
    const viewer = await requireUser(request);
    return {
      keys: db
        .select({ id: sshKey.id, title: sshKey.title, keyType: sshKey.keyType, fingerprint: sshKey.fingerprint, createdAt: sshKey.createdAt, lastUsedAt: sshKey.lastUsedAt })
        .from(sshKey)
        .where(eq(sshKey.userId, viewer.id))
        .orderBy(desc(sshKey.createdAt))
        .all(),
    };
  })
  .post("/me/ssh-keys", async ({ request, body }) => {
    const viewer = await requireUser(request);
    const { title, key } = (body ?? {}) as { title?: unknown; key?: unknown };
    if (typeof key !== "string") throw new HttpError(400, "Paste a public key");
    let parsed;
    try {
      parsed = parsePublicKey(key);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (keyInUse(parsed.blob)) throw new HttpError(409, "That key is already in use, by an account or as a deploy key");
    const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 100) : parsed.keyType;
    db.insert(sshKey).values({ userId: viewer.id, title: name, ...parsed }).run();
    return { ok: true, fingerprint: parsed.fingerprint };
  })
  .delete("/me/ssh-keys/:id", async ({ request, params }) => {
    const viewer = await requireUser(request);
    db.delete(sshKey).where(and(eq(sshKey.id, Number(params.id)), eq(sshKey.userId, viewer.id))).run();
    return { ok: true };
  });
