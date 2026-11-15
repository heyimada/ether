import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "./db/client";
import { event, user } from "./db/schema";
import type { ReadableRepo } from "./access";
import * as git from "./git";

// The activity log behind the dashboard feed, profiles and organization pages. Writers call
// record() where things happen; readers go through listEvents(), which only returns events from
// repositories the reader can currently read.

type IssueRef = { number: number; title: string };
type PullRef = IssueRef & { base: string | null; head: string | null };

export type Payloads = {
  create: Record<string, never>;
  push: { ref: string; commits: number; created: boolean; head: string; shown: { sha: string; subject: string }[] };
  issue_opened: IssueRef;
  issue_closed: IssueRef;
  issue_reopened: IssueRef;
  pull_opened: PullRef;
  pull_closed: PullRef;
  pull_reopened: PullRef;
  pull_merged: PullRef;
  comment: IssueRef & { isPull: boolean; excerpt: string };
  review: IssueRef & { state: "approved" | "changes_requested" | "commented" };
  release: { tag: string; title: string; prerelease: boolean };
  star: Record<string, never>;
  wiki: { slug: string; title: string; created: boolean };
  ci_failed: { runId: number; ref: string; sha: string; subject: string; status: string };
};
export type Kind = keyof Payloads;

export function record<K extends Kind>(repoId: number, actorId: string, kind: K, payload: Payloads[K]) {
  db.insert(event).values({ repoId, actorId, kind, payload: JSON.stringify(payload) }).run();
}

export const excerpt = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 240);

const SHOWN = 5;

// One push event per branch that moved forward or appeared. Commits are those reachable from the
// new tip and from none of the refs as they were before, so a branch cut from main counts zero.
export async function recordPushEvents(repoId: number, actorId: string, path: string, before: git.Ref[], after: git.Ref[]) {
  const old = [...new Set(before.map((r) => r.sha))];
  for (const ref of after) {
    if (ref.kind !== "branch") continue;
    const prev = before.find((b) => b.kind === "branch" && b.name === ref.name);
    if (prev?.sha === ref.sha) continue;
    const exclude = old.length ? ["--not", ...old] : [];
    const count = Number((await git.gitText(path, ["rev-list", "--count", ref.sha, ...exclude, "--"]).catch(() => "0")).trim()) || 0;
    const log = count ? await git.gitText(path, ["log", "--format=%H%x1f%s", "-n", String(SHOWN), ref.sha, ...exclude, "--"]).catch(() => "") : "";
    const shown = log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha, subject: subject.slice(0, 200) };
      });
    record(repoId, actorId, "push", { ref: ref.name, commits: count, created: !prev, head: ref.sha, shown });
  }
}

export type FeedEvent = {
  id: number;
  kind: Kind;
  owner: string;
  repo: string;
  visibility: "private" | "public";
  actor: string;
  at: Date;
  payload: Record<string, unknown>;
};

// Newest first, from repositories in `readable` only. Failed checks are only news to whoever
// pushed. `before` is the cursor from the last page ("<ms>-<id>").
export function listEvents(
  viewerId: string,
  readable: ReadableRepo[],
  opts: { limit?: number; before?: string; actorId?: string; repoIds?: number[] } = {},
): { events: FeedEvent[]; next: string | null } {
  const byId = new Map(readable.map((r) => [r.id, r]));
  const ids = (opts.repoIds ?? [...byId.keys()]).filter((id) => byId.has(id));
  if (ids.length === 0) return { events: [], next: null };
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const filters = [inArray(event.repoId, ids), or(sql`${event.kind} <> 'ci_failed'`, eq(event.actorId, viewerId))];
  if (opts.actorId) filters.push(eq(event.actorId, opts.actorId));
  const cursor = /^(\d+)-(\d+)$/.exec(opts.before ?? "");
  if (cursor) {
    const at = new Date(Number(cursor[1]));
    filters.push(or(lt(event.createdAt, at), and(eq(event.createdAt, at), lt(event.id, Number(cursor[2])))));
  }
  const rows = db
    .select({ e: event, actor: user.username })
    .from(event)
    .innerJoin(user, eq(user.id, event.actorId))
    .where(and(...filters))
    .orderBy(desc(event.createdAt), desc(event.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map(({ e, actor }) => {
      const r = byId.get(e.repoId)!;
      return { id: e.id, kind: e.kind as Kind, owner: r.owner, repo: r.name, visibility: r.visibility, actor: actor!, at: e.createdAt, payload: JSON.parse(e.payload) };
    }),
    next: rows.length > limit && last ? `${last.e.createdAt.getTime()}-${last.e.id}` : null,
  };
}

// When each repository last saw anything happen, for "recently updated" ordering.
export function lastActivity(repoIds: number[]): Map<number, Date> {
  if (repoIds.length === 0) return new Map();
  return new Map(
    db
      .select({ repoId: event.repoId, at: sql<number>`max(${event.createdAt})` })
      .from(event)
      .where(inArray(event.repoId, repoIds))
      .groupBy(event.repoId)
      .all()
      .map((r) => [r.repoId, new Date(r.at)]),
  );
}
