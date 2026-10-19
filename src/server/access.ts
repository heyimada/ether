import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { auth } from "./auth";
import { db } from "./db/client";
import { accessToken, collaborator, instanceSetting, invite, orgMember, organization, repo, teamMember, teamRepo, user } from "./db/schema";
import { repoPath } from "./git";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Viewer = { id: string; username: string; isAdmin: boolean };
export type Role = "owner" | "write" | "read";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (prefix: string) => prefix + randomBytes(24).toString("base64url");

export async function currentUser(req: Request): Promise<Viewer | null> {
  // API clients such as the ether CLI send a personal access token instead of a session cookie.
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer) return tokenOwner(bearer);
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user.username) return null;
  return { id: session.user.id, username: session.user.username, isAdmin: (session.user as { role?: string | null }).role === "admin" };
}

export async function requireUser(req: Request): Promise<Viewer> {
  const viewer = await currentUser(req);
  if (!viewer) throw new HttpError(401, "Sign in required");
  return viewer;
}

// Signed-out visitors, when an admin allows them, get this identity: it owns nothing and is in
// no org, team or collaborator list, so the resolver can only grant it read on public repos.
export const VISITOR: Viewer = { id: "", username: "", isAdmin: false };

export function anonymousRead(): boolean {
  return db.select().from(instanceSetting).where(eq(instanceSetting.key, "anonymousRead")).get()?.value === "true";
}

// For read-only endpoints: the signed-in user, or the visitor identity when allowed.
export async function readerOrVisitor(req: Request): Promise<Viewer> {
  const viewer = await currentUser(req);
  if (viewer) return viewer;
  if (anonymousRead()) return VISITOR;
  throw new HttpError(401, "Sign in required");
}

export async function requireAdmin(req: Request): Promise<Viewer> {
  const viewer = await requireUser(req);
  if (!viewer.isAdmin) throw new HttpError(403, "Admins only");
  return viewer;
}

export const findUser = (username: string) =>
  db.select({ id: user.id, username: user.username }).from(user).where(eq(user.username, username.toLowerCase())).get();

export const isOrg = (userId: string) => !!db.select({ id: organization.userId }).from(organization).where(eq(organization.userId, userId)).get();

// ---------- repositories ----------

export type RepoAccess = {
  repo: typeof repo.$inferSelect;
  owner: string;
  role: Role;
  path: string;
};

// How the viewer is connected to a repository, for grouping lists. Independent of role rank.
export type Relation = "owner" | "org" | "collaborator" | "public";

const rank: Record<Role, number> = { read: 1, write: 2, owner: 3 };
const higher = (a: Role | null, b: Role | null): Role | null => (!a ? b : !b ? a : rank[a] >= rank[b] ? a : b);

type Memberships = { orgs: Map<string, Role>; collabs: Map<number, Role>; teams: Map<number, Role> };

// The viewer's org memberships (already mapped to the role they grant) and collaborator roles.
function memberships(viewerId: string): Memberships {
  const orgs = new Map<string, Role>(
    db
      .select({ orgId: orgMember.orgId, role: orgMember.role, base: organization.basePermission })
      .from(orgMember)
      .innerJoin(organization, eq(organization.userId, orgMember.orgId))
      .where(eq(orgMember.userId, viewerId))
      .all()
      .map((m) => [m.orgId, m.role === "owner" ? "owner" : m.base]),
  );
  const collabs = new Map<number, Role>(
    db
      .select({ repoId: collaborator.repoId, role: collaborator.role })
      .from(collaborator)
      .where(eq(collaborator.userId, viewerId))
      .all()
      .map((c) => [c.repoId, c.role]),
  );
  // Team grants, highest per repository when someone is in several teams.
  const teams = new Map<number, Role>();
  for (const t of db
    .select({ repoId: teamRepo.repoId, role: teamRepo.role })
    .from(teamMember)
    .innerJoin(teamRepo, eq(teamRepo.teamId, teamMember.teamId))
    .where(eq(teamMember.userId, viewerId))
    .all())
    teams.set(t.repoId, higher(teams.get(t.repoId) ?? null, t.role)!);
  return { orgs, collabs, teams };
}

// The single place that decides access: the highest role from ownership, org membership,
// collaboration and public visibility.
function resolve(r: typeof repo.$inferSelect, viewerId: string, m: Memberships): { role: Role; relation: Relation } | null {
  const own: Role | null = r.ownerId === viewerId ? "owner" : null;
  const org = m.orgs.get(r.ownerId) ?? null;
  const collab = m.collabs.get(r.id) ?? null;
  const viaTeam = m.teams.get(r.id) ?? null;
  const pub: Role | null = r.visibility === "public" ? "read" : null;
  const role = higher(higher(own, org), higher(higher(collab, viaTeam), pub));
  if (!role) return null;
  const relation: Relation = own ? "owner" : org || viaTeam ? "org" : collab ? "collaborator" : "public";
  return { role, relation };
}

