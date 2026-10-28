// Environments and deployments. A CI job that names an `environment:` becomes a deployment; before it runs,
// its environment's rules decide (see deploy-rules.ts) whether it may, has to wait for a reviewer or a timer,
// or is turned down. Waiting jobs step out of the CI queue so other runs keep going.
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db/client";
import { ciJob, deployment, environment, environmentReviewer, user } from "./db/schema";
import type { EnvironmentRules } from "./deploy-rules";

export type Environment = typeof environment.$inferSelect;
export type DeploymentStatus = (typeof deployment.$inferSelect)["status"];

export const findEnvironment = (repoId: number, name: string) =>
  db.select().from(environment).where(and(eq(environment.repoId, repoId), eq(environment.name, name))).get() ?? null;

// Created on first use, without rules, as on GitHub.
export function ensureEnvironment(repoId: number, name: string): Environment {
  db.insert(environment).values({ repoId, name }).onConflictDoNothing().run();
  return findEnvironment(repoId, name)!;
}

export const reviewerIds = (environmentId: number) =>
  db.select({ id: environmentReviewer.userId }).from(environmentReviewer).where(eq(environmentReviewer.environmentId, environmentId)).all().map((r) => r.id);

export const rulesOf = (env: Environment): EnvironmentRules => ({
  branches: JSON.parse(env.branches) as string[],
  reviewers: reviewerIds(env.id).length,
  waitMinutes: env.waitMinutes,
});

export function setEnvironmentRules(env: Environment, rules: { branches: string[]; waitMinutes: number; reviewers: string[] }) {
  db.transaction((tx) => {
    tx.update(environment).set({ branches: JSON.stringify(rules.branches), waitMinutes: rules.waitMinutes }).where(eq(environment.id, env.id)).run();
    tx.delete(environmentReviewer).where(eq(environmentReviewer.environmentId, env.id)).run();
    if (rules.reviewers.length) tx.insert(environmentReviewer).values(rules.reviewers.map((userId) => ({ environmentId: env.id, userId }))).run();
  });
}

export const deploymentOfJob = (jobId: number) => db.select().from(deployment).where(eq(deployment.jobId, jobId)).get() ?? null;

export function setDeployment(jobId: number, set: Partial<typeof deployment.$inferInsert>) {
  db.update(deployment).set(set).where(eq(deployment.jobId, jobId)).run();
}

// Every unfinished deployment of a run, when the run is cancelled.
export function cancelDeployments(runId: number) {
  db.update(deployment)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(deployment.runId, runId), inArray(deployment.status, ["queued", "waiting", "in_progress"])))
    .run();
}

const deploymentColumns = {
  id: deployment.id,
  environmentId: deployment.environmentId,
  runId: deployment.runId,
  jobId: deployment.jobId,
  sha: deployment.sha,
  ref: deployment.ref,
  status: deployment.status,
  url: deployment.url,
  createdAt: deployment.createdAt,
  finishedAt: deployment.finishedAt,
  actor: user.username,
};

// Newest first, for one environment or all of a repository's.
export function listDeployments(repoId: number, environmentId?: number, limit = 50) {
  return db
    .select(deploymentColumns)
    .from(deployment)
    .leftJoin(user, eq(user.id, deployment.actorId))
    .where(environmentId === undefined ? eq(deployment.repoId, repoId) : and(eq(deployment.repoId, repoId), eq(deployment.environmentId, environmentId)))
    .orderBy(desc(deployment.id))
    .limit(limit)
    .all();
}

// The repository's environments with their rules and, for each, the latest deployment and the latest that succeeded.
export function environmentsOverview(repoId: number) {
  const envs = db.select().from(environment).where(eq(environment.repoId, repoId)).orderBy(asc(environment.name)).all();
  return envs.map((env) => {
    const recent = listDeployments(repoId, env.id, 20);
    const reviewers = db
      .select({ username: user.username })
      .from(environmentReviewer)
      .innerJoin(user, eq(user.id, environmentReviewer.userId))
      .where(eq(environmentReviewer.environmentId, env.id))
      .orderBy(asc(user.username))
      .all()
      .map((r) => r.username!);
    return {
      name: env.name,
      branches: JSON.parse(env.branches) as string[],
      waitMinutes: env.waitMinutes,
      reviewers,
      latest: recent[0] ?? null,
      active: recent.find((d) => d.status === "success") ?? null,
    };
  });
}

// Environments whose current successful deployment is this commit, for "deployed to …" on pull requests.
export function deployedAt(repoId: number, sha: string) {
  return environmentsOverview(repoId)
    .filter((e) => e.active?.sha === sha)
    .map((e) => ({ environment: e.name, url: e.active!.url, runId: e.active!.runId }));
}

// The job's environment, for a deploy job.
export const environmentOfJob = (job: typeof ciJob.$inferSelect, repoId: number) => (job.environment ? findEnvironment(repoId, job.environment) : null);
