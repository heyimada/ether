import { Mutex } from "async-mutex";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Elysia } from "elysia";
import { HttpError, allows, readerOrVisitor, requireRepo, requireUser, type RepoAccess, type Viewer } from "../access";
import { db } from "../db/client";
import { comment, issue, issueAssignee, issueLabel, label, orgMember, repo, user } from "../db/schema";
import * as git from "../git";
import { commitChecks, onPullRequest, onPush } from "../ci";
import { deployedAt } from "../deploy";
import { excerpt, record } from "../events";
import { reviewSummary } from "./reviews";
import { missingOwners, ownerStatus, requestCodeOwners } from "../owners";

const merges = new Mutex();
const mergedByUser = alias(user, "merged_by_user");

type Body = Record<string, unknown> | undefined;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function issueRows(repoId: number) {
  return db
    .select({
      issue,
      author: user.username,
      mergedBy: mergedByUser.username,
      comments: sql<number>`(SELECT count(*) FROM ${comment} WHERE ${comment.issueId} = ${issue.id})`,
    })
    .from(issue)
    .innerJoin(user, eq(issue.authorId, user.id))
    .leftJoin(mergedByUser, eq(issue.mergedBy, mergedByUser.id))
    .where(eq(issue.repoId, repoId))
    .$dynamic();
}

type IssueRow = Awaited<ReturnType<ReturnType<typeof issueRows>["get"]>>;

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

function presentAll(rows: NonNullable<IssueRow>[]) {
  const meta = issueMeta(rows.map((r) => r.issue.id));
  return rows.map((r) => ({ ...present(r), labels: meta.labels.get(r.issue.id) ?? [], assignees: meta.assignees.get(r.issue.id) ?? [] }));
}

const present = (r: NonNullable<IssueRow>) => ({
  number: r.issue.number,
  title: r.issue.title,
  body: r.issue.body,
  state: r.issue.state,
  isPull: r.issue.isPull,
  draft: r.issue.draft,
  base: r.issue.baseRef,
  head: r.issue.headRef,
  mergeCommit: r.issue.mergeCommit,
  mergedBy: r.mergedBy,
  author: r.author,
  comments: r.comments,
  createdAt: r.issue.createdAt,
  updatedAt: r.issue.updatedAt,
});

export function findIssue(a: RepoAccess, number: string) {
  const row = issueRows(a.repo.id).where(and(eq(issue.repoId, a.repo.id), eq(issue.number, Number(number)))).get();
  if (!row) throw new HttpError(404, "No such issue or pull request");
  return row;
}

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

// The checks of the pull request's head commit, one per workflow and event, if any ran.
async function headChecks(a: RepoAccess, row: NonNullable<IssueRow>) {
  if (!row.issue.headRef) return null;
  const sha = await git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`);
  return sha ? commitChecks(a.repo.id, sha, row.issue.number) : null;
}

// Environments currently running the pull request's head commit.
async function headDeployments(a: RepoAccess, row: NonNullable<IssueRow>) {
  if (!row.issue.headRef) return [];
  const sha = await git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`);
  return sha ? deployedAt(a.repo.id, sha) : [];
}

// Team names stay within the organization, as on its teams page: someone who can only read the repository
// and isn't a member sees how many teams were asked, not which.
function hideTeams<T extends { teamRequests: string[] }>(summary: T, a: RepoAccess, viewerId: string): T & { teamRequestCount: number } {
  const count = summary.teamRequests.length;
  if (allows(a.role, "write") || (viewerId && db.select().from(orgMember).where(and(eq(orgMember.orgId, a.repo.ownerId), eq(orgMember.userId, viewerId))).get()))
    return { ...summary, teamRequestCount: count };
  return { ...summary, teamRequests: [], teamRequestCount: count };
}

