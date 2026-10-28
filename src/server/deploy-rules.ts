// What a deploy job may do when its turn comes, from its environment's rules. Pure, so it is tested without a database.
import { matches } from "./branch-rules";

export type EnvironmentRules = { branches: string[]; reviewers: number; waitMinutes: number };
export type Review = { approved: boolean; at: Date } | null;

export type Gate =
  | { action: "run" }
  | { action: "reject"; reason: string }
  | { action: "await-review" }
  | { action: "wait-until"; at: Date };

// Order as on GitHub: the branch has to be allowed, then a reviewer has to approve, then the wait timer runs
// (from the approval, or from when the job was queued when nobody has to approve).
export function gate(rules: EnvironmentRules, ref: string, review: Review, queuedAt: Date, now: Date): Gate {
  if (rules.branches.length && !rules.branches.some((p) => matches(p, ref))) return { action: "reject", reason: `${ref} isn't allowed to deploy here` };
  if (review && !review.approved) return { action: "reject", reason: "the deployment was rejected" };
  if (rules.reviewers > 0 && !review) return { action: "await-review" };
  if (rules.waitMinutes > 0) {
    const at = new Date((review?.at ?? queuedAt).getTime() + rules.waitMinutes * 60_000);
    if (now < at) return { action: "wait-until", at };
  }
  return { action: "run" };
}
