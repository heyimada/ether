// Merging a pull request on the server, and what it moves along: the head branch, the pull requests stacked on it,
// and the workflows and code owner requests that follow.
import { Mutex } from "async-mutex";
import { and, eq, ne } from "drizzle-orm";
import { HttpError, type RepoAccess, type Viewer } from "./access";
import { commitChecks } from "./ci";
import { db } from "./db/client";
import { issue } from "./db/schema";
import { record } from "./events";
import * as git from "./git";
import { notifyThread } from "./notify";
import { missingOwners, ownerStatus, requestCodeOwners } from "./owners";
import { MAX_STACK, findPull, headDeletable, longLivedBranches, openPulls, reviewDecision } from "./pulls";
import { refsMoved } from "./push";
import { sideEffect } from "./side-effect";

// Merges, and base changes that pull requests stacked around a merge depend on, happen one at a time.
const merges = new Mutex();
export const underMergeLock = <T>(fn: () => Promise<T> | T) => merges.runExclusive(fn);

export const allowedMethods = (r: { allowMergeCommit: boolean; allowSquashMerge: boolean; allowRebaseMerge: boolean }): git.MergeMethod[] => [
  ...(r.allowMergeCommit ? (["merge"] as const) : []),
  ...(r.allowSquashMerge ? (["squash"] as const) : []),
  ...(r.allowRebaseMerge ? (["rebase"] as const) : []),
];

const REFUSED: Record<Exclude<git.MergeResult, { ok: true }>["reason"], (how: git.MergeMethod) => string> = {
  conflict: (how) => (how === "rebase" ? "These commits can't be rebased onto the base branch without conflicts" : "The branches have conflicts"),
  missing: () => "A branch no longer exists",
  raced: () => "A branch changed while merging; try again",
  merges: () => "This branch has merge commits, which can't be rebased; merge or squash it instead",
  empty: () => "There's nothing to rebase",
};

export type MergeRequest = { method: git.MergeMethod | null; deleteBranch: boolean; title: string | null; message: string | null };

