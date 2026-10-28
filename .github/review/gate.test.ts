import { expect, test } from "bun:test";
import { ciState, decide, type GateInput } from "./gate";
import { isReviewBot, type CheckRun } from "./github";

const HEAD = "a".repeat(40);
const done = (lens: "bugs" | "security", over = {}) => ({ lens, round: 1, reviewedSha: HEAD, state: "done" as const, ...over });
const input = (over: Partial<GateInput> = {}): GateInput => ({
  headSha: HEAD,
  author: { login: "JustKatze", bot: false, permission: "write" },
  fork: false,
  draft: false,
  noAutomerge: false,
  eligibility: { eligible: true, reason: "only low-risk paths" },
  reviews: { bugs: done("bugs"), security: done("security") },
  openFindings: 0,
  ci: "success",
  ...over,
});
const blockedBy = (over: Partial<GateInput>) => {
  const d = decide(input(over));
  expect(d.wouldApprove).toBe(false);
  return d.reasons.join("\n");
};

test("a trusted author's eligible, reviewed, green change would be approved", () => {
  expect(decide(input()).wouldApprove).toBe(true);
  expect(decide(input({ author: { login: "heyimada", bot: false, permission: "admin" } })).wouldApprove).toBe(true);
});

test("a not-applicable review counts as finished", () => {
  expect(decide(input({ reviews: { bugs: done("bugs", { state: "not-applicable" }), security: done("security") } })).wouldApprove).toBe(true);
});

test("untrusted authors, bots and forks need a human", () => {
  expect(blockedBy({ author: { login: "someone", bot: false, permission: "read" } })).toContain("needs human approval");
  expect(blockedBy({ author: { login: "someone", bot: false, permission: "triage" } })).toContain("needs human approval");
  expect(blockedBy({ author: { login: "dependabot[bot]", bot: true, permission: "write" } })).toContain("is a bot");
  expect(blockedBy({ fork: true })).toContain("fork");
});

test("a review that errored, is missing or is for an older commit needs a human", () => {
  expect(blockedBy({ reviews: { bugs: done("bugs", { state: "errored" }), security: done("security") } })).toContain("bugs review errored");
  expect(blockedBy({ reviews: { bugs: done("bugs"), security: null } })).toContain("security review hasn't finished");
  expect(blockedBy({ reviews: { bugs: done("bugs", { reviewedSha: "b".repeat(40) }), security: done("security") } })).toContain("bugs review hasn't finished");
});

test("an ineligible change needs a human", () => {
  expect(blockedBy({ eligibility: { eligible: false, reason: "touches sensitive paths: bun.lock" } })).toContain("sensitive paths");
});

test("open findings, red or running CI, drafts and the no-automerge label block approval", () => {
  expect(blockedBy({ openFindings: 2 })).toContain("2 review findings are unresolved");
  expect(blockedBy({ ci: "failure" })).toContain("CI is failing");
  expect(blockedBy({ ci: "pending" })).toContain("CI is still running");
  expect(blockedBy({ draft: true })).toContain("draft");
  expect(blockedBy({ noAutomerge: true })).toContain("no-automerge");
});

test("every reason is reported, not just the first", () => {
  expect(decide(input({ fork: true, ci: "pending", openFindings: 1 })).reasons).toHaveLength(3);
});

test("markers are only trusted from the review App's bot account", () => {
  expect(isReviewBot({ login: "ether-review[bot]", type: "Bot" }, "ether-review[bot]")).toBe(true);
  expect(isReviewBot({ login: "ether-review", type: "Bot" }, "ether-review[bot]")).toBe(true);
  expect(isReviewBot({ login: "ether-review", type: "User" }, "ether-review[bot]")).toBe(false);
  expect(isReviewBot({ login: "other-app[bot]", type: "Bot" }, "ether-review[bot]")).toBe(false);
  expect(isReviewBot(null, "ether-review[bot]")).toBe(false);
});

let id = 0;
const run = (name: string, status: string, conclusion: string | null, slug = "github-actions"): CheckRun => ({ id: ++id, name, status, conclusion, app: { slug } });
const REQUIRED = ["Build", "E2E"];

test("CI is green only when every required check's latest run passed", () => {
  expect(ciState([run("Build", "completed", "success"), run("E2E", "completed", "success")], REQUIRED)).toBe("success");
  expect(ciState([run("Build", "completed", "success")], REQUIRED)).toBe("pending");
  expect(ciState([run("Build", "completed", "success"), run("E2E", "in_progress", null)], REQUIRED)).toBe("pending");
  expect(ciState([run("Build", "completed", "failure"), run("E2E", "in_progress", null)], REQUIRED)).toBe("failure");
});

test("a re-run replaces the earlier result of the same check", () => {
  expect(ciState([run("Build", "completed", "failure"), run("E2E", "completed", "success"), run("Build", "completed", "success")], REQUIRED)).toBe("success");
});

test("checks from other apps don't count, even with a required name", () => {
  expect(ciState([run("Build", "completed", "success", "impostor"), run("E2E", "completed", "success")], REQUIRED)).toBe("pending");
});
