import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";
import { HttpError, findUser, isOrg, requireUser, type Viewer } from "../access";
import { USERNAME_RE } from "../auth-plugins";
import { db } from "../db/client";
import { orgMember, organization, profile, repo, team, teamMember, teamRepo, user } from "../db/schema";
import { RESERVED } from "./account";
import { applyProfilePatch, saveAvatar, upsertProfile } from "./profiles";

function requireOrg(name: string) {
  const row = findUser(name);
  if (!row || !isOrg(row.id)) throw new HttpError(404, "No such organization");
  return { id: row.id, name: row.username! };
}

const roleIn = (orgId: string, userId: string) =>
  db.select({ role: orgMember.role }).from(orgMember).where(and(eq(orgMember.orgId, orgId), eq(orgMember.userId, userId))).get()?.role ?? null;

function requireOrgOwner(viewer: Viewer, name: string) {
  const org = requireOrg(name);
  if (roleIn(org.id, viewer.id) !== "owner") throw new HttpError(403, "Only organization owners can do that");
  return org;
}

const TEAM_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function requireTeam(orgId: string, name: string) {
  const t = db.select().from(team).where(and(eq(team.orgId, orgId), eq(team.name, name.toLowerCase()))).get();
  if (!t) throw new HttpError(404, "No such team");
  return t;
}

const ownerCount = (orgId: string) => db.select().from(orgMember).where(and(eq(orgMember.orgId, orgId), eq(orgMember.role, "owner"))).all().length;

function members(orgId: string) {
  return db
    .select({ username: user.username, role: orgMember.role, displayName: profile.displayName, avatarVersion: profile.avatarVersion })
    .from(orgMember)
    .innerJoin(user, eq(user.id, orgMember.userId))
    .leftJoin(profile, eq(profile.userId, user.id))
    .where(eq(orgMember.orgId, orgId))
    .orderBy(user.username)
    .all()
    .map((m) => ({ username: m.username!, role: m.role, displayName: m.displayName ?? "", avatarVersion: m.avatarVersion ?? null }));
}