export function mergePull(a: RepoAccess, viewer: Viewer, number: string, req: MergeRequest) {
  return underMergeLock(async () => {
    const row = findPull(a, number);
    const pr = row.issue;
    if (pr.state !== "open") throw new HttpError(409, "This pull request is not open");
    if (pr.draft) throw new HttpError(409, "This pull request is still a draft; mark it ready for review first");
    if (a.repo.requireApproval && reviewDecision(pr.id) !== "approved") throw new HttpError(409, "Merging requires an approving review");
    // The commits every check below looks at, and the merge then takes or refuses as raced.
    const [baseAt, headAt] = await Promise.all([git.resolveCommit(a.path, `refs/heads/${pr.baseRef}`), git.resolveCommit(a.path, `refs/heads/${pr.headRef}`)]);
    if (!baseAt || !headAt) throw new HttpError(409, "A branch no longer exists");
    if (a.repo.requireCodeOwnerReview) {
      const owners = await ownerStatus(a.repo.id, pr.number, { base: baseAt, head: headAt });
      const missing = owners && missingOwners(owners);
      if (owners && !missing) throw new HttpError(409, "Code owners can't be worked out for this pull request, so it can't be merged while their review is required");
      if (missing?.length) throw new HttpError(409, `Merging requires a review from code owners of ${missing.map((g) => g.pattern).join(", ")}`);
    }
    if (a.repo.requireChecks) {
      const checks = commitChecks(a.repo.id, headAt, pr.number);
      if (checks && checks.status !== "success") throw new HttpError(409, "Merging requires passing checks");
    }
    const allowed = allowedMethods(a.repo);
    const how = req.method ?? allowed[0];
    if (!how || !allowed.includes(how)) throw new HttpError(409, `This repository doesn't allow ${how === "squash" ? "squash merging" : how === "rebase" ? "rebase merging" : "merge commits"}`);
    const committer = git.userIdentity(viewer.username);
    const commits = how === "squash" ? await git.rangeCommits(a.path, baseAt, headAt) : [];
    const message =
      how === "squash"
        ? `${req.title ?? `${pr.title} (#${pr.number})`}\n\n${req.message ?? commits.reverse().map((c) => `* ${c.subject}`).join("\n")}`
        : `${req.title ?? `Merge pull request #${pr.number} from ${pr.headRef}`}\n\n${req.message ?? pr.title}`;
    // Decided before the merge: the branch is deletable for what it is now, not for the merged pull request.
    const deletable = req.deleteBranch && (await headDeletable(a, row));
    const result = await git.mergeBranches(a.path, pr.baseRef!, pr.headRef!, message, committer, { base: baseAt, head: headAt }, { method: how, author: git.userIdentity(row.author!) });
    if (!result.ok) throw new HttpError(409, REFUSED[result.reason](how));
    // After a squash or rebase nothing in the base reaches the merged commits, and deleting the branch would leave
    // them to garbage collection; this hidden ref keeps them, so the merged pull request still shows what it brought in.
    await sideEffect("Keeping the merged commits", () => git.keepRef(a.path, `refs/ether/pull/${pr.number}/head`, headAt));
    db.update(issue).set({ state: "merged", mergeCommit: result.sha, mergedBy: viewer.id, mergeMethod: how, mergedBase: baseAt, mergedHead: headAt }).where(eq(issue.id, pr.id)).run();
    void sideEffect("Notifying", () => notifyThread(pr.id, "merged", viewer.id, { repoId: a.repo.id, issueNumber: pr.number, title: pr.title }));
    record(a.repo.id, viewer.id, "pull_merged", { number: pr.number, title: pr.title, base: pr.baseRef, head: pr.headRef });
    // Deleting the head branch, when asked and allowed, is what moves pull requests stacked on it, as on GitHub:
    // their diff stays their own changes, since the merge brought the commits they share into the base branch, and
    // a branch that stays (develop, a release branch) keeps the pull requests going into it.
    const deletedBranch = deletable ? (await git.git(a.path, ["update-ref", "-m", "delete merged branch", "-d", `refs/heads/${pr.headRef}`, headAt])).code === 0 : false;
    const retargeted = deletedBranch
      ? db
          .update(issue)
          .set({ baseRef: pr.baseRef })
          .where(and(openPulls(a.repo.id), eq(issue.baseRef, pr.headRef!), ne(issue.headRef, pr.baseRef!)))
          .returning({ number: issue.number })
          .all()
          .map((p) => p.number)
      : [];
    const movedRefs: { before: git.Ref; after: git.Ref }[] = [{ before: { name: pr.baseRef!, kind: "branch", sha: baseAt }, after: { name: pr.baseRef!, kind: "branch", sha: result.sha } }];
    const restacked = how !== "merge" && retargeted.length ? await restackOnto(a, retargeted, headAt, result.sha, committer, movedRefs) : [];
    for (const n of retargeted) void sideEffect("Asking code owners", () => requestCodeOwners(a.repo.id, n));
    // Merging moves the base branch (and restacking the branches on it) like a push would: their workflows run.
    void refsMoved({ id: a.repo.id, path: a.path }, movedRefs.map((m) => m.before), movedRefs.map((m) => m.after), viewer.id);
    return { ok: true, sha: result.sha, method: how, deletedBranch, retargeted, restacked };
  });
}

// After a squash or rebase the base has new commits for the merged ones, so the pull requests moved onto it would
// show those changes again. Their own commits are made again on top of it, as a rebase --onto would, and each
// rewritten branch carries the pull requests stacked on it along, down the whole stack. One that can't be (a
// conflict, merge commits, a protected branch) is left as it was. Adds every branch it moves to `movedRefs`.
async function restackOnto(a: RepoAccess, retargeted: number[], since: string, onto: string, committer: git.Identity, movedRefs: { before: git.Ref; after: git.Ref }[]) {
  const longLived = await longLivedBranches(a);
  const restacked: number[] = [];
  const queue = retargeted.map((n) => ({ n, since, onto }));
  while (queue.length && restacked.length < MAX_STACK) {
    const { n, since, onto } = queue.shift()!;
    const up = db.select({ head: issue.headRef }).from(issue).where(and(eq(issue.repoId, a.repo.id), eq(issue.number, n))).get();
    if (!up?.head || longLived(up.head)) continue;
    const moved = await git.restack(a.path, up.head, since, onto, committer).catch((e) => (console.error(`Restacking ${up.head} failed:`, e), { ok: false as const }));
    if (!moved.ok) continue;
    restacked.push(n);
    movedRefs.push({ before: { name: up.head, kind: "branch", sha: moved.before }, after: { name: up.head, kind: "branch", sha: moved.sha } });
    for (const next of db.select({ number: issue.number }).from(issue).where(and(openPulls(a.repo.id), eq(issue.baseRef, up.head))).all())
      if (!restacked.includes(next.number)) queue.push({ n: next.number, since: moved.before, onto: moved.sha });
  }
  return restacked;
}
