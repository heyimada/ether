// What happens when a repository's refs move, whichever way they moved: a push over HTTP or SSH, a branch made in
// the web app, or a merge. Transports only authenticate and run git; everything after that is decided here.
import { and, eq, inArray } from "drizzle-orm";
import { onPullRequest, onPush } from "./ci";
import { recordPush } from "./contrib";
import { db } from "./db/client";
import { issue } from "./db/schema";
import { recordPushEvents } from "./events";
import * as git from "./git";
import { requestCodeOwners } from "./owners";
import { receivePackGuard, type Guard } from "./protection";
import { sideEffect } from "./side-effect";

type Repo = { id: number; path: string };

// `<repo>` or `<repo>.wiki` as a transport names it (without `.git`), or null when it can't be a repository.
// A wiki is the repository's `<repo>.wiki.git`, with the repository's permissions.
export function parseRepoName(owner: string, name: string): { name: string; isWiki: boolean } | null {
  if (!git.NAME_RE.test(owner) || !git.NAME_RE.test(name) || name.startsWith(".")) return null;
  return name.endsWith(".wiki") ? { name: name.slice(0, -5), isWiki: true } : { name, isWiki: false };
}

// The git directory a transport serves: the repository's own, or its wiki, created on first use.
export const gitDir = (repoPath: string, isWiki: boolean) => (isWiki ? git.ensureWiki(repoPath) : Promise.resolve(repoPath));

// What receive-pack needs before it starts: the refs as they are, and the branch rules its hook enforces. Branch
// rules guard the repository's code, not its wiki. Throws ProtectionUnavailable when the rules can't be enforced.
export async function prepareReceive(repoId: number, dir: string, isWiki: boolean): Promise<{ before: git.Ref[]; guard: Guard }> {
  const before = await git.listRefs(dir);
  return { before, guard: isWiki ? { args: [], env: {} } : receivePackGuard(repoId, before.some((r) => r.kind === "branch")) };
}

// After receive-pack exited with `code`. HEAD is fixed even after a failed push, which may have written refs; the
// rest only follows a successful one. `personId` is who pushed, when a person did (a deploy key has none); `actorId`
// is who the push counts as. Only the pusher's own commit emails are learned, and a wiki's history is not news about
// the repository's code.
export async function received(repo: Repo, dir: string, isWiki: boolean, before: git.Ref[], code: number, personId: string | null, actorId: string) {
  await sideEffect("Fixing HEAD", () => git.fixHead(dir));
  if (code !== 0) return;
  const after = await git.listRefs(dir);
  if (personId) await sideEffect("Learning commit emails", async () => recordPush(personId, await git.newAuthorEmails(dir, before.map((r) => r.sha), after.map((r) => r.sha))));
  if (!isWiki) await refsPushed(repo, before, after, actorId);
}

// Refs moved by someone's push, or by a branch made in the web app: the activity feed hears about it, then CI.
export async function refsPushed(repo: Repo, before: git.Ref[], after: git.Ref[], actorId: string) {
  await sideEffect("Recording push events", () => recordPushEvents(repo.id, actorId, repo.path, before, after));
  await refsMoved(repo, before, after, actorId);
}

// Any refs that moved, merges included: push workflows run, and open pull requests whose head branch moved ask
// the code owners of their new files and run their `synchronize` workflows.
export async function refsMoved(repo: Repo, before: git.Ref[], after: git.Ref[], actorId: string) {
  await sideEffect("Starting push workflows", () => onPush(repo.id, repo.path, before, after, actorId));
  const moved = after.filter((ref) => ref.kind === "branch" && before.find((b) => b.kind === "branch" && b.name === ref.name)?.sha !== ref.sha).map((r) => r.name);
  let pulls: { number: number }[] = [];
  await sideEffect("Finding pull requests that moved", () => {
    if (moved.length)
      pulls = db
        .select({ number: issue.number })
        .from(issue)
        .where(and(eq(issue.repoId, repo.id), eq(issue.isPull, true), eq(issue.state, "open"), inArray(issue.headRef, moved)))
        .all();
  });
  for (const p of pulls) {
    await sideEffect("Asking code owners", () => requestCodeOwners(repo.id, p.number));
    await sideEffect("Starting pull request workflows", () => onPullRequest(repo.id, repo.path, p.number, "synchronize", actorId));
  }
}
