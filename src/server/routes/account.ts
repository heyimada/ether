import { Mutex } from "async-mutex";
import { and, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import {
  HttpError,
  createAccessToken,
  createInvite,
  findUser,
  inviteIsUsable,
  markInviteUsed,
  anonymousRead,
  readerOrVisitor,
  requireAdmin,
  requireUser,
} from "../access";
import { auth, placeholderEmail } from "../auth";
import { USERNAME_RE } from "../auth-plugins";
import { config } from "../config";
import { db } from "../db/client";
import { accessToken, instanceSetting, invite, profile, user, userPref } from "../db/schema";

const MIN_PASSWORD = 10;
// The accent ends up inside a stylesheet, so nothing but a plain hex colour is stored.
const HEX_RE = /^#[0-9a-f]{6}$/i;
// First path segments the web app uses for its own pages; a user with one of these names
// would have unreachable repository URLs.
export const RESERVED = new Set(["api", "assets", "login", "register", "new", "settings", "site-admin", "organizations", "_shell"]);
const registration = new Mutex();

type RegisterBody = { code?: unknown; username?: unknown; password?: unknown };

export const accountRoutes = new Elysia()
  .post("/register", async ({ body }) => {
    const { code, username, password } = (body ?? {}) as RegisterBody;
    if (typeof code !== "string" || !code) throw new HttpError(400, "An invite code is required");
    if (typeof username !== "string" || !USERNAME_RE.test(username)) throw new HttpError(400, "Usernames are 1-39 letters, digits or dashes");
    if (RESERVED.has(username.toLowerCase())) throw new HttpError(400, "That username is reserved");
    if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters`);

    // One invite yields one account even when two people race to redeem it.
    return registration.runExclusive(async () => {
      if (!inviteIsUsable(code)) throw new HttpError(400, "This invite is invalid, expired or already used");
      if (findUser(username)) throw new HttpError(409, "That username is taken");
      const { user: created } = await auth.api.signUpEmail({
        body: { email: placeholderEmail(username), name: username, username, password },
      });
      markInviteUsed(code, created.id);
      return { user: { username: created.username } };
    });
  })
  // Public: tells the web app whether signed-out visitors may browse public repositories.
  .get("/instance", () => ({ anonymousRead: anonymousRead() }))
  .put("/admin/settings", async ({ request, body }) => {
    await requireAdmin(request);
    const { anonymousRead: allow } = (body ?? {}) as { anonymousRead?: unknown };
    if (typeof allow !== "boolean") throw new HttpError(400, "anonymousRead must be true or false");
    db.insert(instanceSetting)
      .values({ key: "anonymousRead", value: String(allow) })
      .onConflictDoUpdate({ target: instanceSetting.key, set: { value: String(allow) } })
      .run();
    return { anonymousRead: allow };
  })
  .get("/me", async ({ request }) => {
    const viewer = await requireUser(request);
    const pref = db.select().from(userPref).where(eq(userPref.userId, viewer.id)).get();
    return { user: { username: viewer.username, isAdmin: viewer.isAdmin, accent: pref?.accent ?? null, theme: pref?.theme ?? null } };
  })
  // Partial update: only the fields present in the body change.
  .put("/me/appearance", async ({ request, body }) => {
    const viewer = await requireUser(request);
    const b = (body ?? {}) as { accent?: unknown; theme?: unknown };
    const set: { accent?: string | null; theme?: "light" | "dark" | null } = {};
    if ("accent" in b) {
      if (b.accent !== null && (typeof b.accent !== "string" || !HEX_RE.test(b.accent))) throw new HttpError(400, "Accent must be a colour like #0b7285");
      set.accent = b.accent === null ? null : b.accent.toLowerCase();
    }
    if ("theme" in b) {
      if (b.theme !== null && b.theme !== "light" && b.theme !== "dark") throw new HttpError(400, "Theme must be light, dark or null");
      set.theme = b.theme;
    }
    if (Object.keys(set).length === 0) throw new HttpError(400, "Nothing to change");
    db.insert(userPref).values({ userId: viewer.id, ...set }).onConflictDoUpdate({ target: userPref.userId, set }).run();
    const pref = db.select().from(userPref).where(eq(userPref.userId, viewer.id)).get();
    return { accent: pref?.accent ?? null, theme: pref?.theme ?? null };
  })
  .get("/users", async ({ request }) => {
    await readerOrVisitor(request);
    const users = db
      .select({ username: user.username, role: user.role, displayName: profile.displayName, avatarVersion: profile.avatarVersion })
      .from(user)
      .leftJoin(profile, eq(profile.userId, user.id))
      .orderBy(user.username)
      .all();
    return {
      users: users.map((u) => ({ username: u.username, isAdmin: u.role === "admin", isOrg: u.role === "org", displayName: u.displayName ?? "", avatarVersion: u.avatarVersion ?? null })),
    };
  })
  .get("/invites", async ({ request }) => {
    await requireAdmin(request);
    const rows = db
      .select({ createdAt: invite.createdAt, expiresAt: invite.expiresAt, usedBy: user.username })
      .from(invite)
      .leftJoin(user, eq(invite.usedBy, user.id))
      .orderBy(desc(invite.createdAt))
      .all();
    return { invites: rows };
  })
  .post("/invites", async ({ request }) => {
    const viewer = await requireAdmin(request);
    const { code, expiresAt } = createInvite(viewer.id);
    return { code, expiresAt, url: `${config.publicUrl}/register?code=${encodeURIComponent(code)}` };
  })
  .get("/tokens", async ({ request }) => {
    const viewer = await requireUser(request);
    const tokens = db
      .select({ id: accessToken.id, name: accessToken.name, createdAt: accessToken.createdAt, lastUsedAt: accessToken.lastUsedAt })
      .from(accessToken)
      .where(eq(accessToken.userId, viewer.id))
      .orderBy(desc(accessToken.createdAt))
      .all();
    return { tokens };
  })
  .post("/tokens", async ({ request, body }) => {
    const viewer = await requireUser(request);
    const name = String((body as { name?: unknown } | undefined)?.name ?? "").trim();
    if (!name || name.length > 100) throw new HttpError(400, "Give the token a name");
    return createAccessToken(viewer.id, name);
  })
  .delete("/tokens/:id", async ({ request, params }) => {
    const viewer = await requireUser(request);
    db.delete(accessToken)
      .where(and(eq(accessToken.id, Number(params.id)), eq(accessToken.userId, viewer.id)))
      .run();
    return { ok: true };
  });
