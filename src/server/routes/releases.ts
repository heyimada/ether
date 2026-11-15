import { and, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HttpError, readerOrVisitor, requireRepo, requireUser, type RepoAccess } from "../access";
import { config } from "../config";
import { db } from "../db/client";
import { release, releaseAsset, user } from "../db/schema";
import { record } from "../events";
import * as git from "../git";
import { BodyIncomplete, BodyTooLarge, writeBody } from "../upload";

const MAX_ASSET = 500 * 1024 * 1024;
const ASSET_RE = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}$/;
const releaseDir = (id: number) => join(config.dataDir, "releases", String(id));

// Git's own rules for ref names; no repository needed.
function validTag(tag: string) {
  return tag.length > 0 && tag.length <= 100 && Bun.spawnSync(["git", "check-ref-format", `refs/tags/${tag}`]).exitCode === 0;
}

function present(a: RepoAccess, r: typeof release.$inferSelect, author: string | null) {
  const assets = db.select().from(releaseAsset).where(eq(releaseAsset.releaseId, r.id)).orderBy(releaseAsset.name).all();
  return {
    tag: r.tag,
    title: r.title,
    notes: r.notes,
    prerelease: r.prerelease,
    author,
    createdAt: r.createdAt,
    assets: assets.map((x) => ({ name: x.name, size: x.size })),
    archive: { zip: `/api/repos/${a.owner}/${a.repo.name}/releases/${encodeURIComponent(r.tag)}/source.zip` },
  };
}

function findRelease(a: RepoAccess, tag: string) {
  const r = db.select().from(release).where(and(eq(release.repoId, a.repo.id), eq(release.tag, tag))).get();
  if (!r) throw new HttpError(404, "No such release");
  return r;
}

const authorName = (id: string) => db.select({ u: user.username }).from(user).where(eq(user.id, id)).get()?.u ?? null;

