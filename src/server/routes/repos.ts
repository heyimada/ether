import { and, count, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, findUser, isOrg, readableRepos, requireRepo, requireUser, readerOrVisitor } from "../access";
import { db } from "../db/client";
import { collaborator, orgMember, repo, star, user } from "../db/schema";
import * as git from "../git";
import { addDefaultLabels } from "./labels";

type Q = Record<string, string | undefined>;

async function resolveRev(path: string, ref: string | undefined): Promise<string> {
  const rev = ref || (await git.headBranch(path));
  const sha = await git.resolveCommit(path, rev);
  if (!sha) throw new HttpError(404, `Unknown ref ${rev}`);
  return sha;
}

const cleanPath = (p: string | undefined) => {
  const path = (p ?? "").replace(/^\/+|\/+$/g, "");
  if (path.split("/").some((s) => s === ".." || s === ".")) throw new HttpError(400, "Invalid path");
  return path;
};

export const repoRoutes = new Elysia()
  .get("/repos", async ({ request }) => {
    const viewer = await readerOrVisitor(request);
    return {
      repos: readableRepos(viewer.id).map((r) => ({
        owner: r.owner,
        name: r.name,
        description: r.description,
        visibility: r.visibility,
        relation: r.relation,
        ownerIsOrg: r.ownerIsOrg,
        mine: r.relation === "owner",
      })),
    };
  })
  .post("/repos", async ({ request, body }) => {
    const viewer = await requireUser(request);
    const { name, description, owner, visibility } = (body ?? {}) as { name?: unknown; description?: unknown; owner?: unknown; visibility?: unknown };
    if (typeof name !== "string" || !git.validRepoName(name))
      throw new HttpError(400, "Repository names are 1-100 letters, digits, '.', '-' or '_', and cannot start with '.' or end in .git");
    if (visibility !== undefined && visibility !== "private" && visibility !== "public") throw new HttpError(400, "Visibility must be private or public");
    // Repositories go to you, or to an organization you own.
    let ownerRow = { id: viewer.id, username: viewer.username };
    if (typeof owner === "string" && owner.toLowerCase() !== viewer.username) {
      const target = findUser(owner);
      if (!target || !isOrg(target.id)) throw new HttpError(403, "You can only create repositories for yourself or an organization");
      const membership = db.select().from(orgMember).where(and(eq(orgMember.orgId, target.id), eq(orgMember.userId, viewer.id))).get();
      if (membership?.role !== "owner") throw new HttpError(403, "Only organization owners can create repositories there");
      ownerRow = { id: target.id, username: target.username! };
    }
    const lower = name.toLowerCase();
    if (db.select().from(repo).where(and(eq(repo.ownerId, ownerRow.id), eq(repo.name, lower))).get())
      throw new HttpError(409, `${ownerRow.username} already has a repository with that name`);

    const path = git.repoPath(ownerRow.username, lower);
    await git.initBare(path);
    const created = db
      .insert(repo)
      .values({ ownerId: ownerRow.id, name: lower, description: typeof description === "string" ? description.slice(0, 500) : "", visibility: visibility ?? "private" })
      .returning({ id: repo.id })
      .get();
    addDefaultLabels(created.id);
    return { repo: { owner: ownerRow.username, name: lower } };
  })
  .get("/repos/:owner/:repo", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const refs = await git.listRefs(a.path);
    const defaultBranch = await git.headBranch(a.path);
    return {
      repo: { owner: a.owner, name: a.repo.name, description: a.repo.description, visibility: a.repo.visibility, defaultBranch, empty: refs.length === 0 },
      stars: db.select({ n: count() }).from(star).where(eq(star.repoId, a.repo.id)).get()!.n,
      starred: !!db.select().from(star).where(and(eq(star.repoId, a.repo.id), eq(star.userId, viewer.id))).get(),
      role: a.role,
      branches: refs.filter((r) => r.kind === "branch").map((r) => r.name),
      tags: refs.filter((r) => r.kind === "tag").map((r) => r.name),
    };
  })
  .patch("/repos/:owner/:repo", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const { description, defaultBranch, visibility } = (body ?? {}) as { description?: unknown; defaultBranch?: unknown; visibility?: unknown };
    if (visibility !== undefined) {
      if (visibility !== "private" && visibility !== "public") throw new HttpError(400, "Visibility must be private or public");
      db.update(repo).set({ visibility }).where(eq(repo.id, a.repo.id)).run();
    }
    if (typeof description === "string") db.update(repo).set({ description: description.slice(0, 500) }).where(eq(repo.id, a.repo.id)).run();
    if (typeof defaultBranch === "string") {
      if (!(await git.resolveCommit(a.path, `refs/heads/${defaultBranch}`))) throw new HttpError(400, "No such branch");
      await git.gitText(a.path, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
    }
    return { ok: true };
  })
  .put("/repos/:owner/:repo/star", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    db.insert(star).values({ userId: viewer.id, repoId: a.repo.id }).onConflictDoNothing().run();
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/star", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    db.delete(star).where(and(eq(star.repoId, a.repo.id), eq(star.userId, viewer.id))).run();
    return { ok: true };
  })
  .delete("/repos/:owner/:repo", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    db.delete(repo).where(eq(repo.id, a.repo.id)).run();
    git.removeRepo(a.path);
    return { ok: true };
  })
  // ---------- collaborators ----------
  .get("/repos/:owner/:repo/collaborators", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const rows = db
      .select({ username: user.username, role: collaborator.role })
      .from(collaborator)
      .innerJoin(user, eq(collaborator.userId, user.id))
      .where(eq(collaborator.repoId, a.repo.id))
      .orderBy(user.username)
      .all();
    return { collaborators: rows };
  })
  .put("/repos/:owner/:repo/collaborators/:username", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const role = (body as { role?: unknown } | undefined)?.role;
    if (role !== "read" && role !== "write") throw new HttpError(400, "Role must be read or write");
    const target = findUser(params.username);
    if (!target) throw new HttpError(404, "No such user");
    if (target.id === a.repo.ownerId) throw new HttpError(400, "The owner already has full access");
    if (isOrg(target.id)) throw new HttpError(400, "Organizations can't be collaborators; add their people instead");
    db.insert(collaborator)
      .values({ repoId: a.repo.id, userId: target.id, role })
      .onConflictDoUpdate({ target: [collaborator.repoId, collaborator.userId], set: { role } })
      .run();
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/collaborators/:username", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "owner");
    const target = findUser(params.username);
    if (target) db.delete(collaborator).where(and(eq(collaborator.repoId, a.repo.id), eq(collaborator.userId, target.id))).run();
    return { ok: true };
  })
  // ---------- browsing ----------
  .get("/repos/:owner/:repo/tree", async ({ request, params, query }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const q = query as Q;
    const sha = await resolveRev(a.path, q.ref);
    const path = cleanPath(q.path);
    const entries = await git.readTree(a.path, sha, path);
    if (!entries) throw new HttpError(404, "No such directory");
    const [[last], commits] = await Promise.all([git.log(a.path, sha, { path, limit: 1 }), git.entryCommits(a.path, sha, path)]);
    return {
      sha,
      path,
      entries: entries.map((e) => ({ ...e, lastCommit: commits[e.name] ?? null })),
      lastCommit: last ?? null,
      commitCount: path ? null : await git.commitCount(a.path, sha),
    };
  })
  .get("/repos/:owner/:repo/blob", async ({ request, params, query }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const q = query as Q;
    const sha = await resolveRev(a.path, q.ref);
    const path = cleanPath(q.path);
    const blob = await git.readBlob(a.path, sha, path);
    if (!blob) throw new HttpError(404, "No such file");
    return { sha, path, ...blob };
  })
  .get("/repos/:owner/:repo/raw", async ({ request, params, query }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const q = query as Q;
    const sha = await resolveRev(a.path, q.ref);
    const path = cleanPath(q.path);
    const bytes = await git.rawBlob(a.path, sha, path);
    if (!bytes) throw new HttpError(404, "No such file");
    // Never let repository content render as HTML on our origin.
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(path.split("/").pop() ?? "file")}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  })
  .get("/repos/:owner/:repo/commits", async ({ request, params, query }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const q = query as Q;
    const sha = await resolveRev(a.path, q.ref);
    const page = Math.max(0, Number(q.page ?? 0) || 0);
    const commits = await git.log(a.path, sha, { path: cleanPath(q.path), skip: page * 30, limit: 31 });
    return { commits: commits.slice(0, 30), hasMore: commits.length > 30 };
  })
  .get("/repos/:owner/:repo/activity", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const sha = await git.resolveCommit(a.path, await git.headBranch(a.path));
    return sha ? git.activity(a.path, sha) : { since: null, weeks: [], total: 0, authors: [] };
  })
  .get("/repos/:owner/:repo/commit/:sha", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    if (!/^[0-9a-f]{4,64}$/i.test(params.sha)) throw new HttpError(400, "Invalid commit id");
    const sha = await git.resolveCommit(a.path, params.sha);
    if (!sha) throw new HttpError(404, "No such commit");
    return git.showCommit(a.path, sha);
  })
  .get("/repos/:owner/:repo/compare", async ({ request, params, query }) => {
    const viewer = await readerOrVisitor(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const q = query as Q;
    const base = await resolveRev(a.path, q.base);
    const head = await resolveRev(a.path, q.head);
    const result = await git.compare(a.path, base, head);
    const merge = await git.mergeTree(a.path, base, head);
    return { ...result, mergeable: merge.clean };
  });