export const orgRoutes = new Elysia()
  .post("/orgs", async ({ request, body }) => {
    const viewer = await requireUser(request);
    const { name, displayName } = (body ?? {}) as { name?: unknown; displayName?: unknown };
    if (typeof name !== "string" || !USERNAME_RE.test(name)) throw new HttpError(400, "Organization names are 1-39 letters, digits or dashes");
    const lower = name.toLowerCase();
    if (RESERVED.has(lower)) throw new HttpError(400, "That name is reserved");
    if (findUser(lower)) throw new HttpError(409, "That name is already taken by a person or organization");
    const id = randomUUID();
    const now = new Date();
    db.transaction((tx) => {
      // No credential account is ever created for this row, and sign-in refuses it.
      tx.insert(user)
        .values({ id, name: lower, email: `${lower}@orgs.ether.invalid`, emailVerified: false, username: lower, displayUsername: name, role: "org", createdAt: now, updatedAt: now })
        .run();
      tx.insert(organization).values({ userId: id }).run();
      tx.insert(orgMember).values({ orgId: id, userId: viewer.id, role: "owner" }).run();
    });
    if (typeof displayName === "string" && displayName.trim()) upsertProfile(id, { displayName: displayName.trim().slice(0, 64) });
    return { org: { name: lower } };
  })
  .get("/orgs/:org", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrg(params.org);
    const base = db.select({ base: organization.basePermission }).from(organization).where(eq(organization.userId, org.id)).get()!.base;
    return { name: org.name, basePermission: base, viewerRole: roleIn(org.id, viewer.id), members: members(org.id) };
  })
  .patch("/orgs/:org", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    const { basePermission } = (body ?? {}) as { basePermission?: unknown };
    if (basePermission !== "read" && basePermission !== "write") throw new HttpError(400, "Base permission must be read or write");
    db.update(organization).set({ basePermission }).where(eq(organization.userId, org.id)).run();
    return { ok: true };
  })
  .put("/orgs/:org/members/:username", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    const role = (body as { role?: unknown } | null)?.role ?? "member";
    if (role !== "owner" && role !== "member") throw new HttpError(400, "Role must be owner or member");
    const target = findUser(params.username);
    if (!target) throw new HttpError(404, "No such user");
    if (isOrg(target.id)) throw new HttpError(400, "Organizations can't be members of organizations");
    if (role === "member" && roleIn(org.id, target.id) === "owner" && ownerCount(org.id) === 1)
      throw new HttpError(400, "An organization needs at least one owner");
    db.insert(orgMember).values({ orgId: org.id, userId: target.id, role }).onConflictDoUpdate({ target: [orgMember.orgId, orgMember.userId], set: { role } }).run();
    return { ok: true };
  })
  .delete("/orgs/:org/members/:username", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrg(params.org);
    const target = findUser(params.username);
    if (!target) throw new HttpError(404, "No such user");
    // Owners manage everyone; anyone may leave.
    if (target.id !== viewer.id && roleIn(org.id, viewer.id) !== "owner") throw new HttpError(403, "Only organization owners can do that");
    if (roleIn(org.id, target.id) === "owner" && ownerCount(org.id) === 1) throw new HttpError(400, "An organization needs at least one owner");
    db.transaction((tx) => {
      tx.delete(orgMember).where(and(eq(orgMember.orgId, org.id), eq(orgMember.userId, target.id))).run();
      // Leaving the org also leaves its teams.
      const ids = tx.select({ id: team.id }).from(team).where(eq(team.orgId, org.id)).all().map((t) => t.id);
      if (ids.length) tx.delete(teamMember).where(and(eq(teamMember.userId, target.id), inArray(teamMember.teamId, ids))).run();
    });
    return { ok: true };
  })
  // ---------- teams ----------
  .get("/orgs/:org/teams", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrg(params.org);
    if (!roleIn(org.id, viewer.id)) throw new HttpError(404, "No such organization");
    return {
      teams: db
        .select()
        .from(team)
        .where(eq(team.orgId, org.id))
        .orderBy(team.name)
        .all()
        .map((t) => ({
          name: t.name,
          description: t.description,
          members: db
            .select({ username: user.username })
            .from(teamMember)
            .innerJoin(user, eq(user.id, teamMember.userId))
            .where(eq(teamMember.teamId, t.id))
            .orderBy(user.username)
            .all()
            .map((m) => m.username!),
          repos: db
            .select({ name: repo.name, role: teamRepo.role })
            .from(teamRepo)
            .innerJoin(repo, eq(repo.id, teamRepo.repoId))
            .where(eq(teamRepo.teamId, t.id))
            .orderBy(repo.name)
            .all(),
        })),
    };
  })
  .post("/orgs/:org/teams", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    const { name, description } = (body ?? {}) as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !TEAM_RE.test(name)) throw new HttpError(400, "Team names are 1-39 letters, digits or dashes");
    const lower = name.toLowerCase();
    if (db.select().from(team).where(and(eq(team.orgId, org.id), eq(team.name, lower))).get()) throw new HttpError(409, "That team already exists");
    db.insert(team).values({ orgId: org.id, name: lower, description: typeof description === "string" ? description.slice(0, 200) : "" }).run();
    return { team: { name: lower } };
  })
  .delete("/orgs/:org/teams/:team", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    db.delete(team).where(eq(team.id, requireTeam(org.id, params.team).id)).run();
    return { ok: true };
  })
  .put("/orgs/:org/teams/:team/members/:username", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    const t = requireTeam(org.id, params.team);
    const target = findUser(params.username);
    if (!target) throw new HttpError(404, "No such user");
    if (!roleIn(org.id, target.id)) throw new HttpError(400, "Add them to the organization first");
    db.insert(teamMember).values({ teamId: t.id, userId: target.id }).onConflictDoNothing().run();
    return { ok: true };
  })
  .delete("/orgs/:org/teams/:team/members/:username", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    const t = requireTeam(org.id, params.team);
    const target = findUser(params.username);
    if (target) db.delete(teamMember).where(and(eq(teamMember.teamId, t.id), eq(teamMember.userId, target.id))).run();
    return { ok: true };
  })
  .put("/orgs/:org/teams/:team/repos/:repo", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    const t = requireTeam(org.id, params.team);
    const role = (body as { role?: unknown } | null)?.role;
    if (role !== "read" && role !== "write") throw new HttpError(400, "Role must be read or write");
    const r = db.select().from(repo).where(and(eq(repo.ownerId, org.id), eq(repo.name, params.repo.toLowerCase()))).get();
    if (!r) throw new HttpError(404, "The organization has no such repository");
    db.insert(teamRepo).values({ teamId: t.id, repoId: r.id, role }).onConflictDoUpdate({ target: [teamRepo.teamId, teamRepo.repoId], set: { role } }).run();
    return { ok: true };
  })
  .delete("/orgs/:org/teams/:team/repos/:repo", async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    const t = requireTeam(org.id, params.team);
    const r = db.select().from(repo).where(and(eq(repo.ownerId, org.id), eq(repo.name, params.repo.toLowerCase()))).get();
    if (r) db.delete(teamRepo).where(and(eq(teamRepo.teamId, t.id), eq(teamRepo.repoId, r.id))).run();
    return { ok: true };
  })
  .patch("/orgs/:org/profile", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    applyProfilePatch(org.id, body);
    return { ok: true };
  })
  .put("/orgs/:org/avatar", { parse: "none" }, async ({ request, params }) => {
    const viewer = await requireUser(request);
    const org = requireOrgOwner(viewer, params.org);
    return saveAvatar(org.id, request);
  })
  .get("/me/orgs", async ({ request }) => {
    const viewer = await requireUser(request);
    return {
      orgs: db
        .select({ name: user.username, role: orgMember.role })
        .from(orgMember)
        .innerJoin(user, eq(user.id, orgMember.orgId))
        .where(eq(orgMember.userId, viewer.id))
        .orderBy(user.username)
        .all(),
    };
  });
