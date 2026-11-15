import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { HttpError, allows, findUser, readableRepos, repoAccess, requireRepo, requireUser } from "../access";
import { db } from "../db/client";
import { review, reviewComment, reviewRequest, team, teamReviewRequest } from "../db/schema";
import * as git from "../git";
import { record } from "../events";
import { answerTeamRequests } from "../owners";
import { findPull, pullStatus, requestedOf } from "../pulls";
import { notify, notifyThread, teamMembers } from "../notify";
import { sideEffect } from "../side-effect";
import { BODY_MAX } from "../../shared/issues";

// Line numbers on the new side of a unified diff, per file: the lines a review can comment on.
function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "");
      current = path === "/dev/null" ? null : new Set();
      if (current) files.set(path, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!current || raw.startsWith("diff ") || raw.startsWith("--- ") || raw.startsWith("\\")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) current.add(line++);
  }
  return files;
}

export const reviewRoutes = new Elysia()
  .put("/repos/:owner/:repo/pulls/:number/reviewers", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "write");
    const row = findPull(a, params.number);
    const names = (body as { reviewers?: unknown } | null)?.reviewers;
    const teamNames = (body as { teams?: unknown } | null)?.teams;
    if (!Array.isArray(names) || names.length > 15 || names.some((n) => typeof n !== "string")) throw new HttpError(400, "reviewers must be a list of usernames");
    if (teamNames !== undefined && (!Array.isArray(teamNames) || teamNames.length > 15 || teamNames.some((n) => typeof n !== "string")))
      throw new HttpError(400, "teams must be a list of org/team names");
    // Teams of the organization that owns the repository, which is the only one whose teams can reach it.
    const teamIds =
      teamNames === undefined
        ? null
        : [...new Set(teamNames as string[])].map((n) => {
            const [org, name, ...rest] = n.toLowerCase().replace(/^@/, "").split("/");
            const t =
              !rest.length && org === a.owner.toLowerCase() && name
                ? db.select({ id: team.id }).from(team).where(and(eq(team.orgId, a.repo.ownerId), eq(team.name, name))).get()
                : undefined;
            if (!t) throw new HttpError(400, `${n} isn't a team of ${a.owner}`);
            return t.id;
          })
          // The same team written two ways ("org/core", "@Org/Core") is asked once.
          .filter((id, i, all) => all.indexOf(id) === i);
    // Who's asked already: sent back unchanged, someone who has since lost access is dropped rather than refused,
    // so a stale request doesn't block every other change to the list.
    const before = new Set(db.select({ id: reviewRequest.userId }).from(reviewRequest).where(eq(reviewRequest.issueId, row.issue.id)).all().map((r) => r.id));
    const ids = [...new Set(names as string[])].flatMap((n) => {
      const u = findUser(n);
      if (!u || !repoAccess({ id: u.id }, a.owner, a.repo.name)) {
        if (u && before.has(u.id)) return [];
        throw new HttpError(400, `${n} can't see this repository`);
      }
      if (u.id === row.issue.authorId) throw new HttpError(400, "Authors can't review their own pull request");
      return [u.id];
    });
    // Who's newly asked hears about it; those asked already don't hear again.
    const teamsBefore = new Set(db.select({ id: teamReviewRequest.teamId }).from(teamReviewRequest).where(eq(teamReviewRequest.issueId, row.issue.id)).all().map((r) => r.id));
    db.transaction((tx) => {
      tx.delete(reviewRequest).where(eq(reviewRequest.issueId, row.issue.id)).run();
      if (ids.length) tx.insert(reviewRequest).values(ids.map((userId) => ({ issueId: row.issue.id, userId }))).run();
      // A request without `teams` leaves the team requests as they are.
      if (teamIds) {
        tx.delete(teamReviewRequest).where(eq(teamReviewRequest.issueId, row.issue.id)).run();
        if (teamIds.length) tx.insert(teamReviewRequest).values(teamIds.map((teamId) => ({ issueId: row.issue.id, teamId }))).run();
      }
    });
    const asked = [...ids.filter((id) => !before.has(id)), ...teamMembers((teamIds ?? []).filter((id) => !teamsBefore.has(id))).filter((id) => id !== row.issue.authorId)];
    void sideEffect("Notifying", () => notify(asked, "review_requested", viewer.id, { repoId: a.repo.id, issueNumber: row.issue.number, title: row.issue.title }));
    return { ok: true };
  })
  .post("/repos/:owner/:repo/pulls/:number/reviews", async ({ request, params, body }) => {
    const viewer = await requireUser(request);
    const a = requireRepo(viewer, params.owner, params.repo, "read");
    const row = findPull(a, params.number);
    if (row.issue.state !== "open") throw new HttpError(409, "This pull request is not open");
    const b = (body ?? {}) as { state?: unknown; body?: unknown; comments?: unknown };
    const state = b.state;
    if (state !== "approved" && state !== "changes_requested" && state !== "commented") throw new HttpError(400, "state must be approved, changes_requested or commented");
    if (state !== "commented") {
      if (row.issue.authorId === viewer.id) throw new HttpError(400, "Authors can't approve or request changes on their own pull request");
      if (!allows(a.role, "write")) throw new HttpError(403, "Only people with write access can approve or request changes");
    }
    const comments = Array.isArray(b.comments) ? (b.comments as { path?: unknown; line?: unknown; body?: unknown }[]) : [];
    const text = typeof b.body === "string" ? b.body.slice(0, BODY_MAX) : "";
    if (state === "commented" && !text.trim() && comments.length === 0) throw new HttpError(400, "A comment review needs a summary or line comments");
    const status = await pullStatus(a, row);
    if (status.missing) throw new HttpError(409, "A branch of this pull request no longer exists");
    const lines = commentableLines(status.diff);
    const checked = comments.map((c) => {
      if (typeof c.path !== "string" || typeof c.line !== "number" || typeof c.body !== "string" || !c.body.trim()) throw new HttpError(400, "Each line comment needs a path, line and body");
      if (!lines.get(c.path)?.has(c.line)) throw new HttpError(400, `${c.path}:${c.line} is not a line in this diff`);
      return { path: c.path, line: c.line, body: c.body.slice(0, BODY_MAX) };
    });
    const headSha = (await git.resolveCommit(a.path, `refs/heads/${row.issue.headRef}`))!;
    db.transaction((tx) => {
      const r = tx.insert(review).values({ issueId: row.issue.id, authorId: viewer.id, state, body: text, commitSha: headSha }).returning({ id: review.id }).get();
      if (checked.length) tx.insert(reviewComment).values(checked.map((c) => ({ ...c, reviewId: r.id }))).run();
      // A submitted review answers the request.
      tx.delete(reviewRequest).where(and(eq(reviewRequest.issueId, row.issue.id), eq(reviewRequest.userId, viewer.id))).run();
    });
    // Only someone who could approve answers for their teams; a read-only member's comment doesn't.
    if (allows(a.role, "write")) answerTeamRequests(row.issue.id, viewer.id);
    void sideEffect("Notifying", () =>
      notifyThread(row.issue.id, "review", viewer.id, { repoId: a.repo.id, issueNumber: row.issue.number, title: row.issue.title, excerpt: text || checked[0]?.body }, [text, ...checked.map((c) => c.body)]),
    );
    record(a.repo.id, viewer.id, "review", { number: row.issue.number, title: row.issue.title, state });
    return { ok: true };
  })
  .get("/me/review-requests", async ({ request }) => {
    const viewer = await requireUser(request);
    const readable = new Map(readableRepos(viewer.id).map((r) => [r.id, r]));
    return {
      pulls: requestedOf(viewer.id, [...readable.keys()])
        .flatMap((p) => {
          const r = readable.get(p.repoId);
          return r ? [{ owner: r.owner, repo: r.name, number: p.number, title: p.title }] : [];
        }),
    };
  });
