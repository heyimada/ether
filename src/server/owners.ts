// Code owners on pull requests: who owns the files a pull request changes, asking them for a review when it
// opens or is marked ready, and whether they have approved when the repository requires it.
import { and, eq, inArray } from "drizzle-orm";
import { allows, repoAccess } from "./access";
import { CODEOWNERS_PATHS, ownedFiles, ownerText, parseCodeOwners, type CodeOwners, type Owner, type Problem } from "./codeowners";
import { db } from "./db/client";
import { issue, organization, repo, review, reviewRequest, team, teamMember, teamRepo, teamReviewRequest, user } from "./db/schema";
import * as git from "./git";
import { notify, quietly, teamMembers } from "./notify";

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
  // Like a user owner, a team has to be able to write: through its own grant on the repository, or the
  // organization's base permission. Its members count only as far as they can write themselves.
  const repoId = db.select({ id: repo.id }).from(repo).where(and(eq(repo.ownerId, target.ownerId), eq(repo.name, target.repoName))).get()?.id;
  const grant = repoId === undefined ? undefined : db.select({ role: teamRepo.role }).from(teamRepo).where(and(eq(teamRepo.teamId, t.id), eq(teamRepo.repoId, repoId))).get();
  const base = db.select({ base: organization.basePermission }).from(organization).where(eq(organization.userId, target.ownerId)).get()?.base;
  if (grant?.role !== "write" && base !== "write") return { text, userIds: [], teamId: null, valid: false };
  const members = db.select({ id: teamMember.userId }).from(teamMember).where(eq(teamMember.teamId, t.id)).all();
  const writers = members.filter((m) => {
    const access = repoAccess({ id: m.id }, target.ownerName, target.repoName);
    return !!access && allows(access.role, "write");
  });
  return { text, userIds: writers.map((m) => m.id), teamId: t.id, valid: true };
}

// `files` lists up to MAX_SHOWN_FILES of the group's files; `fileCount` counts them all.
export type OwnerGroup = { pattern: string; line: number; owners: { name: string; valid: boolean }[]; files: string[]; fileCount: number; approvedBy: string | null };
export type OwnerStatus = { path: string; groups: OwnerGroup[]; problems: Problem[]; incomplete: boolean };

const MAX_SHOWN_FILES = 20;

// The code owners of what a pull request would bring in, judged by CODEOWNERS on its base branch, and for each
// group of files whether one of its owners (other than the author) approved. Null when there is no CODEOWNERS.
// `at` pins the base and head commits, so a merge checks exactly what it merges.
export async function ownerStatus(repoId: number, number: number, at?: { base: string; head: string }): Promise<OwnerStatus | null> {
  return (await evaluate(repoId, number, at))?.status ?? null;
}

async function evaluate(repoId: number, number: number, at?: { base: string; head: string }): Promise<{ status: OwnerStatus; resolved: Resolved[][] } | null> {
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
  const [base, head] = at
    ? [at.base, at.head]
    : row.issue.state === "merged" && row.issue.mergedBase && row.issue.mergedHead
    ? [row.issue.mergedBase, row.issue.mergedHead]
    : merged
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
    return { pattern: rule.pattern, line: rule.line, owners: resolved[i].map((r) => ({ name: r.text, valid: r.valid })), files: paths.slice(0, MAX_SHOWN_FILES), fileCount: paths.length, approvedBy: by ? by[1].name : null };
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
      // A member's review answers the team's request, so a team one of whose members (other than the author)
      // already reviewed isn't asked again; nor is a team that is only the author.
      const others = r.userIds.filter((id) => id !== pr.authorId);
      if (others.length && !others.some((id) => reviewed.has(id))) teams.add(r.teamId);
    } else for (const id of r.userIds) if (id !== pr.authorId && !reviewed.has(id)) users.add(id);
  }
  const added = db.transaction((tx) => ({
    users: users.size ? tx.insert(reviewRequest).values([...users].map((userId) => ({ issueId: pr.id, userId }))).onConflictDoNothing().returning({ id: reviewRequest.userId }).all() : [],
    teams: teams.size ? tx.insert(teamReviewRequest).values([...teams].map((teamId) => ({ issueId: pr.id, teamId }))).onConflictDoNothing().returning({ id: teamReviewRequest.teamId }).all() : [],
  }));
  // Only those newly asked hear about it. CODEOWNERS asks on the author's behalf.
  const asked = [...added.users.map((u) => u.id), ...teamMembers(added.teams.map((t) => t.id))].filter((id) => id !== pr.authorId && !reviewed.has(id));
  quietly(() => notify(asked, "review_requested", pr.authorId, { repoId, issueNumber: number, title: pr.title }));
}

// A review by a team member answers the requests made of their teams.
export function answerTeamRequests(issueId: number, userId: string) {
  const mine = db.select({ id: teamMember.teamId }).from(teamMember).where(eq(teamMember.userId, userId)).all().map((t) => t.id);
  if (mine.length) db.delete(teamReviewRequest).where(and(eq(teamReviewRequest.issueId, issueId), inArray(teamReviewRequest.teamId, mine))).run();
}
