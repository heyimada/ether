import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, findUser, readableRepos, readerOrVisitor, requireUser, type ReadableRepo } from "../access";
import { config } from "../config";
import { db } from "../db/client";
import { comment, commitEmail, follow, issue, orgMember, organization, pin, profile, review, star, team, user } from "../db/schema";
import { pushSuggestions } from "../contrib";
import { lastActivity, listEvents } from "../events";
import { primaryLanguage } from "../languages";
import { starCounts } from "./repos";
import * as git from "../git";

const MAX_AVATAR = 1024 * 1024;
const MAX_GIF_AVATAR = 2 * 1024 * 1024;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const avatarDir = () => join(config.dataDir, "avatars");

const FIELDS = { displayName: 64, bio: 200, pronouns: 32, company: 64, location: 64, status: 80 } as const;

// Links are rendered as anchors, so only absolute http(s) URLs are stored.
function safeUrl(value: string): string {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `Not a valid link: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "Links must start with http:// or https://");
  if (value.length > 300) throw new HttpError(400, "Links can be at most 300 characters");
  return value;
}

// Raster formats only, recognised by their bytes; SVG could carry script.
function sniffImage(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && String.fromCharCode(...b.subarray(0, 4)) === "GIF8") return "image/gif";
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

const profileRow = (userId: string) => db.select().from(profile).where(eq(profile.userId, userId)).get();

function upsertProfile(userId: string, set: Partial<typeof profile.$inferInsert>) {
  db.insert(profile).values({ userId, ...set }).onConflictDoUpdate({ target: profile.userId, set }).run();
}

function requireTarget(name: string) {
  const target = findUser(name);
  if (!target) throw new HttpError(404, "No such user");
  return target as { id: string; username: string };
}

const people = (ids: string[]) =>
  ids.length === 0
    ? []
    : db
        .select({ username: user.username, displayName: profile.displayName, avatarVersion: profile.avatarVersion })
        .from(user)
        .leftJoin(profile, eq(profile.userId, user.id))
        .where(inArray(user.id, ids))
        .orderBy(user.username)
        .all()
        .map((p) => ({ username: p.username!, displayName: p.displayName ?? "", avatarVersion: p.avatarVersion ?? null }));

type Card = { owner: string; name: string; description: string; visibility: "private" | "public"; createdAt: Date; updatedAt: Date; stars: number; language: { name: string; color: string | null } | null };

// Repository tiles with what lists show next to the name: language, stars and last activity.
async function repoCards(repos: ReadableRepo[], withLanguage: Set<number>): Promise<Map<number, Card>> {
  const ids = repos.map((r) => r.id);
  const updated = lastActivity(ids);
  const stars = starCounts(ids);
  const cards = await Promise.all(
    repos.map(async (r): Promise<[number, Card]> => [
      r.id,
      {
        owner: r.owner,
        name: r.name,
        description: r.description,
        visibility: r.visibility,
        createdAt: r.createdAt,
        updatedAt: updated.get(r.id) ?? r.createdAt,
        stars: stars.get(r.id) ?? 0,
        language: withLanguage.has(r.id) ? await primaryLanguage(r.path).catch(() => null) : null,
      },
    ]),
  );
  return new Map(cards);
}

async function profileReadme(target: { username: string }, readable: ReadableRepo[]) {
  const special = readable.find((r) => r.owner === target.username && r.name === target.username.toLowerCase());
  if (!special) return null;
  const head = await git.resolveCommit(special.path, await git.headBranch(special.path));
  if (!head) return null;
  const entries = (await git.readTree(special.path, head, "")) ?? [];
  const entry = entries.find((e) => e.type === "blob" && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
  if (!entry) return null;
  return (await git.readBlob(special.path, head, entry.path))?.content ?? null;
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

// Commits by any of the user's commit emails plus issues, pull requests and comments, counted
// per day over the last year, only from repositories the viewer can read. The summary splits the
// year into kinds of work, and adds reviews, which the calendar doesn't count.
async function contributions(targetId: string, readable: ReadableRepo[]) {
  const since = new Date(Date.now() - YEAR_MS);
  const counts = new Map<string, number>();
  const summary = { commits: 0, pulls: 0, issues: 0, reviews: 0 };
  const add = (at: number) => counts.set(day(at), (counts.get(day(at)) ?? 0) + 1);
  const emails = new Set(db.select({ email: commitEmail.email }).from(commitEmail).where(eq(commitEmail.userId, targetId)).all().map((e) => e.email));
  if (emails.size) {
    await Promise.all(
      readable.map(async (r) => {
        const head = await git.resolveCommit(r.path, await git.headBranch(r.path));
        if (!head) return;
        for (const c of await git.authorTimes(r.path, head, since))
          if (emails.has(c.email)) {
            add(c.at);
            summary.commits++;
          }
      }),
    );
  }
  const ids = readable.map((r) => r.id);
  if (ids.length) {
    for (const i of db
      .select({ at: issue.createdAt, isPull: issue.isPull })
      .from(issue)
      .where(and(eq(issue.authorId, targetId), inArray(issue.repoId, ids), gte(issue.createdAt, since)))
      .all()) {
      add(i.at.getTime());
      summary[i.isPull ? "pulls" : "issues"]++;
    }
    summary.reviews = db
      .select({ id: review.id })
      .from(review)
      .innerJoin(issue, eq(review.issueId, issue.id))
      .where(and(eq(review.authorId, targetId), inArray(issue.repoId, ids), gte(review.createdAt, since)))
      .all().length;
    for (const c of db
      .select({ at: comment.createdAt })
      .from(comment)
      .innerJoin(issue, eq(comment.issueId, issue.id))
      .where(and(eq(comment.authorId, targetId), inArray(issue.repoId, ids), gte(comment.createdAt, since)))
      .all())
      add(c.at.getTime());
  }
  const days: { date: string; count: number }[] = [];
  for (let t = since.getTime(); t <= Date.now(); t += 24 * 60 * 60 * 1000) days.push({ date: day(t), count: counts.get(day(t)) ?? 0 });
  return { days, total: [...counts.values()].reduce((a, b) => a + b, 0), summary };
}

// Shared by people and organizations: validated partial update of profile fields.
export function applyProfilePatch(userId: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const set: Partial<typeof profile.$inferInsert> = {};
  for (const [key, max] of Object.entries(FIELDS) as [keyof typeof FIELDS, number][]) {
    if (key in b) {
      if (typeof b[key] !== "string") throw new HttpError(400, `${key} must be text`);
      set[key] = (b[key] as string).trim().slice(0, max);
    }
  }
  if ("website" in b) {
    if (typeof b.website !== "string") throw new HttpError(400, "website must be text");
    set.website = safeUrl(b.website.trim());
  }
  if ("socials" in b) {
    if (!Array.isArray(b.socials) || b.socials.some((s) => typeof s !== "string")) throw new HttpError(400, "socials must be a list of links");
    const links = (b.socials as string[]).map((s) => s.trim()).filter(Boolean);
    if (links.length > 4) throw new HttpError(400, "Up to four social links");
    set.socials = JSON.stringify(links.map(safeUrl));
  }
  if (Object.keys(set).length === 0) throw new HttpError(400, "Nothing to change");
  upsertProfile(userId, set);
}

export async function saveAvatar(userId: string, request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_GIF_AVATAR) throw new HttpError(413, "Avatars can be at most 2 MB");
  const bytes = new Uint8Array(await request.arrayBuffer());
  const type = sniffImage(bytes);
  // Animated GIFs are uploaded untouched, so they get more room than re-encoded stills.
  const limit = type === "image/gif" ? MAX_GIF_AVATAR : MAX_AVATAR;
  if (bytes.length > limit) throw new HttpError(413, type === "image/gif" ? "GIF avatars can be at most 2 MB" : "Avatars can be at most 1 MB");
  if (!type) throw new HttpError(400, "Upload a PNG, JPEG, GIF or WebP image");
  mkdirSync(avatarDir(), { recursive: true });
  writeFileSync(join(avatarDir(), userId), bytes);
  const version = Date.now();
  upsertProfile(userId, { avatarVersion: version, avatarType: type });
  return { avatarVersion: version };
}

export { upsertProfile };

// Emails from the user's pushes; for history pushed before Ether recorded pushes, fall back
// to the author emails in repositories they own. Addresses other people own are left out.
async function emailSuggestions(userId: string) {
  const fromPushes = pushSuggestions(userId);
  if (fromPushes.length) return fromPushes;
  const counts = new Map<string, number>();
  for (const r of readableRepos(userId).filter((x) => x.relation === "owner")) {
    const head = await git.resolveCommit(r.path, await git.headBranch(r.path));
    if (!head) continue;
    // Recent history is enough to find someone's address.
    for (const c of await git.authorTimes(r.path, head, new Date(0), 2000)) counts.set(c.email, (counts.get(c.email) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const owners = new Map(db.select().from(commitEmail).where(inArray(commitEmail.email, [...counts.keys()])).all().map((c) => [c.email, c.userId]));
  return [...counts]
    .filter(([email]) => !owners.has(email) || owners.get(email) === userId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([email, commits]) => ({ email, commits, yours: owners.get(email) === userId }));
}

export const profileRoutes = new Elysia()
  .get("/users/:name/profile", async ({ request, params }) => {
    const viewer = await readerOrVisitor(request);
    const target = requireTarget(params.name);
    const readable = readableRepos(viewer.id);
    const row = profileRow(target.id);
    const followers = db.select({ id: follow.followerId }).from(follow).where(eq(follow.followeeId, target.id)).all();
    const following = db.select({ id: follow.followeeId }).from(follow).where(eq(follow.followerId, target.id)).all();
    const pins = db.select().from(pin).where(eq(pin.userId, target.id)).orderBy(pin.position).all();
    const readableById = new Map(readable.map((r) => [r.id, r]));
    const own = readable.filter((r) => r.ownerId === target.id);
    const [readme, contrib] = await Promise.all([profileReadme(target, readable), contributions(target.id, readable)]);
    const org = db.select().from(organization).where(eq(organization.userId, target.id)).get();
    const orgMembers = org
      ? people(db.select({ id: orgMember.userId }).from(orgMember).where(eq(orgMember.orgId, target.id)).all().map((m) => m.id))
      : [];
    const myOrgRole = org ? (db.select({ role: orgMember.role }).from(orgMember).where(and(eq(orgMember.orgId, target.id), eq(orgMember.userId, viewer.id))).get()?.role ?? null) : null;
    const starredRepos = db
      .select({ repoId: star.repoId })
      .from(star)
      .where(eq(star.userId, target.id))
      .orderBy(desc(star.createdAt))
      .all()
      .flatMap((s) => readableById.get(s.repoId) ?? []);
    const pinnedRepos = pins.flatMap((p) => readableById.get(p.repoId) ?? []);
    const cards = await repoCards([...new Set([...own, ...pinnedRepos, ...starredRepos])], new Set([...own, ...pinnedRepos].map((r) => r.id)));
    const card = (r: ReadableRepo) => cards.get(r.id)!;
    const ownCards = own.map(card).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    // With nothing pinned (that this viewer can see), show their most starred, most active work.
    const popular = pinnedRepos.length ? [] : [...ownCards].sort((a, b) => b.stars - a.stars).slice(0, 6);
    // People: what they did. Organizations: what happened in their repositories.
    const activity = org
      ? listEvents(viewer.id, readable, { repoIds: own.map((r) => r.id), limit: 20 }).events
      : listEvents(viewer.id, readable, { actorId: target.id, limit: 20 }).events;
    const teams = org && myOrgRole ? db.select({ id: team.id }).from(team).where(eq(team.orgId, target.id)).all().length : null;
    // Organizations a person belongs to, shown on their profile like GitHub does.
    const orgsOf = org
      ? []
      : db
          .select({ username: user.username, avatarVersion: profile.avatarVersion })
          .from(orgMember)
          .innerJoin(user, eq(user.id, orgMember.orgId))
          .leftJoin(profile, eq(profile.userId, orgMember.orgId))
          .where(eq(orgMember.userId, target.id))
          .orderBy(user.username)
          .all()
          .map((o) => ({ name: o.username!, avatarVersion: o.avatarVersion ?? null }));
    return {
      username: target.username,
      isOrg: !!org,
      members: orgMembers,
      viewerOrgRole: myOrgRole,
      organizations: orgsOf,
      isSelf: viewer.id === target.id,
      // Lets the owner see why commits aren't counted yet.
      hasCommitEmails: !!db.select().from(commitEmail).where(eq(commitEmail.userId, target.id)).get(),
      profile: {
        displayName: row?.displayName ?? "",
        bio: row?.bio ?? "",
        pronouns: row?.pronouns ?? "",
        company: row?.company ?? "",
        location: row?.location ?? "",
        website: row?.website ?? "",
        socials: JSON.parse(row?.socials ?? "[]") as string[],
        status: row?.status ?? "",
        avatarVersion: row?.avatarVersion ?? null,
      },
      followers: followers.length,
      following: following.length,
      isFollowing: followers.some((f) => f.id === viewer.id),
      // Only stars on repositories the viewer can read.
      stars: starredRepos.map(card),
      pinned: pinnedRepos.map(card),
      popular,
      repos: ownCards,
      // Teams are only counted for the organization's own members.
      teams,
      readme,
      contributions: contrib,
      activity,
    };
  })
  .get("/users/:name/followers", async ({ request, params }) => {
    await readerOrVisitor(request);
    const target = requireTarget(params.name);
    return { users: people(db.select({ id: follow.followerId }).from(follow).where(eq(follow.followeeId, target.id)).all().map((f) => f.id)) };
  })
  .get("/users/:name/following", async ({ request, params }) => {
    await readerOrVisitor(request);
    const target = requireTarget(params.name);
    return { users: people(db.select({ id: follow.followeeId }).from(follow).where(eq(follow.followerId, target.id)).all().map((f) => f.id)) };
  })
  .put("/users/:name/follow", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const target = requireTarget(params.name);
    if (target.id === viewer.id) throw new HttpError(400, "You can't follow yourself");
    db.insert(follow).values({ followerId: viewer.id, followeeId: target.id }).onConflictDoNothing().run();
    return { ok: true };
  })
  .delete("/users/:name/follow", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const target = requireTarget(params.name);
    db.delete(follow).where(and(eq(follow.followerId, viewer.id), eq(follow.followeeId, target.id))).run();
    return { ok: true };
  })
  .get("/users/:name/avatar", async ({ request, params }) => {
    await readerOrVisitor(request);
    const target = requireTarget(params.name);
    const row = profileRow(target.id);
    const file = join(avatarDir(), target.id);
    if (!row?.avatarVersion || !row.avatarType || !existsSync(file)) throw new HttpError(404, "No avatar");
    return new Response(readFileSync(file), {
      headers: {
        "Content-Type": row.avatarType,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        // URLs carry ?v=<version>, so a new upload is a new URL.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  })
  // ---------- your own profile ----------
  .get("/me/profile", async ({ request }) => {
    const viewer = await requireUser(request);
    const row = profileRow(viewer.id);
    return {
      profile: {
        displayName: row?.displayName ?? "",
        bio: row?.bio ?? "",
        pronouns: row?.pronouns ?? "",
        company: row?.company ?? "",
        location: row?.location ?? "",
        website: row?.website ?? "",
        socials: JSON.parse(row?.socials ?? "[]") as string[],
        status: row?.status ?? "",
        avatarVersion: row?.avatarVersion ?? null,
      },
      emails: db.select({ email: commitEmail.email }).from(commitEmail).where(eq(commitEmail.userId, viewer.id)).all().map((e) => e.email),
      pushEmails: await emailSuggestions(viewer.id),
      pins: db
        .select({ repoId: pin.repoId })
        .from(pin)
        .where(eq(pin.userId, viewer.id))
        .orderBy(pin.position)
        .all()
        .flatMap((p) => {
          const r = readableRepos(viewer.id).find((x) => x.id === p.repoId);
          return r ? [`${r.owner}/${r.name}`] : [];
        }),
    };
  })
  .patch("/me/profile", async ({ request, body }) => {
    const viewer = await requireUser(request);
    applyProfilePatch(viewer.id, body);
    return { ok: true };
  })
  .put("/me/avatar", { parse: "none" }, async ({ request }) => {
    const viewer = await requireUser(request);
    return saveAvatar(viewer.id, request);
  })
  .delete("/me/avatar", async ({ request }) => {
    const viewer = await requireUser(request);
    rmSync(join(avatarDir(), viewer.id), { force: true });
    upsertProfile(viewer.id, { avatarVersion: null, avatarType: null });
    return { ok: true };
  })
  .put("/me/emails", async ({ request, body }) => {
    const viewer = await requireUser(request);
    const list = (body as { emails?: unknown } | null)?.emails;
    if (!Array.isArray(list) || list.length > 10 || list.some((e) => typeof e !== "string" || !EMAIL_RE.test(e.trim())))
      throw new HttpError(400, "Provide up to ten email addresses");
    const emails = [...new Set((list as string[]).map((e) => e.trim().toLowerCase()))];
    if (emails.length) {
      const taken = db
        .select({ email: commitEmail.email, userId: commitEmail.userId })
        .from(commitEmail)
        .where(inArray(commitEmail.email, emails))
        .all()
        .find((e) => e.userId !== viewer.id);
      if (taken) throw new HttpError(409, `${taken.email} belongs to another account`);
    }
    db.transaction((tx) => {
      tx.delete(commitEmail).where(eq(commitEmail.userId, viewer.id)).run();
      if (emails.length) tx.insert(commitEmail).values(emails.map((email) => ({ email, userId: viewer.id }))).run();
    });
    return { emails };
  })
  .put("/me/pins", async ({ request, body }) => {
    const viewer = await requireUser(request);
    const list = (body as { repos?: unknown } | null)?.repos;
    if (!Array.isArray(list) || list.length > 6 || list.some((r) => typeof r !== "string")) throw new HttpError(400, "Pin up to six repositories");
    const readable = readableRepos(viewer.id);
    const ids = (list as string[]).map((full) => {
      const r = readable.find((x) => `${x.owner}/${x.name}` === full.toLowerCase());
      if (!r) throw new HttpError(400, `Unknown repository ${full}`);
      return r.id;
    });
    db.transaction((tx) => {
      tx.delete(pin).where(eq(pin.userId, viewer.id)).run();
      const unique = [...new Set(ids)];
      if (unique.length) tx.insert(pin).values(unique.map((repoId, position) => ({ userId: viewer.id, repoId, position }))).run();
    });
    return { ok: true };
  });
