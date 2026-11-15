// Pull requests: finding them, what they bring in, how they stack and how they're reviewed (merging is merge.ts).
// Issues share their numbering and table, so finding an issue lives here too.
import { and, asc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { HttpError, type RepoAccess } from "./access";
import { effectiveRule } from "./branch-rules";
import { commitChecks } from "./ci";
import { db } from "./db/client";
import { comment, issue, review, reviewComment, reviewRequest, team, teamMember, teamReviewRequest, user } from "./db/schema";
import * as git from "./git";
import { branchRules } from "./protection";

const mergedByUser = alias(user, "merged_by_user");

export function issueRows(repoId: number) {
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

export type IssueRow = NonNullable<Awaited<ReturnType<ReturnType<typeof issueRows>["get"]>>>;

export function findIssue(a: RepoAccess, number: string) {
  const row = issueRows(a.repo.id).where(and(eq(issue.repoId, a.repo.id), eq(issue.number, Number(number)))).get();
  if (!row) throw new HttpError(404, "No such issue or pull request");
  return row;
}

export function findPull(a: RepoAccess, number: string) {
  const row = findIssue(a, number);
  if (!row.issue.isPull) throw new HttpError(404, "Not a pull request");
  return row;
}

type PullIssue = Pick<typeof issue.$inferSelect, "state" | "baseRef" | "headRef" | "mergeCommit" | "mergedBase" | "mergedHead">;

// The two commits a pull request is judged by: what it was merged from, or its branches as they are now. Null when
// a branch is gone. Pull requests merged before the merged commits were stored use the merge commit's parents.
export async function pullRange(path: string, pr: PullIssue): Promise<{ base: string; head: string } | null> {
  if (pr.state === "merged" && pr.mergedBase && pr.mergedHead) return { base: pr.mergedBase, head: pr.mergedHead };
  if (pr.state === "merged" && pr.mergeCommit) return { base: `${pr.mergeCommit}^1`, head: `${pr.mergeCommit}^2` };
  const [base, head] = await Promise.all([git.resolveCommit(path, `refs/heads/${pr.baseRef}`), git.resolveCommit(path, `refs/heads/${pr.headRef}`)]);
  return base && head ? { base, head } : null;
}

export async function pullStatus(a: RepoAccess, row: IssueRow) {
  const pr = row.issue;
  // Merged without the commits it was merged from: what the merge commit changed.
  if (pr.state === "merged" && !(pr.mergedBase && pr.mergedHead) && pr.mergeCommit) {
    const { diff, truncated } = await git.showCommit(a.path, pr.mergeCommit);
    const commits = await git.rangeCommits(a.path, `${pr.mergeCommit}^1`, `${pr.mergeCommit}^2`);
    return { mergeable: false, conflicts: [], commits, diff, truncated, missing: false };
  }
  const range = await pullRange(a.path, pr);
  if (!range) return { mergeable: false, conflicts: [], commits: [], diff: "", truncated: false, missing: true };
  if (pr.state === "merged") return { ...(await git.compare(a.path, range.base, range.head)), mergeable: false, conflicts: [], missing: false };
  const [cmp, merge] = await Promise.all([git.compare(a.path, range.base, range.head), git.mergeTree(a.path, range.base, range.head)]);
  return { ...cmp, mergeable: merge.clean, conflicts: merge.clean ? [] : merge.conflicts, missing: false };
}

// The checks of the pull request's head commit, one per workflow and event, if any ran.
export async function headChecks(path: string, repoId: number, pr: Pick<typeof issue.$inferSelect, "headRef" | "number">) {
  if (!pr.headRef) return null;
  const sha = await git.resolveCommit(path, `refs/heads/${pr.headRef}`);
  return sha ? commitChecks(repoId, sha, pr.number) : null;
}

// ---------- reviews ----------

export type Decision = "approved" | "changes_requested" | null;

// Each reviewer's latest verdict, in the order they gave them. Comments aren't verdicts.
export function latestVerdicts(issueId: number) {
  const latest = new Map<string, { userId: string; username: string; state: "approved" | "changes_requested" }>();
  for (const r of db
    .select({ userId: review.authorId, username: user.username, state: review.state })
    .from(review)
    .innerJoin(user, eq(user.id, review.authorId))
    .where(eq(review.issueId, issueId))
    .orderBy(asc(review.id))
    .all())
    if (r.state !== "commented") latest.set(r.userId, { userId: r.userId, username: r.username!, state: r.state });
  return [...latest.values()];
}

// Changes requested if any reviewer's latest verdict asks for them, else approved if anyone approved.
const decisionOf = (verdicts: { state: string }[]): Decision =>
  verdicts.some((v) => v.state === "changes_requested") ? "changes_requested" : verdicts.some((v) => v.state === "approved") ? "approved" : null;

export const reviewDecision = (issueId: number) => decisionOf(latestVerdicts(issueId));

// Reviews with their line comments, outstanding requests, and the overall decision.
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
  const verdicts = latestVerdicts(issueId);
  const requests = db
    .select({ username: user.username })
    .from(reviewRequest)
    .innerJoin(user, eq(user.id, reviewRequest.userId))
    .where(eq(reviewRequest.issueId, issueId))
    .orderBy(user.username)
    .all()
    .map((x) => x.username!);
  const teamRequests = db
    .select({ org: user.username, name: team.name })
    .from(teamReviewRequest)
    .innerJoin(team, eq(team.id, teamReviewRequest.teamId))
    .innerJoin(user, eq(user.id, team.orgId))
    .where(eq(teamReviewRequest.issueId, issueId))
    .orderBy(team.name)
    .all()
    .map((t) => `${t.org}/${t.name}`);
  return {
    teamRequests,
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
    reviewers: Object.fromEntries(verdicts.map((v) => [v.username, v.state])),
    reviewDecision: decisionOf(verdicts),
  };
}

// Open pull requests waiting for someone's review in the given repositories: asked directly, or through one of
// their teams if they haven't reviewed yet. Drafts and their own pull requests wait. Most recently updated first.
export function requestedOf(userId: string, repoIds: number[], limit = 100) {
  if (!repoIds.length) return [];
  const cols = { id: issue.id, number: issue.number, title: issue.title, repoId: issue.repoId, authorId: issue.authorId, updatedAt: issue.updatedAt };
  const open = and(eq(issue.state, "open"), eq(issue.draft, false), inArray(issue.repoId, repoIds));
  const direct = db
    .select(cols)
    .from(reviewRequest)
    .innerJoin(issue, eq(issue.id, reviewRequest.issueId))
    .where(and(eq(reviewRequest.userId, userId), open))
    .all();
  const reviewed = db.select({ id: review.issueId }).from(review).where(eq(review.authorId, userId));
  const viaTeam = db
    .select(cols)
    .from(teamReviewRequest)
    .innerJoin(teamMember, and(eq(teamMember.teamId, teamReviewRequest.teamId), eq(teamMember.userId, userId)))
    .innerJoin(issue, eq(issue.id, teamReviewRequest.issueId))
    .where(and(open, notInArray(issue.id, reviewed)))
    .all();
  const seen = new Set<number>();
  return [...direct, ...viaTeam]
    .filter((p) => p.authorId !== userId && !seen.has(p.id) && !!seen.add(p.id))
    .sort((a, b) => +b.updatedAt - +a.updatedAt)
    .slice(0, limit);
}

// ---------- stacks ----------

export type StackEntry = { number: number; title: string; draft: boolean; base: string; head: string };
export const MAX_STACK = 25;

// Branches that outlive pull requests: the default branch and protected ones. Pull requests going into or out of
// them aren't stacked on each other (a feature into main isn't "on" a main → release PR), and they're never
// deleted on merge.
export async function longLivedBranches(a: RepoAccess): Promise<(branch: string) => boolean> {
  const main = await git.headBranch(a.path);
  const rules = branchRules(a.repo.id);
  return (branch) => branch === main || effectiveRule(rules, branch) !== null;
}

export const openPulls = (repoId: number) => and(eq(issue.repoId, repoId), eq(issue.isPull, true), eq(issue.state, "open"));

// The open pull requests stacked with this one, bottom first: those whose head branch this one goes into (and
// theirs, and so on), then those that go into this one's head branch. Empty when it stands alone.
export async function stackOf(a: RepoAccess, row: IssueRow): Promise<StackEntry[]> {
  if (!row.issue.isPull || row.issue.state !== "open" || !row.issue.baseRef || !row.issue.headRef) return [];
  const longLived = await longLivedBranches(a);
  const open = db
    .select({ number: issue.number, title: issue.title, draft: issue.draft, base: issue.baseRef, head: issue.headRef })
    .from(issue)
    .where(openPulls(a.repo.id))
    .orderBy(asc(issue.number))
    .all() as StackEntry[];
  // Merged or closed since the row was read.
  const self = open.find((p) => p.number === row.issue.number);
  if (!self) return [];
  const seen = new Set([self.number]);
  const below: StackEntry[] = [];
  for (let at = self; below.length < MAX_STACK && !longLived(at.base); ) {
    const next = open.find((p) => p.head === at.base && !seen.has(p.number));
    if (!next) break;
    seen.add(next.number);
    below.unshift(next);
    at = next;
  }
  // Above may branch out (two pull requests on the same head); they're listed level by level.
  const above: StackEntry[] = [];
  for (const queue = longLived(self.head) ? [] : [self.head]; queue.length && above.length < MAX_STACK; ) {
    const head = queue.shift()!;
    for (const p of open)
      // One coming from a long-lived branch (a back-merge of develop into a feature) isn't stacked on it.
      if (p.base === head && !longLived(p.head) && !seen.has(p.number) && above.length < MAX_STACK) {
        seen.add(p.number);
        above.push(p);
        queue.push(p.head);
      }
  }
  return below.length || above.length ? [...below, self, ...above] : [];
}

// Whether merging may delete the head branch: not a long-lived one, nor one another open pull request comes from,
// nor while a pull request into it couldn't move to this one's base: one coming from that base (a back-merge)
// would end up going into itself, and would be left on a branch that no longer exists.
export async function headDeletable(a: RepoAccess, row: IssueRow): Promise<boolean> {
  const { headRef: head, baseRef: base } = row.issue;
  if (!head || (await longLivedBranches(a))(head)) return false;
  const shared = db.select({ n: issue.number }).from(issue).where(and(openPulls(a.repo.id), eq(issue.headRef, head), ne(issue.id, row.issue.id))).get();
  const stranded = !!base && db.select({ n: issue.number }).from(issue).where(and(openPulls(a.repo.id), eq(issue.baseRef, head), eq(issue.headRef, base))).get();
  return !shared && !stranded;
}
