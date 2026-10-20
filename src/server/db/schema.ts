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
    // Branch protection for pull requests: merging needs an approving review.
    requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(false),
    // CI runs .ether/ci.yml on push when the instance also allows it.
    ciEnabled: integer("ci_enabled", { mode: "boolean" }).notNull().default(false),
    // Branch protection: the head commit's CI run must have passed to merge.
    requireChecks: integer("require_checks", { mode: "boolean" }).notNull().default(false),
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

// Teams group organization members and grant them a role on chosen org repositories,
// on top of the organization's base permission.
export const team = sqliteTable(
  "team",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: text("org_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("team_org_name_idx").on(t.orgId, t.name)],
);

export const teamMember = sqliteTable(
  "team_member",
  {
    teamId: integer("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index("team_member_user_idx").on(t.userId)],
);

export const teamRepo = sqliteTable(
  "team_repo",
  {
    teamId: integer("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["read", "write"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.repoId] })],
);

// Instance-wide settings an admin changes at runtime, as key/value JSON.
export const instanceSetting = sqliteTable("instance_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const label = sqliteTable(
  "label",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // #rrggbb
    color: text("color").notNull(),
    description: text("description").notNull().default(""),
  },
  (t) => [uniqueIndex("label_repo_name_idx").on(t.repoId, t.name)],
);

export const issueLabel = sqliteTable(
  "issue_label",
  {
    issueId: integer("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => label.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] }), index("issue_label_label_idx").on(t.labelId)],
);

export const issueAssignee = sqliteTable(
  "issue_assignee",
  {
    issueId: integer("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] }), index("issue_assignee_user_idx").on(t.userId)],
);

export const release = sqliteTable(
  "release",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    prerelease: integer("prerelease", { mode: "boolean" }).notNull().default(false),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("release_repo_tag_idx").on(t.repoId, t.tag)],
);

// Files attached to a release; bytes live under data/releases/<release id>/<asset id>.
export const releaseAsset = sqliteTable(
  "release_asset",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    releaseId: integer("release_id")
      .notNull()
      .references(() => release.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("release_asset_name_idx").on(t.releaseId, t.name)],
);

export const review = sqliteTable(
  "review",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    state: text("state", { enum: ["approved", "changes_requested", "commented"] }).notNull(),
    body: text("body").notNull().default(""),
    // The head commit the review looked at.
    commitSha: text("commit_sha").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("review_issue_idx").on(t.issueId)],
);

// A comment on one line of the new side of the diff.
export const reviewComment = sqliteTable("review_comment", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: integer("review_id")
    .notNull()
    .references(() => review.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  line: integer("line").notNull(),
  body: text("body").notNull(),
});

export const reviewRequest = sqliteTable(
  "review_request",
  {
    issueId: integer("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] }), index("review_request_user_idx").on(t.userId)],
);

// Public keys for git over SSH. `blob` is the base64 key data; one key belongs to one account.
export const sshKey = sqliteTable(
  "ssh_key",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    keyType: text("key_type").notNull(),
    blob: text("blob").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("ssh_key_user_idx").on(t.userId)],
);

export const ciRun = sqliteTable(
  "ci_run",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    ref: text("ref").notNull(),
    status: text("status", { enum: ["queued", "running", "success", "failure", "cancelled", "error"] }).notNull(),
    // Whose push or re-run started it; failures are reported to them.
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    // Why a run errored before any job ran, e.g. an invalid workflow file.
    message: text("message").notNull().default(""),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("ci_run_repo_sha_idx").on(t.repoId, t.sha)],
);

export const ciJob = sqliteTable("ci_job", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id")
    .notNull()
    .references(() => ciRun.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // JSON: [{ name, run, shell, timeoutMinutes }]
  steps: text("steps").notNull(),
  status: text("status", { enum: ["queued", "running", "success", "failure", "cancelled", "error"] }).notNull(),
  log: text("log").notNull().default(""),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

// What happened in a repository, for activity feeds. Payloads describe the event in the repository
// itself (numbers, titles, branches) and never name another repository; who may see an event is
// decided when it is read, from the reader's current access to repoId.
export const event = sqliteTable(
  "event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // JSON, shaped by kind; see events.ts.
    payload: text("payload").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [index("event_repo_idx").on(t.repoId, t.createdAt), index("event_actor_idx").on(t.actorId, t.createdAt)],
);
