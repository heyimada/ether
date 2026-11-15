import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, allows, orgRole, readerOrVisitor, requireRepo, requireUser, type RepoAccess, type Viewer } from "../access";
import { onPullRequest } from "../ci";
import { db } from "../db/client";
import { comment, issue, issueAssignee, issueLabel, label, repo, user } from "../db/schema";
import { deployedAt } from "../deploy";
import { excerpt, record } from "../events";
import * as git from "../git";
import { markRead, mentioned, notify, notifyThread } from "../notify";
import { ownerStatus, requestCodeOwners } from "../owners";
import { allowedMethods, mergePull, underMergeLock } from "../merge";
import { findIssue, findPull, headChecks, headDeletable, issueRows, pullStatus, reviewSummary, stackOf, type IssueRow } from "../pulls";
import { sideEffect } from "../side-effect";
import { BODY_MAX, TITLE_MAX } from "../../shared/issues";

type Body = Record<string, unknown> | undefined;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export type LabelOut = { name: string; color: string; description: string };

// Labels and assignees for a batch of issues, in two queries.
function issueMeta(issueIds: number[]) {
  const labels = new Map<number, LabelOut[]>();
  const assignees = new Map<number, string[]>();
  if (issueIds.length) {
    for (const r of db
      .select({ issueId: issueLabel.issueId, name: label.name, color: label.color, description: label.description })
      .from(issueLabel)
      .innerJoin(label, eq(label.id, issueLabel.labelId))
      .where(inArray(issueLabel.issueId, issueIds))
      .orderBy(label.name)
      .all())
      labels.set(r.issueId, [...(labels.get(r.issueId) ?? []), { name: r.name, color: r.color, description: r.description }]);
    for (const r of db
      .select({ issueId: issueAssignee.issueId, username: user.username })
      .from(issueAssignee)
      .innerJoin(user, eq(user.id, issueAssignee.userId))
      .where(inArray(issueAssignee.issueId, issueIds))
      .orderBy(user.username)
      .all())
      assignees.set(r.issueId, [...(assignees.get(r.issueId) ?? []), r.username!]);
  }
  return { labels, assignees };
}

function presentAll(rows: IssueRow[]) {
  const meta = issueMeta(rows.map((r) => r.issue.id));
  return rows.map((r) => ({ ...present(r), labels: meta.labels.get(r.issue.id) ?? [], assignees: meta.assignees.get(r.issue.id) ?? [] }));
}

const present = (r: IssueRow) => ({
  number: r.issue.number,
  title: r.issue.title,
  body: r.issue.body,
  state: r.issue.state,
  isPull: r.issue.isPull,
  draft: r.issue.draft,
  base: r.issue.baseRef,
  head: r.issue.headRef,
  mergeCommit: r.issue.mergeCommit,
  mergeMethod: r.issue.mergeMethod,
  mergedBy: r.mergedBy,
  author: r.author,
  comments: r.comments,
  createdAt: r.issue.createdAt,
  updatedAt: r.issue.updatedAt,
});

function listComments(issueId: number) {
  return db
    .select({ id: comment.id, body: comment.body, author: user.username, createdAt: comment.createdAt })
    .from(comment)
    .innerJoin(user, eq(comment.authorId, user.id))
    .where(eq(comment.issueId, issueId))
    .orderBy(asc(comment.id))
    .all();
}

// Allocates the next shared issue/PR number and inserts atomically.
function insertIssue(a: RepoAccess, viewer: Viewer, values: Partial<typeof issue.$inferInsert> & { title: string }) {
  return db.transaction((tx) => {
    const { number } = tx
      .update(repo)
      .set({ nextNumber: sql`${repo.nextNumber} + 1` })
      .where(eq(repo.id, a.repo.id))
      .returning({ number: sql<number>`${repo.nextNumber} - 1` })
      .get()!;
    tx.insert(issue).values({ ...values, repoId: a.repo.id, number, authorId: viewer.id }).run();
    return number;
  });
}