export function repoAccess(viewer: Pick<Viewer, "id">, ownerName: string, repoName: string): RepoAccess | null {
  const row = db
    .select({ repo, owner: user.username })
    .from(repo)
    .innerJoin(user, eq(repo.ownerId, user.id))
    .where(and(eq(user.username, ownerName.toLowerCase()), eq(repo.name, repoName.toLowerCase())))
    .get();
  if (!row) return null;
  const access = resolve(row.repo, viewer.id, memberships(viewer.id));
  if (!access) return null;
  return { repo: row.repo, owner: row.owner!, role: access.role, path: repoPath(row.owner!, row.repo.name) };
}

export const allows = (role: Role, need: Role) => rank[role] >= rank[need];

export type ReadableRepo = {
  id: number;
  ownerId: string;
  owner: string;
  ownerIsOrg: boolean;
  name: string;
  description: string;
  visibility: "private" | "public";
  createdAt: Date;
  path: string;
  role: Role;
  relation: Relation;
};

// Every repository the viewer can read. Anything shown about other people (profiles,
// activity, contributions, search) must be filtered through this.
export function readableRepos(viewerId: string): ReadableRepo[] {
  const m = memberships(viewerId);
  return db
    .select({ repo, owner: user.username, orgId: organization.userId })
    .from(repo)
    .innerJoin(user, eq(repo.ownerId, user.id))
    .leftJoin(organization, eq(organization.userId, repo.ownerId))
    .orderBy(user.username, repo.name)
    .all()
    .flatMap((r) => {
      const access = resolve(r.repo, viewerId, m);
      if (!access) return [];
      return [
        {
          id: r.repo.id,
          ownerId: r.repo.ownerId,
          owner: r.owner!,
          ownerIsOrg: !!r.orgId,
          name: r.repo.name,
          description: r.repo.description,
          visibility: r.repo.visibility,
          createdAt: r.repo.createdAt,
          path: repoPath(r.owner!, r.repo.name),
          ...access,
        },
      ];
    });
}

// Repositories the viewer cannot read are reported as missing, not forbidden.
export function requireRepo(viewer: Viewer, ownerName: string, repoName: string, need: Role): RepoAccess {
  const access = repoAccess(viewer, ownerName, repoName);
  // A visitor might be able to see it after signing in, so ask them to.
  if (!access) throw viewer.id === "" ? new HttpError(401, "Sign in required") : new HttpError(404, "Repository not found");
  if (!allows(access.role, need)) throw new HttpError(403, `Requires ${need} access`);
  return access;
}

// ---------- personal access tokens ----------

export function createAccessToken(userId: string, name: string) {
  const token = secret("eth_");
  const row = db.insert(accessToken).values({ userId, name, tokenHash: sha256(token) }).returning({ id: accessToken.id }).get();
  return { id: row.id, token };
}

// The account a personal access token belongs to, from the token alone (tokens are unique).
export function tokenOwner(token: string): Viewer | null {
  const row = db
    .select({ id: user.id, username: user.username, role: user.role, tokenId: accessToken.id })
    .from(accessToken)
    .innerJoin(user, eq(accessToken.userId, user.id))
    .where(eq(accessToken.tokenHash, sha256(token)))
    .get();
  if (!row?.username) return null;
  db.update(accessToken).set({ lastUsedAt: new Date() }).where(eq(accessToken.id, row.tokenId)).run();
  return { id: row.id, username: row.username, isAdmin: row.role === "admin" };
}

export function tokenUser(username: string, token: string): Viewer | null {
  const row = db
    .select({ id: user.id, username: user.username, role: user.role, tokenId: accessToken.id })
    .from(accessToken)
    .innerJoin(user, eq(accessToken.userId, user.id))
    .where(and(eq(accessToken.tokenHash, sha256(token)), eq(user.username, username.toLowerCase())))
    .get();
  if (!row?.username) return null;
  db.update(accessToken).set({ lastUsedAt: new Date() }).where(eq(accessToken.id, row.tokenId)).run();
  return { id: row.id, username: row.username, isAdmin: row.role === "admin" };
}

// ---------- invites ----------

const INVITE_TTL = 7 * 24 * 3600 * 1000;

export function createInvite(createdBy: string) {
  const code = secret("inv_");
  const expiresAt = new Date(Date.now() + INVITE_TTL);
  db.insert(invite).values({ codeHash: sha256(code), createdBy, expiresAt }).run();
  return { code, expiresAt };
}

export function inviteIsUsable(code: string): boolean {
  const row = db.select().from(invite).where(eq(invite.codeHash, sha256(code))).get();
  return !!row && !row.usedBy && row.expiresAt.getTime() > Date.now();
}

export const markInviteUsed = (code: string, userId: string) =>
  db.update(invite).set({ usedBy: userId }).where(eq(invite.codeHash, sha256(code))).run();
