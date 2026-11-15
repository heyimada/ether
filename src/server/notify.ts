// Notifications: who hears about what happened on an issue, pull request or run. Writers call the helpers below
// where things happen; nobody is told about their own actions, or about repositories they can't read.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { repoAccess } from "./access";
import { db } from "./db/client";
import { comment, issue, issueAssignee, notification, organization, repo, review, team, teamMember, user } from "./db/schema";

export type Reason = (typeof notification.$inferInsert)["reason"];
type Target = { repoId: number; issueNumber?: number | null; runId?: number | null; title: string; excerpt?: string };

const MAX_MENTIONS = 50;

// Who can read the repository now; checked when notifying and again when listing.
function readers(repoId: number, userIds: Iterable<string>): string[] {
  const r = db.select({ name: repo.name, owner: user.username }).from(repo).innerJoin(user, eq(user.id, repo.ownerId)).where(eq(repo.id, repoId)).get();
  if (!r) return [];
  return [...new Set(userIds)].filter((id) => !!repoAccess({ id }, r.owner!, r.name));
}

// Records `reason` for each person, except the actor. An unread entry for the same thread and reason is brought
// up to date instead of adding another, so a busy thread stays one line in the inbox.
export function notify(userIds: Iterable<string>, reason: Reason, actorId: string | null, t: Target) {
  const ids = readers(t.repoId, [...userIds].filter((id) => id !== actorId));
  if (!ids.length) return;
  const excerpt = (t.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const now = new Date();
  db.transaction((tx) => {
    for (const userId of ids) {
      const same = and(
        eq(notification.userId, userId),
        eq(notification.repoId, t.repoId),
        eq(notification.reason, reason),
        isNull(notification.readAt),
        t.issueNumber == null ? isNull(notification.issueNumber) : eq(notification.issueNumber, t.issueNumber),
        t.runId == null ? isNull(notification.runId) : eq(notification.runId, t.runId),
      );
      const updated = tx.update(notification).set({ actorId, title: t.title, excerpt, createdAt: now }).where(same).returning({ id: notification.id }).all();
      if (!updated.length)
        tx.insert(notification)
          .values({ userId, repoId: t.repoId, issueNumber: t.issueNumber ?? null, runId: t.runId ?? null, reason, actorId, title: t.title, excerpt, createdAt: now })
          .run();
    }
  });
}

// People following an issue or pull request: its author, assignees, and everyone who commented or reviewed.
export function participants(issueId: number): Set<string> {
  const row = db.select({ authorId: issue.authorId }).from(issue).where(eq(issue.id, issueId)).get();
  const ids = new Set<string>(row ? [row.authorId] : []);
  for (const r of db.select({ id: comment.authorId }).from(comment).where(eq(comment.issueId, issueId)).all()) ids.add(r.id);
  for (const r of db.select({ id: review.authorId }).from(review).where(eq(review.issueId, issueId)).all()) ids.add(r.id);
  for (const r of db.select({ id: issueAssignee.userId }).from(issueAssignee).where(eq(issueAssignee.issueId, issueId)).all()) ids.add(r.id);
  return ids;
}

// @name and @org/team mentions in Markdown, outside code. Names that aren't accounts are ignored.
export function mentioned(texts: string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
    for (const m of prose.matchAll(/(?<![\w@/.])@([a-z0-9][a-z0-9._-]{0,38})(?:\/([a-z0-9][a-z0-9._-]{0,99}))?/gi)) {
      // Punctuation ending a sentence ("thanks @ana.", "cc @acme/devs.") isn't part of the name.
      const trim = (n: string) => n.toLowerCase().replace(/[._-]+$/, "");
      names.add(m[2] ? `${m[1].toLowerCase()}/${trim(m[2])}` : trim(m[1]));
      if (names.size >= MAX_MENTIONS) break;
    }
  }
  const ids = new Set<string>();
  for (const name of names) {
    const [owner, teamName] = name.split("/");
    const u = db.select({ id: user.id, role: user.role }).from(user).where(eq(user.username, owner)).get();
    if (!u) continue;
    if (teamName === undefined) {
      if (u.role !== "org") ids.add(u.id);
      continue;
    }
    if (!db.select().from(organization).where(eq(organization.userId, u.id)).get()) continue;
    const t = db.select({ id: team.id }).from(team).where(and(eq(team.orgId, u.id), eq(team.name, teamName))).get();
    if (t) for (const m of db.select({ id: teamMember.userId }).from(teamMember).where(eq(teamMember.teamId, t.id)).all()) ids.add(m.id);
  }
  return ids;
}

// Something new on a thread: those mentioned in it hear about the mention, the other participants about `reason`.
export function notifyThread(issueId: number, reason: Reason, actorId: string, t: Target, texts: string[] = []) {
  const mentions = mentioned(texts);
  notify(mentions, "mention", actorId, t);
  const rest = [...participants(issueId)].filter((id) => !mentions.has(id));
  notify(rest, reason, actorId, t);
}

// Team members, for review requests made of a team.
export const teamMembers = (teamIds: number[]) =>
  teamIds.length ? db.select({ id: teamMember.userId }).from(teamMember).where(inArray(teamMember.teamId, teamIds)).all().map((m) => m.id) : [];

// Notifying is a side effect: a failure there must never fail what the person did.
export function quietly(fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error("Notifying failed:", e);
  }
}

// Seeing an issue or pull request reads its notifications.
export function markRead(userId: string, repoId: number, issueNumber: number) {
  db.update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.userId, userId), eq(notification.repoId, repoId), eq(notification.issueNumber, issueNumber), isNull(notification.readAt)))
    .run();
}
