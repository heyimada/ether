// What a deploy job may do when its turn comes, from its environment's rules. Pure, so it is tested without a database.
import { matches } from "./branch-rules";

export type EnvironmentRules = { branches: string[]; reviewers: number; waitMinutes: number };
export type Review = { approved: boolean; at: Date } | null;

export type Gate =
  | { action: "run" }
  // The branch may not deploy here: the job doesn't run, and that's not a failure of the run.
  | { action: "skip"; reason: string }
  | { action: "reject"; reason: string }
  | { action: "await-review" }
  | { action: "wait-until"; at: Date };

// Order as on GitHub: the branch has to be allowed, then a reviewer has to approve, then the wait timer runs
// (from the approval, or from when the job was queued when nobody has to approve).
export function gate(rules: EnvironmentRules, ref: string, review: Review, queuedAt: Date, now: Date, refType: "branch" | "tag" = "branch"): Gate {
  // The patterns name branches, so a tag (which could share a branch's name) only deploys where any ref may.
  if (rules.branches.length && refType === "tag") return { action: "skip", reason: `tags aren't allowed to deploy here, only ${rules.branches.join(", ")}` };
  if (rules.branches.length && !rules.branches.some((p) => matches(p, ref))) return { action: "skip", reason: `${ref} isn't allowed to deploy here` };
  if (review && !review.approved) return { action: "reject", reason: "the deployment was rejected" };
  if (rules.reviewers > 0 && !review) return { action: "await-review" };
  if (rules.waitMinutes > 0) {
    const at = new Date((review?.at ?? queuedAt).getTime() + rules.waitMinutes * 60_000);
    if (now < at) return { action: "wait-until", at };
  }
  return { action: "run" };
}
