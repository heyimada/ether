import { Elysia } from "elysia";
import { HttpError, requireRepo, requireUser } from "../access";
import { refusal } from "../branch-rules";
import { onPush } from "../ci";
import { recordPushEvents } from "../events";
import * as git from "../git";
import { branchRules } from "../protection";

// Git's own rules for branch names, plus what `git branch` refuses on top: a leading - and HEAD.
export function validBranch(name: string) {
  return name.length > 0 && name.length <= 100 && !name.startsWith("-") && name !== "HEAD" && Bun.spawnSync(["git", "check-ref-format", `refs/heads/${name}`]).exitCode === 0;
}

// A branch, tag or full commit id the new branch starts at; never anything rev-parse would read as more.
async function startPoint(path: string, from: string): Promise<string | null> {
  for (const ref of [`refs/heads/${from}`, `refs/tags/${from}`]) {
    const sha = await git.resolveCommit(path, ref);
    if (sha) return sha;
  }
  return /^[0-9a-f]{40}$/.test(from) ? git.resolveCommit(path, from) : null;
}

export const branchRoutes = new Elysia().post("/repos/:owner/:repo/branches", async ({ request, params, body }) => {
  const viewer = await requireUser(request);
  const a = requireRepo(viewer, params.owner, params.repo, "write");
  const { name, from } = (body ?? {}) as { name?: unknown; from?: unknown };
  if (typeof name !== "string" || !validBranch(name)) throw new HttpError(400, "That isn't a valid branch name");
  if (typeof from !== "string" || !from) throw new HttpError(400, "Choose what to create the branch from");
  const sha = await startPoint(a.path, from);
  if (!sha) throw new HttpError(400, `No branch, tag or commit named ${from}`);
  const before = await git.listRefs(a.path);
  if (before.some((r) => r.kind === "branch" && r.name === name)) throw new HttpError(409, `A branch named ${name} already exists`);
  // The same rules a push that creates the branch would meet; the repository has branches already, so it isn't fresh.
  const refused = await refusal(
    branchRules(a.repo.id),
    { ref: `refs/heads/${name}`, old: "0".repeat(40), new: sha },
    { isAncestor: async () => true, branches: async () => before.filter((r) => r.kind === "branch").map((r) => r.name), freshRepo: false },
  );
  if (refused) throw new HttpError(409, refused);
  // An empty old value makes git refuse if the branch appeared in the meantime. It also refuses a name
  // that would nest under an existing branch or have one nested under it, such as a/b next to a.
  try {
    await git.gitText(a.path, ["update-ref", "-m", "create branch", `refs/heads/${name}`, sha, ""]);
  } catch {
    throw new HttpError(409, `${name} clashes with an existing branch`);
  }
  // Creating a branch here is a push as far as the activity feed and CI are concerned.
  const after = await git.listRefs(a.path);
  await recordPushEvents(a.repo.id, viewer.id, a.path, before, after);
  await onPush(a.repo.id, a.path, before, after, viewer.id);
  return { branch: { name, sha } };
});
