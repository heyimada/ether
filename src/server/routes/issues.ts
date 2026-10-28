import { Mutex } from "async-mutex";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Elysia } from "elysia";
import { HttpError, allows, readerOrVisitor, requireRepo, requireUser, type RepoAccess, type Viewer } from "../access";
import { db } from "../db/client";
import { comment, issue, issueAssignee, issueLabel, label, repo, user } from "../db/schema";
import * as git from "../git";
import { latestRun } from "../ci";
import { deployedAt } from "../deploy";
import { excerpt, record } from "../events";
import { reviewSummary } from "./reviews";

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

// The CI run for the pull request's head commit, if any.
async function headChecks(a: RepoAccess, row: NonNullable<IssueRow>) {
  if (!row.issue.headRef) return null;
  const sha = await git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`);
  const run = sha ? latestRun(a.repo.id, sha) : null;
  return run ? { id: run.id, status: run.status } : null;
}

// Environments currently running the pull request's head commit.
async function headDeployments(a: RepoAccess, row: NonNullable<IssueRow>) {
  if (!row.issue.headRef) return [];
  const sha = await git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`);
  return sha ? deployedAt(a.repo.id, sha) : [];
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
    if (Object.keys(set).length) db.update(issue).set(set).where(eq(issue.id, row.issue.id)).run();
    if (set.state && set.state !== row.issue.state) {
      const ref = { number: row.issue.number, title: set.title ?? row.issue.title };
      if (row.issue.isPull)
        record(a.repo.id, viewer.id, set.state === "closed" ? "pull_closed" : "pull_reopened", { ...ref, base: row.issue.baseRef, head: row.issue.headRef });
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
    const number = insertIssue(a, viewer, { title, body: str(b?.body, 65536), isPull: true, baseRef: base, headRef: head });
    record(a.repo.id, viewer.id, "pull_opened", { number, title, base, head });
    return { pull: { number } };
  })
  .get("/repos/:owner/:repo/pulls/:number", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    if (!row.issue.isPull) throw new HttpError(404, "Not a pull request");
    return {
      pull: presentAll([row])[0],
      comments: listComments(row.issue.id),
      role: a.role,
      requireApproval: a.repo.requireApproval,
      requireChecks: a.repo.requireChecks,
      checks: await headChecks(a, row),
      deployments: await headDeployments(a, row),
      ...reviewSummary(row.issue.id),
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
      // With protection on, merging needs an approval and no outstanding request for changes.
      const decision = reviewSummary(row.issue.id).reviewDecision;
      if (a.repo.requireApproval && decision !== "approved") throw new HttpError(409, "Merging requires an approving review");
      if (a.repo.requireChecks) {
        const checks = await headChecks(a, row);
        if (checks && checks.status !== "success") throw new HttpError(409, "Merging requires passing checks");
      }
      const result = await git.mergeBranches(
        a.path,
        row.issue.baseRef!,
        row.issue.headRef!,
        `Merge pull request #${row.issue.number} from ${row.issue.headRef}\n\n${row.issue.title}`,
        { name: viewer.username, email: `${viewer.username}@users.ether.invalid` },
      );
      if (!result.ok) {
        const reason = { conflict: "The branches have conflicts", missing: "A branch no longer exists", raced: "The base branch changed; try again" }[result.reason];
        throw new HttpError(409, reason);
      }
      db.update(issue).set({ state: "merged", mergeCommit: result.sha, mergedBy: viewer.id }).where(eq(issue.id, row.issue.id)).run();
      record(a.repo.id, viewer.id, "pull_merged", { number: row.issue.number, title: row.issue.title, base: row.issue.baseRef, head: row.issue.headRef });
      return { ok: true, sha: result.sha };
    });
  });