export async function pullStatus(a: RepoAccess, row: NonNullable<IssueRow>) {
  const base = row.issue.baseRef!;
  const head = row.issue.headRef!;
  if (row.issue.state === "merged" && row.issue.mergeCommit) {
    const merged = row.issue.mergeCommit;
    const { diff, truncated } = await git.showCommit(a.path, merged);
    const commits = await git.rangeCommits(a.path, `${merged}^1`, `${merged}^2`);
    return { mergeable: false, conflicts: [], commits, diff, truncated, missing: false };
  }
  const baseSha = await git.resolveCommit(a.path, `refs/heads/${base}`);
  const headSha = await git.resolveCommit(a.path, `refs/heads/${head}`);
  if (!baseSha || !headSha) return { mergeable: false, conflicts: [], commits: [], diff: "", truncated: false, missing: true };
  const [cmp, merge] = await Promise.all([git.compare(a.path, baseSha, headSha), git.mergeTree(a.path, baseSha, headSha)]);
  return { ...cmp, mergeable: merge.clean, conflicts: merge.clean ? [] : merge.conflicts, missing: false };
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
    const title = str(b?.title, 256).trim();
    if (!title) throw new HttpError(400, "Title is required");
    const number = insertIssue(a, viewer, { title, body: str(b?.body, 65536) });
    record(a.repo.id, viewer.id, "issue_opened", { number, title });
    return { issue: { number } };
  })
  .get("/repos/:owner/:repo/issues/:number", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    return { issue: presentAll([row])[0], comments: listComments(row.issue.id), role: a.role };
  })
  .patch("/repos/:owner/:repo/issues/:number", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    if (row.issue.authorId !== viewer.id && !allows(a.role, "write")) throw new HttpError(403, "Only the author or collaborators with write access can edit this");
    const b = body as Body;
    const set: Partial<typeof issue.$inferInsert> = {};
    if (typeof b?.title === "string" && b.title.trim()) set.title = str(b.title, 256).trim();
    if (typeof b?.body === "string") set.body = str(b.body, 65536);
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
    if (Object.keys(set).length) db.update(issue).set(set).where(eq(issue.id, row.issue.id)).run();
    // Ready (or reopened) and not a draft: the code owners of its files are asked for a review.
    if (row.issue.isPull && (set.draft === false || (set.state === "open" && row.issue.state !== "open"))) await requestCodeOwners(a.repo.id, row.issue.number).catch(() => {});
    // Marked ready on an open pull request (one being reopened gets its own run below): workflows that listen for it run.
    if (set.draft === false && (!set.state || set.state === row.issue.state) && allows(a.role, "write")) await onPullRequest(a.repo.id, a.path, row.issue.number, "ready_for_review", viewer.id).catch(() => {});
    if (set.state && set.state !== row.issue.state) {
      const ref = { number: row.issue.number, title: set.title ?? row.issue.title };
      if (row.issue.isPull) {
        record(a.repo.id, viewer.id, set.state === "closed" ? "pull_closed" : "pull_reopened", { ...ref, base: row.issue.baseRef, head: row.issue.headRef });
        // Starting runs (with secrets and deployments) takes write access, which an author may have lost since.
        if (set.state === "open" && allows(a.role, "write")) await onPullRequest(a.repo.id, a.path, row.issue.number, "reopened", viewer.id).catch(() => {});
      }
      else record(a.repo.id, viewer.id, set.state === "closed" ? "issue_closed" : "issue_reopened", ref);
    }
    return { ok: true };
  })
  .post("/repos/:owner/:repo/issues/:number/comments", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    const text = str((body as Body)?.body, 65536);
    if (!text.trim()) throw new HttpError(400, "Comment cannot be empty");
    db.insert(comment).values({ issueId: row.issue.id, authorId: viewer.id, body: text }).run();
    db.update(issue).set({ updatedAt: new Date() }).where(eq(issue.id, row.issue.id)).run();
    record(a.repo.id, viewer.id, "comment", { number: row.issue.number, title: row.issue.title, isPull: row.issue.isPull, excerpt: excerpt(text) });
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
    const title = str(b?.title, 256).trim();
    const base = str(b?.base, 255);
    const head = str(b?.head, 255);
    if (!title) throw new HttpError(400, "Title is required");
    if (!base || !head || base === head) throw new HttpError(400, "Choose two different branches");
    for (const branch of [base, head])
      if (!(await git.resolveCommit(a.path, `refs/heads/${branch}`))) throw new HttpError(400, `No branch named ${branch}`);
    const number = insertIssue(a, viewer, { title, body: str(b?.body, 65536), isPull: true, draft: b?.draft === true, baseRef: base, headRef: head });
    record(a.repo.id, viewer.id, "pull_opened", { number, title, base, head });
    await requestCodeOwners(a.repo.id, number).catch(() => {});
    await onPullRequest(a.repo.id, a.path, number, "opened", viewer.id).catch(() => {});
    return { pull: { number } };
  })
  .get("/repos/:owner/:repo/pulls/:number", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    if (!row.issue.isPull) throw new HttpError(404, "Not a pull request");
    return {
      pull: presentAll([row])[0],
      comments: listComments(row.issue.id),
      role: a.role,
      requireApproval: a.repo.requireApproval,
      requireChecks: a.repo.requireChecks,
      requireCodeOwnerReview: a.repo.requireCodeOwnerReview,
      codeOwners: await ownerStatus(a.repo.id, row.issue.number).catch(() => null),
      checks: await headChecks(a, row),
      deployments: await headDeployments(a, row),
      ...hideTeams(reviewSummary(row.issue.id), a, viewer.id),
      ...(await pullStatus(a, row)),
    };
  })
  .post("/repos/:owner/:repo/pulls/:number/merge", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    return merges.runExclusive(async () => {
      const row = findIssue(a, params.number);
      if (!row.issue.isPull) throw new HttpError(404, "Not a pull request");
      if (row.issue.state !== "open") throw new HttpError(409, "This pull request is not open");
      if (row.issue.draft) throw new HttpError(409, "This pull request is still a draft; mark it ready for review first");
      // With protection on, merging needs an approval and no outstanding request for changes.
      const decision = reviewSummary(row.issue.id).reviewDecision;
      if (a.repo.requireApproval && decision !== "approved") throw new HttpError(409, "Merging requires an approving review");
      // The commits every check below looks at, and the merge then takes or refuses as raced.
      const [baseAt, headAt] = await Promise.all([git.resolveCommit(a.path, `refs/heads/${row.issue.baseRef}`), git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`)]);
      if (!baseAt || !headAt) throw new HttpError(409, "A branch no longer exists");
      if (a.repo.requireCodeOwnerReview) {
        const owners = await ownerStatus(a.repo.id, row.issue.number, { base: baseAt, head: headAt });
        const missing = owners && missingOwners(owners);
        if (owners && !missing) throw new HttpError(409, "Code owners can't be worked out for this pull request, so it can't be merged while their review is required");
        if (missing?.length) throw new HttpError(409, `Merging requires a review from code owners of ${missing.map((g) => g.pattern).join(", ")}`);
      }
      if (a.repo.requireChecks) {
        const checks = commitChecks(a.repo.id, headAt, row.issue.number);
        if (checks && checks.status !== "success") throw new HttpError(409, "Merging requires passing checks");
      }
      const before = baseAt;
      const result = await git.mergeBranches(
        a.path,
        row.issue.baseRef!,
        row.issue.headRef!,
        `Merge pull request #${row.issue.number} from ${row.issue.headRef}\n\n${row.issue.title}`,
        { name: viewer.username, email: `${viewer.username}@users.ether.invalid` },
        { base: baseAt, head: headAt },
      );
      if (!result.ok) {
        const reason = { conflict: "The branches have conflicts", missing: "A branch no longer exists", raced: "A branch changed while merging; try again" }[result.reason];
        throw new HttpError(409, reason);
      }
      db.update(issue).set({ state: "merged", mergeCommit: result.sha, mergedBy: viewer.id }).where(eq(issue.id, row.issue.id)).run();
      record(a.repo.id, viewer.id, "pull_merged", { number: row.issue.number, title: row.issue.title, base: row.issue.baseRef, head: row.issue.headRef });
      // Merging moves the base branch like a push would, so its push workflows run on the merge commit.
      const moved = (sha: string | null) => (sha ? [{ name: row.issue.baseRef!, kind: "branch" as const, sha }] : []);
      void onPush(a.repo.id, a.path, moved(before), moved(result.sha), viewer.id).catch(() => {});
      return { ok: true, sha: result.sha };
    });
  });
