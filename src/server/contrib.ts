import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/client";
import { commitEmail, pushEmail } from "./db/schema";

// Called after a successful push with the author email of every commit it brought in.
// Remembers them as suggestions for the pusher. If the pusher has no commit emails yet and
// every new commit has the same, unclaimed author email, that email is claimed for them:
// the common case of someone pushing their own work then needs no setup.
export function recordPush(userId: string, emails: string[]) {
  if (emails.length === 0) return;
  const counts = new Map<string, number>();
  for (const e of emails) counts.set(e, (counts.get(e) ?? 0) + 1);
  const now = new Date();
  for (const [email, n] of counts)
    db.insert(pushEmail)
      .values({ userId, email, commits: n, lastSeenAt: now })
      .onConflictDoUpdate({ target: [pushEmail.userId, pushEmail.email], set: { commits: sql`${pushEmail.commits} + ${n}`, lastSeenAt: now } })
      .run();

  if (counts.size !== 1) return;
  const [email] = counts.keys();
  const hasAny = db.select().from(commitEmail).where(eq(commitEmail.userId, userId)).get();
  const claimed = db.select().from(commitEmail).where(inArray(commitEmail.email, [email])).get();
  if (!hasAny && !claimed) db.insert(commitEmail).values({ email, userId }).onConflictDoNothing().run();
}

// Push emails not yet claimed by anyone else, most used first.
export function pushSuggestions(userId: string) {
  const mine = db.select({ email: pushEmail.email, commits: pushEmail.commits }).from(pushEmail).where(eq(pushEmail.userId, userId)).all();
  if (mine.length === 0) return [];
  const owners = new Map(
    db
      .select()
      .from(commitEmail)
      .where(inArray(commitEmail.email, mine.map((m) => m.email)))
      .all()
      .map((c) => [c.email, c.userId]),
  );
  return mine
    .filter((m) => !owners.has(m.email) || owners.get(m.email) === userId)
    .sort((a, b) => b.commits - a.commits)
    .map((m) => ({ ...m, yours: owners.get(m.email) === userId }));
}
