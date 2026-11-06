// Code owners on pull requests: who owns the files a pull request changes, asking them for a review when it
// opens or is marked ready, and whether they have approved when the repository requires it.
import { and, eq, inArray } from "drizzle-orm";
import { allows, repoAccess } from "./access";
import { CODEOWNERS_PATHS, ownedFiles, ownerText, parseCodeOwners, type CodeOwners, type Owner, type Problem } from "./codeowners";
import { db } from "./db/client";
import { issue, repo, review, reviewRequest, team, teamMember, teamReviewRequest, user } from "./db/schema";
import * as git from "./git";

export type LoadedOwners = { path: string; co: CodeOwners } | { path: string; co: null; problems: Problem[] };

// The first CODEOWNERS file at a commit, parsed.
export async function readCodeOwners(repoPath: string, rev: string): Promise<LoadedOwners | null> {
  for (const path of CODEOWNERS_PATHS) {
    const blob = await git.readBlob(repoPath, rev, path);
    if (!blob) continue;
    if (blob.content === null) return { path, co: null, problems: [{ line: 0, message: blob.binary ? "CODEOWNERS isn't a text file" : "CODEOWNERS is too large and is ignored" }] };
    return { path, co: parseCodeOwners(blob.content) };
  }
  return null;
}

type Resolved = { text: string; userIds: string[]; teamId: number | null; valid: boolean };

// An owner as accounts: a user with write access, or a team of the organization that owns the repository.
// Anyone else can't approve for the repository, so they're listed but don't count, as on GitHub.
function resolveOwner(o: Owner, target: { repoName: string; ownerName: string; ownerId: string }): Resolved {
  const text = ownerText(o);
  if (o.kind === "user") {
    const u = db.select({ id: user.id }).from(user).where(eq(user.username, o.name)).get();
    const access = u ? repoAccess({ id: u.id }, target.ownerName, target.repoName) : null;
    return access && allows(access.role, "write") ? { text, userIds: [u!.id], teamId: null, valid: true } : { text, userIds: [], teamId: null, valid: false };
  }
  if (o.org !== target.ownerName.toLowerCase()) return { text, userIds: [], teamId: null, valid: false };
  const t = db.select({ id: team.id }).from(team).where(and(eq(team.orgId, target.ownerId), eq(team.name, o.team))).get();
  if (!t) return { text, userIds: [], teamId: null, valid: false };
  const members = db.select({ id: teamMember.userId }).from(teamMember).where(eq(teamMember.teamId, t.id)).all();
  return { text, userIds: members.map((m) => m.id), teamId: t.id, valid: true };
}

export type OwnerGroup = { pattern: string; line: number; owners: { name: string; valid: boolean }[]; files: string[]; approvedBy: string | null };
export type OwnerStatus = { path: string; groups: OwnerGroup[]; problems: Problem[]; incomplete: boolean };

const MAX_SHOWN_FILES = 20;

// The code owners of what a pull request would bring in, judged by CODEOWNERS on its base branch, and for each
// group of files whether one of its owners (other than the author) approved. Null when there is no CODEOWNERS.
export async function ownerStatus(repoId: number, number: number): Promise<OwnerStatus | null> {
  return (await evaluate(repoId, number))?.status ?? null;
}