function listIssues(a: RepoAccess, isPull: boolean, q: Record<string, string | undefined>) {
  const wanted = q.state === "closed" ? (isPull ? ["closed", "merged"] : ["closed"]) : ["open"];
  const filters = [eq(issue.repoId, a.repo.id), eq(issue.isPull, isPull), inArray(issue.state, wanted as ("open" | "closed" | "merged")[])];
  if (q.label)
    filters.push(
      inArray(
        issue.id,
        db.select({ id: issueLabel.issueId }).from(issueLabel).innerJoin(label, eq(label.id, issueLabel.labelId)).where(and(eq(label.repoId, a.repo.id), eq(label.name, q.label.toLowerCase()))),
      ),
    );
  // ?draft=true lists only drafts, ?draft=false only pull requests ready for review.
  if (isPull && (q.draft === "true" || q.draft === "false")) filters.push(eq(issue.draft, q.draft === "true"));
  if (q.assignee)
    filters.push(
      inArray(
        issue.id,
        db.select({ id: issueAssignee.issueId }).from(issueAssignee).innerJoin(user, eq(user.id, issueAssignee.userId)).where(eq(user.username, q.assignee.toLowerCase())),
      ),
    );
  const rows = issueRows(a.repo.id)
    .where(and(...filters))
    .orderBy(desc(issue.number))
    .all();
  const counts = db
    .select({ state: issue.state, n: count() })
    .from(issue)
    .where(and(eq(issue.repoId, a.repo.id), eq(issue.isPull, isPull)))
    .groupBy(issue.state)
    .all();
  const open = counts.find((c) => c.state === "open")?.n ?? 0;
  const closed = counts.filter((c) => c.state !== "open").reduce((s, c) => s + c.n, 0);
  return { items: presentAll(rows), open, closed };
}

