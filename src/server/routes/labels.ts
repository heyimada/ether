import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, findUser, readerOrVisitor, repoAccess, requireRepo, requireUser, type RepoAccess } from "../access";
import { db } from "../db/client";
import { issue, issueAssignee, issueLabel, label, user } from "../db/schema";

const LABEL_RE = /^[^\s,][^,]{0,49}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export const DEFAULT_LABELS = [
  { name: "bug", color: "#d73a4a", description: "Something isn't working" },
  { name: "enhancement", color: "#a2eeef", description: "New feature or request" },
  { name: "documentation", color: "#0075ca", description: "Improvements or additions to documentation" },
  { name: "question", color: "#d876e3", description: "Further information is requested" },
];

export const addDefaultLabels = (repoId: number) => db.insert(label).values(DEFAULT_LABELS.map((l) => ({ ...l, repoId }))).onConflictDoNothing().run();

const labelsOf = (repoId: number) =>
  db.select({ name: label.name, color: label.color, description: label.description }).from(label).where(eq(label.repoId, repoId)).orderBy(label.name).all();

function findIssueId(a: RepoAccess, number: string) {
  const row = db.select({ id: issue.id }).from(issue).where(and(eq(issue.repoId, a.repo.id), eq(issue.number, Number(number)))).get();
  if (!row) throw new HttpError(404, "No such issue or pull request");
  return row.id;
}

function checkLabel(name: unknown, color: unknown) {
  if (typeof name !== "string" || !LABEL_RE.test(name.trim())) throw new HttpError(400, "Label names are 1-50 characters without commas");
  if (color !== undefined && (typeof color !== "string" || !COLOR_RE.test(color))) throw new HttpError(400, "Colours look like #d73a4a");
}

export const labelRoutes = new Elysia()
  .get("/repos/:owner/:repo/labels", async ({ request, params }) => {
    const a = requireRepo(await readerOrVisitor(request), params.owner, params.repo, "read");
    return { labels: labelsOf(a.repo.id) };
  })
  .post("/repos/:owner/:repo/labels", async ({ request, params, body }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const { name, color, description } = (body ?? {}) as Record<string, unknown>;
    checkLabel(name, color);
    const n = (name as string).trim().toLowerCase();
    if (db.select().from(label).where(and(eq(label.repoId, a.repo.id), eq(label.name, n))).get()) throw new HttpError(409, "That label already exists");
    db.insert(label)
      .values({ repoId: a.repo.id, name: n, color: (color as string | undefined)?.toLowerCase() ?? "#8c959f", description: typeof description === "string" ? description.slice(0, 100) : "" })
      .run();
    return { ok: true };
  })
  .patch("/repos/:owner/:repo/labels/:name", async ({ request, params, body }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const row = db.select().from(label).where(and(eq(label.repoId, a.repo.id), eq(label.name, params.name.toLowerCase()))).get();
    if (!row) throw new HttpError(404, "No such label");
    const b = (body ?? {}) as Record<string, unknown>;
    checkLabel(b.name ?? row.name, b.color);
    const set: Partial<typeof label.$inferInsert> = {};
    if (typeof b.name === "string") set.name = b.name.trim().toLowerCase();
    if (typeof b.color === "string") set.color = b.color.toLowerCase();
    if (typeof b.description === "string") set.description = b.description.slice(0, 100);
    db.update(label).set(set).where(eq(label.id, row.id)).run();
    return { ok: true };
  })
  .delete("/repos/:owner/:repo/labels/:name", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    db.delete(label).where(and(eq(label.repoId, a.repo.id), eq(label.name, params.name.toLowerCase()))).run();
    return { ok: true };
  })
  // Triage needs write access, like on GitHub.
  .put("/repos/:owner/:repo/issues/:number/labels", async ({ request, params, body }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const issueId = findIssueId(a, params.number);
    const names = (body as { labels?: unknown } | null)?.labels;
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw new HttpError(400, "labels must be a list of names");
    const wanted = [...new Set((names as string[]).map((n) => n.toLowerCase()))];
    const rows = wanted.length ? db.select().from(label).where(and(eq(label.repoId, a.repo.id), inArray(label.name, wanted))).all() : [];
    const missing = wanted.filter((n) => !rows.some((r) => r.name === n));
    if (missing.length) throw new HttpError(400, `No such label: ${missing.join(", ")}`);
    db.transaction((tx) => {
      tx.delete(issueLabel).where(eq(issueLabel.issueId, issueId)).run();
      if (rows.length) tx.insert(issueLabel).values(rows.map((r) => ({ issueId, labelId: r.id }))).run();
    });
    return { ok: true };
  })
  // People who can be assigned: every account that can read the repository.
  .get("/repos/:owner/:repo/assignable", async ({ request, params }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "read");
    return {
      users: db
        .select({ id: user.id, username: user.username, role: user.role })
        .from(user)
        .orderBy(user.username)
        .all()
        .filter((u) => u.role !== "org" && repoAccess({ id: u.id }, a.owner, a.repo.name))
        .map((u) => u.username!),
    };
  })
  .put("/repos/:owner/:repo/issues/:number/assignees", async ({ request, params, body }) => {
    const a = requireRepo(await requireUser(request), params.owner, params.repo, "write");
    const issueId = findIssueId(a, params.number);
    const names = (body as { assignees?: unknown } | null)?.assignees;
    if (!Array.isArray(names) || names.length > 10 || names.some((n) => typeof n !== "string")) throw new HttpError(400, "assignees must be a list of up to ten usernames");
    const people = [...new Set(names as string[])].map((n) => {
      const u = findUser(n);
      // Only people who can see the repository can be assigned.
      if (!u || !repoAccess({ id: u.id }, a.owner, a.repo.name)) throw new HttpError(400, `${n} can't see this repository`);
      return u.id;
    });
    db.transaction((tx) => {
      tx.delete(issueAssignee).where(eq(issueAssignee.issueId, issueId)).run();
      if (people.length) tx.insert(issueAssignee).values(people.map((userId) => ({ issueId, userId }))).run();
    });
    return { ok: true };
  });
