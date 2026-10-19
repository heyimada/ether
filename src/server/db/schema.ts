import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export * from "./auth-schema";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull();

// Personal access tokens for git over HTTPS; only the SHA-256 is stored.
export const accessToken = sqliteTable(
  "access_token",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("access_token_user_idx").on(t.userId)],
);

export const invite = sqliteTable("invite", {
  codeHash: text("code_hash").primaryKey(),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const repo = sqliteTable(
  "repo",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Stored lowercase; names are case-insensitive like on disk.
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // Issues and pull requests share one number sequence per repository.
    nextNumber: integer("next_number").notNull().default(1),
    // Public means readable by every account on this server; writes still need a role.
    visibility: text("visibility", { enum: ["private", "public"] }).notNull().default("private"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("repo_owner_name_idx").on(t.ownerId, t.name)],
);

export const collaborator = sqliteTable(
  "collaborator",
  {
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["read", "write"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.userId] })],
);

export const issue = sqliteTable(
  "issue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull().default("open"),
    isPull: integer("is_pull", { mode: "boolean" }).notNull().default(false),
    baseRef: text("base_ref"),
    headRef: text("head_ref"),
    mergeCommit: text("merge_commit"),
    mergedBy: text("merged_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex("issue_repo_number_idx").on(t.repoId, t.number)],
);

export const comment = sqliteTable(
  "comment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("comment_issue_idx").on(t.issueId)],
);

// Per-user interface preferences. accent is a lowercase #rrggbb and theme is "light" or
// "dark"; null means the default accent and following the OS.
export const userPref = sqliteTable("user_pref", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  accent: text("accent"),
  theme: text("theme", { enum: ["light", "dark"] }),
});

// Public profile fields, shown to every signed-in user. Links are validated http(s) URLs.
export const profile = sqliteTable("profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull().default(""),
  bio: text("bio").notNull().default(""),
  pronouns: text("pronouns").notNull().default(""),
  company: text("company").notNull().default(""),
  location: text("location").notNull().default(""),
  website: text("website").notNull().default(""),
  // JSON array of up to four http(s) URLs.
  socials: text("socials").notNull().default("[]"),
  status: text("status").notNull().default(""),
  // Bumped on every upload so avatar URLs can be cached forever; null means initials.
  avatarVersion: integer("avatar_version"),
  avatarType: text("avatar_type"),
});

// Addresses whose commits count as this user's contributions. Each address belongs to one user.
export const commitEmail = sqliteTable(
  "commit_email",
  {
    email: text("email").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("commit_email_user_idx").on(t.userId)],
);

export const follow = sqliteTable(
  "follow",
  {
    followerId: text("follower_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    followeeId: text("followee_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followeeId] }), index("follow_followee_idx").on(t.followeeId)],
);

export const pin = sqliteTable(
  "pin",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repoId] })],
);

// An organization is a `user` row that can own repositories but has no credentials, so it can
// never sign in. Members get basePermission on every org repository; owners get full control.
export const organization = sqliteTable("organization", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  basePermission: text("base_permission", { enum: ["read", "write"] }).notNull().default("read"),
  createdAt: createdAt(),
});

export const orgMember = sqliteTable(
  "org_member",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("org_member_user_idx").on(t.userId)],
);

// Author emails found in commits a user pushed, offered as commit-email suggestions.
export const pushEmail = sqliteTable(
  "push_email",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    commits: integer("commits").notNull().default(0),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.email] })],
);

export const star = sqliteTable(
  "star",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repoId] }), index("star_repo_idx").on(t.repoId)],
);