// Environments currently running the pull request's head commit.
async function headDeployments(a: RepoAccess, row: IssueRow) {
  if (!row.issue.headRef) return [];
  const sha = await git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`);
  return sha ? deployedAt(a.repo.id, sha) : [];
}

// Team names stay within the organization, as on its teams page: someone who can only read the repository
// and isn't a member sees how many teams were asked, not which.
function hideTeams<T extends { teamRequests: string[] }>(summary: T, a: RepoAccess, viewerId: string): T & { teamRequestCount: number } {
  const count = summary.teamRequests.length;
  if (allows(a.role, "write") || (viewerId && orgRole(a.repo.ownerId, viewerId)))
    return { ...summary, teamRequestCount: count };
  return { ...summary, teamRequests: [], teamRequestCount: count };
}

export const issueRoutes = new Elysia()
  // ---------- issues ----------
  .get("/repos/:owner/:repo/issues", async ({ request, params, query }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    return listIssues(a, false, query as Record<string, string>);
  })
  .post("/repos/:owner/:repo/issues", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const b = body as Body;
    const title = str(b?.title, TITLE_MAX).trim();
    if (!title) throw new HttpError(400, "Title is required");
    const text = str(b?.body, BODY_MAX);
    const number = insertIssue(a, viewer, { title, body: text });
    record(a.repo.id, viewer.id, "issue_opened", { number, title });
    void sideEffect("Notifying", () => notify(mentioned([text]), "mention", viewer.id, { repoId: a.repo.id, issueNumber: number, title, excerpt: text }));
    return { issue: { number } };
  })
  .get("/repos/:owner/:repo/issues/:number", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    if (viewer.id) void sideEffect("Marking notifications read", () => markRead(viewer.id, a.repo.id, row.issue.number));
    return { issue: presentAll([row])[0], comments: listComments(row.issue.id), role: a.role };
  })
  .patch("/repos/:owner/:repo/issues/:number", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    if (row.issue.authorId !== viewer.id && !allows(a.role, "write")) throw new HttpError(403, "Only the author or collaborators with write access can edit this");
    const b = body as Body;
    const set: Partial<typeof issue.$inferInsert> = {};
    if (typeof b?.title === "string" && b.title.trim()) set.title = str(b.title, TITLE_MAX).trim();
    if (typeof b?.body === "string") set.body = str(b.body, BODY_MAX);
    if (b?.state === "open" || b?.state === "closed") {
      if (row.issue.state === "merged") throw new HttpError(409, "Merged pull requests cannot be reopened or closed");
      set.state = b.state;
    }
    // Only an open pull request moves between draft and ready; the author or a writer may do it.
    if (typeof b?.draft === "boolean" && b.draft !== row.issue.draft) {
      if (!row.issue.isPull) throw new HttpError(400, "Only pull requests can be drafts");
      if (row.issue.state !== "open") throw new HttpError(409, "Only an open pull request can be marked as a draft or ready for review");
      set.draft = b.draft;
    }
    // An open pull request can be pointed at another base branch, e.g. once the one it was stacked on is gone.
    if (typeof b?.base === "string" && b.base !== row.issue.baseRef) {
      if (!row.issue.isPull) throw new HttpError(400, "Only pull requests have a base branch");
      if (row.issue.state !== "open") throw new HttpError(409, "Only an open pull request can change its base branch");
      const base = str(b.base, 255);
      if (base === row.issue.headRef) throw new HttpError(400, "The base branch must differ from the head branch");
      if (!(await git.resolveCommit(a.path, `refs/heads/${base}`))) throw new HttpError(400, `No branch named ${base}`);
      set.baseRef = base;
    }
    // Under the merge lock, so a merge doesn't retarget pull requests around a base that's changing.
    // A base only changes while the pull request is still open once the lock is held: a merge or close may have
    // come first.
    if (Object.keys(set).length)
      await underMergeLock(() => {
        const where = set.baseRef ? and(eq(issue.id, row.issue.id), eq(issue.state, "open")) : eq(issue.id, row.issue.id);
        const changed = db.update(issue).set(set).where(where).returning({ id: issue.id }).all();
        if (set.baseRef && !changed.length) throw new HttpError(409, "Only an open pull request can change its base branch");
      });
    // A new base can bring other code owners.
    if (set.baseRef && !set.draft && !set.state) await sideEffect("Asking code owners", () => requestCodeOwners(a.repo.id, row.issue.number));
    // Ready (or reopened) and not a draft: the code owners of its files are asked for a review.
    if (row.issue.isPull && (set.draft === false || (set.state === "open" && row.issue.state !== "open"))) await sideEffect("Asking code owners", () => requestCodeOwners(a.repo.id, row.issue.number));
    // Marked ready on an open pull request (one being reopened gets its own run below): workflows that listen for it run.
    if (set.draft === false && (!set.state || set.state === row.issue.state) && allows(a.role, "write")) await sideEffect("Starting pull request workflows", () => onPullRequest(a.repo.id, a.path, row.issue.number, "ready_for_review", viewer.id));
    if (set.state && set.state !== row.issue.state) {
      const ref = { number: row.issue.number, title: set.title ?? row.issue.title };
      if (row.issue.isPull) {
        record(a.repo.id, viewer.id, set.state === "closed" ? "pull_closed" : "pull_reopened", { ...ref, base: row.issue.baseRef, head: row.issue.headRef });
        // Starting runs (with secrets and deployments) takes write access, which an author may have lost since.
        if (set.state === "open" && allows(a.role, "write")) await sideEffect("Starting pull request workflows", () => onPullRequest(a.repo.id, a.path, row.issue.number, "reopened", viewer.id));
      }
      else record(a.repo.id, viewer.id, set.state === "closed" ? "issue_closed" : "issue_reopened", ref);
      if (set.state === "closed") void sideEffect("Notifying", () => notifyThread(row.issue.id, "closed", viewer.id, { repoId: a.repo.id, issueNumber: row.issue.number, title: ref.title }));
    }
    return { ok: true };
  })
  .post("/repos/:owner/:repo/issues/:number/comments", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    const text = str((body as Body)?.body, BODY_MAX);
    if (!text.trim()) throw new HttpError(400, "Comment cannot be empty");
    db.insert(comment).values({ issueId: row.issue.id, authorId: viewer.id, body: text }).run();
    db.update(issue).set({ updatedAt: new Date() }).where(eq(issue.id, row.issue.id)).run();
    record(a.repo.id, viewer.id, "comment", { number: row.issue.number, title: row.issue.title, isPull: row.issue.isPull, excerpt: excerpt(text) });
    void sideEffect("Notifying", () => notifyThread(row.issue.id, "comment", viewer.id, { repoId: a.repo.id, issueNumber: row.issue.number, title: row.issue.title, excerpt: text }, [text]));
    return { ok: true };
  })
  // ---------- pull requests ----------
  .get("/repos/:owner/:repo/pulls", async ({ request, params, query }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    return listIssues(a, true, query as Record<string, string>);
  })
  .post("/repos/:owner/:repo/pulls", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const b = body as Body;
    const title = str(b?.title, TITLE_MAX).trim();
    const base = str(b?.base, 255);
    const head = str(b?.head, 255);
    if (!title) throw new HttpError(400, "Title is required");
    if (!base || !head || base === head) throw new HttpError(400, "Choose two different branches");
    for (const branch of [base, head])
      if (!(await git.resolveCommit(a.path, `refs/heads/${branch}`))) throw new HttpError(400, `No branch named ${branch}`);
    const text = str(b?.body, BODY_MAX);
    const number = insertIssue(a, viewer, { title, body: text, isPull: true, draft: b?.draft === true, baseRef: base, headRef: head });
    record(a.repo.id, viewer.id, "pull_opened", { number, title, base, head });
    void sideEffect("Notifying", () => notify(mentioned([text]), "mention", viewer.id, { repoId: a.repo.id, issueNumber: number, title, excerpt: text }));
    await sideEffect("Asking code owners", () => requestCodeOwners(a.repo.id, number));
    await sideEffect("Starting pull request workflows", () => onPullRequest(a.repo.id, a.path, number, "opened", viewer.id));
    return { pull: { number } };
  })
  .get("/repos/:owner/:repo/pulls/:number", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findPull(a, params.number);
    if (viewer.id) void sideEffect("Marking notifications read", () => markRead(viewer.id, a.repo.id, row.issue.number));
    return {
      pull: presentAll([row])[0],
      comments: listComments(row.issue.id),
      role: a.role,
      requireApproval: a.repo.requireApproval,
      requireChecks: a.repo.requireChecks,
      requireCodeOwnerReview: a.repo.requireCodeOwnerReview,
      mergeMethods: allowedMethods(a.repo),
      codeOwners: await ownerStatus(a.repo.id, row.issue.number).catch(() => null),
      stack: await stackOf(a, row),
      headDeletable: await headDeletable(a, row),
      checks: await headChecks(a.path, a.repo.id, row.issue),
      deployments: await headDeployments(a, row),
      ...hideTeams(reviewSummary(row.issue.id), a, viewer.id),
      ...(await pullStatus(a, row)),
    };
  })
  .post("/repos/:owner/:repo/pulls/:number/merge", async ({ request, params, body }) => {
    const b = body as Body;
    const deleteBranch = b?.deleteBranch === true;
    const method = b?.method === undefined ? null : b.method;
    if (method !== null && method !== "merge" && method !== "squash" && method !== "rebase") throw new HttpError(400, "method must be merge, squash or rebase");
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const title = typeof b?.title === "string" && b.title.trim() ? str(b.title, TITLE_MAX).trim() : null;
    const message = typeof b?.message === "string" ? str(b.message, BODY_MAX) : null;
    return mergePull(a, viewer, params.number, { method, deleteBranch, title, message });
  });
