import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import { HttpError, readerOrVisitor, requireRepo, requireUser, type RepoAccess } from "../access";
import { record } from "../events";
import * as git from "../git";

// Page slugs are file names without ".md"; titles show hyphens as spaces, like GitHub wikis.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const titleToSlug = (title: string) =>
  title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 100);
const slugToTitle = (slug: string) => slug.replace(/-/g, " ");

function checkSlug(slug: string) {
  if (!SLUG_RE.test(slug) || slug.includes("..") || slug.endsWith(".md")) throw new HttpError(400, "That isn't a valid page name");
}

const wikiOf = (a: RepoAccess) => git.wikiPath(a.path);

async function pages(wiki: string) {
  if (!existsSync(wiki) || !(await git.resolveCommit(wiki, "refs/heads/main"))) return [];
  const entries = (await git.readTree(wiki, "refs/heads/main", "")) ?? [];
  return entries
    .filter((e) => e.type === "blob" && e.name.endsWith(".md"))
    .map((e) => ({ slug: e.name.slice(0, -3), title: slugToTitle(e.name.slice(0, -3)) }))
    .sort((x, y) => (x.slug === "Home" ? -1 : y.slug === "Home" ? 1 : x.title.localeCompare(y.title)));
}

export const wikiRoutes = new Elysia()
  .get("/repos/:owner/:repo/wiki", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    return { pages: await pages(wikiOf(a)) };
  })
  .get("/repos/:owner/:repo/wiki/:slug", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    checkSlug(params.slug);
    const wiki = wikiOf(a);
    const file = `${params.slug}.md`;
    const blob = existsSync(wiki) ? await git.readBlob(wiki, "refs/heads/main", file).catch(() => null) : null;
    if (!blob || blob.content === null) throw new HttpError(404, "No such page");
    const [last] = await git.log(wiki, "refs/heads/main", { path: file, limit: 1 });
    const revisions = Number((await git.gitText(wiki, ["rev-list", "--count", "refs/heads/main", "--", file])).trim());
    return { slug: params.slug, title: slugToTitle(params.slug), content: blob.content, lastEdit: last ?? null, revisions, pages: await pages(wiki) };
  })
  .get("/repos/:owner/:repo/wiki/:slug/history", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    checkSlug(params.slug);
    const wiki = wikiOf(a);
    if (!existsSync(wiki)) throw new HttpError(404, "No such page");
    return { slug: params.slug, title: slugToTitle(params.slug), revisions: await git.log(wiki, "refs/heads/main", { path: `${params.slug}.md`, limit: 100 }) };
  })
  // Creates or updates a page; a changed title renames the file in the same commit.
  .put("/repos/:owner/:repo/wiki/:slug", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    checkSlug(params.slug);
    const b = (body ?? {}) as { title?: unknown; content?: unknown; message?: unknown };
    if (typeof b.content !== "string") throw new HttpError(400, "content is required");
    const target = typeof b.title === "string" && b.title.trim() ? titleToSlug(b.title) : params.slug;
    checkSlug(target);
    const wiki = await git.ensureWiki(a.path);
    const existing = (await pages(wiki)).map((p) => p.slug);
    if (target !== params.slug && existing.includes(target)) throw new HttpError(409, "A page with that title already exists");
    const isNew = !existing.includes(params.slug);
    const message = typeof b.message === "string" && b.message.trim() ? b.message.trim().slice(0, 200) : `${isNew ? "Create" : "Update"} ${slugToTitle(target)}`;
    try {
      await git.wikiCommit(
        wiki,
        { file: `${target}.md`, content: b.content.slice(0, 1_000_000), renameFrom: isNew ? undefined : `${params.slug}.md` },
        message,
        { name: viewer.username, email: `${viewer.username}@users.ether.invalid` },
      );
    } catch (e) {
      if (e instanceof git.WikiConflict) throw new HttpError(409, e.message);
      throw e;
    }
    record(a.repo.id, viewer.id, "wiki", { slug: target, title: slugToTitle(target), created: isNew });
    return { slug: target };
  })
  .delete("/repos/:owner/:repo/wiki/:slug", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    checkSlug(params.slug);
    const wiki = wikiOf(a);
    if (!(await pages(wiki)).some((p) => p.slug === params.slug)) throw new HttpError(404, "No such page");
    await git.wikiCommit(wiki, { file: `${params.slug}.md`, content: null }, `Delete ${slugToTitle(params.slug)}`, {
      name: viewer.username,
      email: `${viewer.username}@users.ether.invalid`,
    });
    return { ok: true };
  });
