import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, readableRepos, requireUser } from "../access";
import { db } from "../db/client";
import { issue, notification, user } from "../db/schema";

const PAGE = 50;

// The signed-in person's inbox, newest first, only from repositories they can read now.
export const notificationRoutes = new Elysia()
  .get("/me/notifications", async ({ request, query }) => {
    const viewer = await requireUser(request);
    const readable = new Map(readableRepos(viewer.id).map((r) => [r.id, r]));
    const ids = [...readable.keys()];
    const all = (query as Record<string, string | undefined>).filter === "all";
    if (!ids.length) return { notifications: [], unread: 0, next: null };
    const filters = [eq(notification.userId, viewer.id), inArray(notification.repoId, ids)];
    if (!all) filters.push(isNull(notification.readAt));
    // Cursor: "<ms>-<id>" of the last entry on the previous page.
    const cursor = /^(\d+)-(\d+)$/.exec((query as Record<string, string | undefined>).before ?? "");
    if (cursor) {
      const at = new Date(Number(cursor[1]));
      filters.push(or(lt(notification.createdAt, at), and(eq(notification.createdAt, at), lt(notification.id, Number(cursor[2]))))!);
    }
    const rows = db
      .select({ n: notification, actor: user.username, isPull: issue.isPull, state: issue.state })
      .from(notification)
      .leftJoin(user, eq(user.id, notification.actorId))
      .leftJoin(issue, and(eq(issue.repoId, notification.repoId), eq(issue.number, notification.issueNumber)))
      .where(and(...filters))
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(PAGE + 1)
      .all();
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return {
      notifications: page.map(({ n, actor, isPull, state }) => ({
        id: n.id,
        owner: readable.get(n.repoId)!.owner,
        repo: readable.get(n.repoId)!.name,
        issueNumber: n.issueNumber,
        runId: n.runId,
        isPull: !!isPull,
        state,
        reason: n.reason,
        actor,
        title: n.title,
        excerpt: n.excerpt,
        at: n.createdAt,
        read: n.readAt !== null,
      })),
      unread: unreadCount(viewer.id, ids),
      next: rows.length > PAGE && last ? `${last.n.createdAt.getTime()}-${last.n.id}` : null,
    };
  })
  .get("/me/notifications/count", async ({ request }) => {
    const viewer = await requireUser(request);
    return { unread: unreadCount(viewer.id, readableRepos(viewer.id).map((r) => r.id)) };
  })
  // Mark one read (or unread again with { read: false }).
  .patch("/me/notifications/:id", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const read = (body as { read?: unknown } | null)?.read !== false;
    const mine = db.select().from(notification).where(and(eq(notification.id, Number(params.id)), eq(notification.userId, viewer.id))).get();
    if (!mine) throw new HttpError(404, "No such notification");
    db.transaction((tx) => {
      // A thread keeps one unread entry per reason: marking an older one unread takes over a newer unread one.
      if (!read) {
        const newer = tx
          .select()
          .from(notification)
          .where(
            and(
              eq(notification.userId, viewer.id),
              eq(notification.repoId, mine.repoId),
              eq(notification.reason, mine.reason),
              isNull(notification.readAt),
              ne(notification.id, mine.id),
              mine.issueNumber === null ? isNull(notification.issueNumber) : eq(notification.issueNumber, mine.issueNumber),
              mine.runId === null ? isNull(notification.runId) : eq(notification.runId, mine.runId),
            ),
          )
          .get();
        if (newer) {
          tx.delete(notification).where(eq(notification.id, newer.id)).run();
          tx.update(notification).set({ actorId: newer.actorId, title: newer.title, excerpt: newer.excerpt, createdAt: newer.createdAt }).where(eq(notification.id, mine.id)).run();
        }
      }
      tx.update(notification).set({ readAt: read ? new Date() : null }).where(eq(notification.id, mine.id)).run();
    });
    return { ok: true };
  })
  .post("/me/notifications/read", async ({ request }) => {
    const viewer = await requireUser(request);
    db.update(notification).set({ readAt: new Date() }).where(and(eq(notification.userId, viewer.id), isNull(notification.readAt))).run();
    return { ok: true };
  });

function unreadCount(userId: string, repoIds: number[]) {
  if (!repoIds.length) return 0;
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(notification)
      .where(and(eq(notification.userId, userId), isNull(notification.readAt), inArray(notification.repoId, repoIds)))
      .get()?.n ?? 0
  );
}
