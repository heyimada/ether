import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { readableRepos, readerOrVisitor, requireUser } from "../access";
import { commitChecks } from "../ci";
import { db } from "../db/client";
import { issue, issueAssignee, orgMember, organization, reviewRequest, star, user } from "../db/schema";
import { listEvents } from "../events";
import * as git from "../git";
import { reviewSummary } from "./reviews";

const LIMIT = 8;

export const dashboardRoutes = new Elysia()
  // What happened lately in every repository the viewer can read, newest first.
  .get("/feed", async ({ request, query }) => {
    const viewer = await readerOrVisitor(request);
    const before = typeof query.before === "string" ? query.before : undefined;
    return listEvents(viewer.id, readableRepos(viewer.id), { before, limit: 30 });
  })
  // The signed-in person's open work. Every list is limited to repositories they can read now.
  .get("/me/work", async ({ request }) => {
    const viewer = await requireUser(request);
    const readable = readableRepos(viewer.id);
    const byId = new Map(readable.map((r) => [r.id, r]));
    const ids = [...byId.keys()];
    const at = (repoId: number) => ({ owner: byId.get(repoId)!.owner, repo: byId.get(repoId)!.name });

    const assigned = ids.length
      ? db
          .select({ number: issue.number, title: issue.title, isPull: issue.isPull, repoId: issue.repoId, updatedAt: issue.updatedAt })
          .from(issueAssignee)
          .innerJoin(issue, eq(issue.id, issueAssignee.issueId))
          .where(and(eq(issueAssignee.userId, viewer.id), eq(issue.state, "open"), inArray(issue.repoId, ids)))
          .orderBy(desc(issue.updatedAt))
          .limit(LIMIT)
          .all()
          .map((i) => ({ ...at(i.repoId), number: i.number, title: i.title, isPull: i.isPull, updatedAt: i.updatedAt }))
      : [];

    const mine = ids.length
      ? db
          .select()
          .from(issue)
          .where(and(eq(issue.authorId, viewer.id), eq(issue.isPull, true), eq(issue.state, "open"), inArray(issue.repoId, ids)))
          .orderBy(desc(issue.updatedAt))
          .limit(LIMIT)
          .all()
      : [];
    const pulls = await Promise.all(
      mine.map(async (p) => {
        const r = byId.get(p.repoId)!;
        const head = p.headRef ? await git.resolveCommit(r.path, `refs/heads/${p.headRef}`) : null;
        return { ...at(p.repoId), number: p.number, title: p.title, updatedAt: p.updatedAt, reviewDecision: reviewSummary(p.id).reviewDecision, checks: head ? (commitChecks(r.id, head)?.status ?? null) : null };
      }),
    );

    const reviews = ids.length
      ? db
          .select({ number: issue.number, title: issue.title, repoId: issue.repoId, author: user.username })
          .from(reviewRequest)
          .innerJoin(issue, eq(issue.id, reviewRequest.issueId))
          .innerJoin(user, eq(user.id, issue.authorId))
          .where(and(eq(reviewRequest.userId, viewer.id), eq(issue.state, "open"), inArray(issue.repoId, ids)))
          .limit(LIMIT)
          .all()
          .map((p) => ({ ...at(p.repoId), number: p.number, title: p.title, author: p.author! }))
      : [];

    const starred = db
      .select({ repoId: star.repoId })
      .from(star)
      .where(eq(star.userId, viewer.id))
      .orderBy(desc(star.createdAt))
      .all()
      .flatMap((s) => (byId.has(s.repoId) ? [{ ...at(s.repoId), description: byId.get(s.repoId)!.description }] : []))
      .slice(0, 5);

    // Counts of what the viewer can see, never of the whole server.
    // Everyone's name is public to signed-in people already (the people directory); organizations aren't people.
    const people = db.select({ id: user.id }).from(user).leftJoin(organization, eq(organization.userId, user.id)).where(isNull(organization.userId)).all().length;
    const orgs = db.select({ orgId: orgMember.orgId }).from(orgMember).where(eq(orgMember.userId, viewer.id)).all().length;
    return {
      assigned,
      pulls,
      reviews,
      starred,
      counts: { repos: readable.length, publicRepos: readable.filter((r) => r.visibility === "public").length, people, orgs },
    };
  });