export const releaseRoutes = new Elysia()
  .get("/repos/:owner/:repo/releases", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const rows = db.select().from(release).where(eq(release.repoId, a.repo.id)).orderBy(desc(release.createdAt), desc(release.id)).all();
    return { releases: rows.map((r) => present(a, r, authorName(r.authorId))) };
  })
  .get("/repos/:owner/:repo/releases/:tag", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const r = findRelease(a, params.tag);
    return { release: present(a, r, authorName(r.authorId)) };
  })
  .post("/repos/:owner/:repo/releases", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const { tag, target, title, notes, prerelease } = (body ?? {}) as Record<string, unknown>;
    if (typeof tag !== "string" || !validTag(tag)) throw new HttpError(400, "That isn't a valid tag name");
    if (db.select().from(release).where(and(eq(release.repoId, a.repo.id), eq(release.tag, tag))).get()) throw new HttpError(409, "That tag already has a release");
    // Use the tag if it exists; otherwise cut it from the target branch.
    if (!(await git.resolveCommit(a.path, `refs/tags/${tag}`))) {
      if (typeof target !== "string") throw new HttpError(400, "Choose a branch to create the tag from");
      const sha = await git.resolveCommit(a.path, `refs/heads/${target}`);
      if (!sha) throw new HttpError(400, `No branch named ${target}`);
      await git.gitText(a.path, ["update-ref", `refs/tags/${tag}`, sha, ""]);
    }
    const created = db
      .insert(release)
      .values({
        repoId: a.repo.id,
        tag,
        title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : tag,
        notes: typeof notes === "string" ? notes.slice(0, 100_000) : "",
        prerelease: prerelease === true,
        authorId: viewer.id,
      })
      .returning()
      .get();
    record(a.repo.id, viewer.id, "release", { tag, title: created.title, prerelease: created.prerelease });
    return { release: { tag } };
  })
  .patch("/repos/:owner/:repo/releases/:tag", async ({ request, params, body }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const r = findRelease(a, params.tag);
    const b = (body ?? {}) as Record<string, unknown>;
    const set: Partial<typeof release.$inferInsert> = {};
    if (typeof b.title === "string" && b.title.trim()) set.title = b.title.trim().slice(0, 200);
    if (typeof b.notes === "string") set.notes = b.notes.slice(0, 100_000);
    if (typeof b.prerelease === "boolean") set.prerelease = b.prerelease;
    if (Object.keys(set).length) db.update(release).set(set).where(eq(release.id, r.id)).run();
    return { ok: true };
  })
  // Deleting a release keeps its tag, like GitHub.
  .delete("/repos/:owner/:repo/releases/:tag", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const r = findRelease(a, params.tag);
    db.delete(release).where(eq(release.id, r.id)).run();
    rmSync(releaseDir(r.id), { recursive: true, force: true });
    return { ok: true };
  })
  .put("/repos/:owner/:repo/releases/:tag/assets/:name", { parse: "none" }, async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const r = findRelease(a, params.tag);
    if (!ASSET_RE.test(params.name)) throw new HttpError(400, "Asset names are letters, digits, '.', '_', '+' or '-'");
    const length = request.headers.get("content-length");
    const expected = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
    if ((expected ?? 0) > MAX_ASSET) throw new HttpError(413, "Assets can be at most 500 MB");
    const existing = db.select().from(releaseAsset).where(and(eq(releaseAsset.releaseId, r.id), eq(releaseAsset.name, params.name))).get();
    const row = existing ?? db.insert(releaseAsset).values({ releaseId: r.id, name: params.name, size: 0 }).returning().get();
    mkdirSync(releaseDir(r.id), { recursive: true });
    const file = join(releaseDir(r.id), String(row.id));
    let size: number;
    try {
      size = await writeBody(request.body, file, MAX_ASSET, expected);
    } catch (e) {
      // A failed upload changes nothing: a replaced asset keeps its old file, a new one is forgotten.
      if (!existing) db.delete(releaseAsset).where(eq(releaseAsset.id, row.id)).run();
      if (e instanceof BodyTooLarge) throw new HttpError(413, "Assets can be at most 500 MB");
      if (e instanceof BodyIncomplete) throw new HttpError(400, `The upload was cut off (${e.message})`);
      throw e;
    }
    db.update(releaseAsset).set({ size }).where(eq(releaseAsset.id, row.id)).run();
    return { asset: { name: params.name, size } };
  })
  .get("/repos/:owner/:repo/releases/:tag/assets/:name", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const r = findRelease(a, params.tag);
    const row = db.select().from(releaseAsset).where(and(eq(releaseAsset.releaseId, r.id), eq(releaseAsset.name, params.name))).get();
    const file = row && join(releaseDir(r.id), String(row.id));
    if (!row || !file || !existsSync(file)) throw new HttpError(404, "No such asset");
    return new Response(Bun.file(file), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${row.name}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  })
  .delete("/repos/:owner/:repo/releases/:tag/assets/:name", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const r = findRelease(a, params.tag);
    const row = db.select().from(releaseAsset).where(and(eq(releaseAsset.releaseId, r.id), eq(releaseAsset.name, params.name))).get();
    if (row) {
      db.delete(releaseAsset).where(eq(releaseAsset.id, row.id)).run();
      rmSync(join(releaseDir(r.id), String(row.id)), { force: true });
    }
    return { ok: true };
  })
  .get("/repos/:owner/:repo/releases/:tag/source.zip", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    const r = findRelease(a, params.tag);
    const res = await git.git(a.path, ["archive", "--format=zip", `--prefix=${a.repo.name}-${r.tag}/`, "--end-of-options", `refs/tags/${r.tag}`]);
    if (res.code !== 0) throw new HttpError(404, "The tag no longer exists");
    return new Response(new Blob([res.stdout as Uint8Array<ArrayBuffer>]), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${a.repo.name}-${r.tag}.zip"`, "X-Content-Type-Options": "nosniff" },
    });
  });
