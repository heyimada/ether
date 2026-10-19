import { and, asc, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, allows, findUser, readableRepos, repoAccess, requireRepo, requireUser } from "../access";
import { db } from "../db/client";
import { issue, review, reviewComment, reviewRequest, user } from "../db/schema";
import * as git from "../git";
import { findIssue, pullStatus } from "./issues";

export type Decision = "approved" | "changes_requested" | null;

// Line numbers on the new side of a unified diff, per file: the lines a review can comment on.
export function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "");
      current = path === "/dev/null" ? null : new Set();
      if (current) files.set(path, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!current || raw.startsWith("diff ") || raw.startsWith("--- ") || raw.startsWith("\\")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) current.add(line++);
  }
  return files;
}

// Reviews with their line comments, outstanding requests, and the overall decision: changes
// requested if any reviewer's latest verdict asks for them, else approved if anyone approved.
export function reviewSummary(issueId: number) {
  const rows = db
    .select({ r: review, author: user.username })
    .from(review)
    .innerJoin(user, eq(user.id, review.authorId))
    .where(eq(review.issueId, issueId))
    .orderBy(asc(review.id))
    .all();
  const comments = rows.length
    ? db.select().from(reviewComment).where(inArray(reviewComment.reviewId, rows.map((x) => x.r.id))).orderBy(asc(reviewComment.id)).all()
    : [];
  const latest = new Map<string, "approved" | "changes_requested">();
  for (const { r, author } of rows) if (r.state !== "commented") latest.set(author!, r.state);
  const verdicts = [...latest.values()];
  const decision: Decision = verdicts.includes("changes_requested") ? "changes_requested" : verdicts.includes("approved") ? "approved" : null;
  const requests = db
    .select({ username: user.username })
    .from(reviewRequest)
    .innerJoin(user, eq(user.id, reviewRequest.userId))
    .where(eq(reviewRequest.issueId, issueId))
    .orderBy(user.username)
    .all()
    .map((x) => x.username!);
  return {
    reviews: rows.map(({ r, author }) => ({
      id: r.id,
      author,
      state: r.state,
      body: r.body,
      commitSha: r.commitSha,
      createdAt: r.createdAt,
      comments: comments.filter((c) => c.reviewId === r.id).map((c) => ({ path: c.path, line: c.line, body: c.body })),
    })),
    reviewRequests: requests,
    reviewers: Object.fromEntries(latest),
    reviewDecision: decision,
  };
}

export const reviewRoutes = new Elysia()
  .put("/repos/:owner/:repo/pulls/:number/reviewers", async ({ request, params, body }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const row = findIssue(a, params.number);
    if (!row.issue.isPull) throw new HttpError(404, "Not a pull request");
    const names = (body as { reviewers?: unknown } | null)?.reviewers;
    if (!Array.isArray(names) || names.length > 15 || names.some((n) => typeof n !== "string")) throw new HttpError(400, "reviewers must be a list of usernames");
    const ids = [...new Set(names as string[])].map((n) => {
      const u = findUser(n);
      if (!u || !repoAccess({ id: u.id }, a.owner, a.repo.name)) throw new HttpError(400, `${n} can't see this repository`);
      if (u.id === row.issue.authorId) throw new HttpError(400, "Authors can't review their own pull request");
      return u.id;
    });
    db.transaction((tx) => {
      tx.delete(reviewRequest).where(eq(reviewRequest.issueId, row.issue.id)).run();
      if (ids.length) tx.insert(reviewRequest).values(ids.map((userId) => ({ issueId: row.issue.id, userId }))).run();
    });
    return { ok: true };
  })
  .post("/repos/:owner/:repo/pulls/:number/reviews", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findIssue(a, params.number);
    if (!row.issue.isPull) throw new HttpError(404, "Not a pull request");
    if (row.issue.state !== "open") throw new HttpError(409, "This pull request is not open");
    const b = (body ?? {}) as { state?: unknown; body?: unknown; comments?: unknown };
    const state = b.state;
    if (state !== "approved" && state !== "changes_requested" && state !== "commented") throw new HttpError(400, "state must be approved, changes_requested or commented");
    if (state !== "commented") {
      if (row.issue.authorId === viewer.id) throw new HttpError(400, "Authors can't approve or request changes on their own pull request");
      if (!allows(a.role, "write")) throw new HttpError(403, "Only people with write access can approve or request changes");
    }
    const comments = Array.isArray(b.comments) ? (b.comments as { path?: unknown; line?: unknown; body?: unknown }[]) : [];
    const text = typeof b.body === "string" ? b.body.slice(0, 65536) : "";
    if (state === "commented" && !text.trim() && comments.length === 0) throw new HttpError(400, "A comment review needs a summary or line comments");
    const status = await pullStatus(a, row);
    if (status.missing) throw new HttpError(409, "A branch of this pull request no longer exists");
    const lines = commentableLines(status.diff);
    const checked = comments.map((c) => {
      if (typeof c.path !== "string" || typeof c.line !== "number" || typeof c.body !== "string" || !c.body.trim()) throw new HttpError(400, "Each line comment needs a path, line and body");
      if (!lines.get(c.path)?.has(c.line)) throw new HttpError(400, `${c.path}:${c.line} is not a line in this diff`);
      return { path: c.path, line: c.line, body: c.body.slice(0, 65536) };
    });
    const headSha = (await git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`))!;
    db.transaction((tx) => {
      const r = tx.insert(review).values({ issueId: row.issue.id, authorId: viewer.id, state, body: text, commitSha: headSha }).returning({ id: review.id }).get();
      if (checked.length) tx.insert(reviewComment).values(checked.map((c) => ({ ...c, reviewId: r.id }))).run();
      // A submitted review answers the request.
      tx.delete(reviewRequest).where(and(eq(reviewRequest.issueId, row.issue.id), eq(reviewRequest.userId, viewer.id))).run();
    });
    return { ok: true };
  })
  .get("/me/review-requests", async ({ request }) => {
    const viewer = await requireUser(request);
    const readable = new Map(readableRepos(viewer.id).map((r) => [r.id, r]));
    return {
      pulls: db
        .select({ number: issue.number, title: issue.title, repoId: issue.repoId })
        .from(reviewRequest)
        .innerJoin(issue, eq(issue.id, reviewRequest.issueId))
        .where(and(eq(reviewRequest.userId, viewer.id), eq(issue.state, "open")))
        .all()
        .flatMap((p) => {
          const r = readable.get(p.repoId);
          return r ? [{ owner: r.owner, repo: r.name, number: p.number, title: p.title }] : [];
        }),
    };
  });