async function evaluate(repoId: number, number: number): Promise<{ status: OwnerStatus; resolved: Resolved[][] } | null> {
  const row = db
    .select({ issue, repoName: repo.name, ownerId: repo.ownerId, ownerName: user.username })
    .from(issue)
    .innerJoin(repo, eq(repo.id, issue.repoId))
    .innerJoin(user, eq(user.id, repo.ownerId))
    .where(and(eq(issue.repoId, repoId), eq(issue.number, number)))
    .get();
  if (!row?.issue.isPull || !row.issue.baseRef || !row.issue.headRef) return null;
  const path = git.repoPath(row.ownerName!, row.repoName);
  const merged = row.issue.state === "merged" && row.issue.mergeCommit;
  const [base, head] = merged
    ? [`${row.issue.mergeCommit}^1`, `${row.issue.mergeCommit}^2`]
    : await Promise.all([git.resolveCommit(path, `refs/heads/${row.issue.baseRef}`), git.resolveCommit(path, `refs/heads/${row.issue.headRef}`)]);
  if (!base || !head) return null;
  const loaded = await readCodeOwners(path, base);
  if (!loaded) return null;
  if (!loaded.co) return { status: { path: loaded.path, groups: [], problems: loaded.problems, incomplete: false }, resolved: [] };
  const files = await git.diffNames(path, [`${base}...${head}`]);
  const owned = files ? ownedFiles(loaded.co, files) : null;
  if (!owned) return { status: { path: loaded.path, groups: [], problems: loaded.co.problems, incomplete: true }, resolved: [] };

  // Approvals: each reviewer's latest verdict, as in the review decision; the author's own never counts.
  const latest = new Map<string, { name: string; state: string }>();
  for (const r of db
    .select({ authorId: review.authorId, state: review.state, name: user.username })
    .from(review)
    .innerJoin(user, eq(user.id, review.authorId))
    .where(eq(review.issueId, row.issue.id))
    .orderBy(review.id)
    .all())
    if (r.state !== "commented") latest.set(r.authorId, { name: r.name!, state: r.state });
  latest.delete(row.issue.authorId);
  const approvers = [...latest].filter(([, v]) => v.state === "approved");

  const target = { repoName: row.repoName, ownerName: row.ownerName!, ownerId: row.ownerId };
  const cache = new Map<string, Resolved>();
  const resolve = (o: Owner) => cache.get(ownerText(o)) ?? cache.set(ownerText(o), resolveOwner(o, target)).get(ownerText(o))!;
  // In the order of CODEOWNERS, not of the files.
  const rules = [...owned].sort(([a], [b]) => a.line - b.line);
  const resolved = rules.map(([rule]) => rule.owners.map(resolve));
  const groups = rules.map(([rule, paths], i): OwnerGroup => {
    const ids = new Set(resolved[i].flatMap((r) => r.userIds));
    const by = approvers.find(([id]) => ids.has(id));
    return { pattern: rule.pattern, line: rule.line, owners: resolved[i].map((r) => ({ name: r.text, valid: r.valid })), files: paths.slice(0, MAX_SHOWN_FILES), approvedBy: by ? by[1].name : null };
  });
  return { status: { path: loaded.path, groups, problems: loaded.co.problems, incomplete: false }, resolved };
}

// Groups still waiting for an owner's approval. A group whose owners can't approve (none valid, or only the author)
// still waits: someone with write access has to fix CODEOWNERS or turn the rule off, as on GitHub.
export const missingOwners = (s: OwnerStatus) => (s.incomplete ? null : s.groups.filter((g) => !g.approvedBy));

// When a pull request opens, is marked ready or its branch moves: ask the owners of its files for a review.
// Drafts wait until they're ready; people who already reviewed and the author aren't asked again.
export async function requestCodeOwners(repoId: number, number: number) {
  const pr = db.select().from(issue).where(and(eq(issue.repoId, repoId), eq(issue.number, number))).get();
  if (!pr?.isPull || pr.state !== "open" || pr.draft) return;
  const result = await evaluate(repoId, number);
  if (!result?.resolved.length) return;
  const reviewed = new Set(db.select({ id: review.authorId }).from(review).where(eq(review.issueId, pr.id)).all().map((r) => r.id));
  const users = new Set<string>();
  const teams = new Set<number>();
  for (const r of result.resolved.flat()) {
    if (!r.valid) continue;
    if (r.teamId !== null) {
      // A team whose members all reviewed already (or is only the author) has nothing left to answer.
      if (r.userIds.some((id) => id !== pr.authorId && !reviewed.has(id))) teams.add(r.teamId);
    } else for (const id of r.userIds) if (id !== pr.authorId && !reviewed.has(id)) users.add(id);
  }
  db.transaction((tx) => {
    if (users.size) tx.insert(reviewRequest).values([...users].map((userId) => ({ issueId: pr.id, userId }))).onConflictDoNothing().run();
    if (teams.size) tx.insert(teamReviewRequest).values([...teams].map((teamId) => ({ issueId: pr.id, teamId }))).onConflictDoNothing().run();
  });
}

// A review by a team member answers the requests made of their teams.
export function answerTeamRequests(issueId: number, userId: string) {
  const mine = db.select({ id: teamMember.teamId }).from(teamMember).where(eq(teamMember.userId, userId)).all().map((t) => t.id);
  if (mine.length) db.delete(teamReviewRequest).where(and(eq(teamReviewRequest.issueId, issueId), inArray(teamReviewRequest.teamId, mine))).run();
}
