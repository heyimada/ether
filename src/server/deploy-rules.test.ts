import { expect, test } from "bun:test";
import { gate } from "./deploy-rules";

const queued = new Date("2026-01-01T10:00:00Z");
const at = (min: number) => new Date(queued.getTime() + min * 60_000);
const none = { branches: [], reviewers: 0, waitMinutes: 0 };

test("an environment without rules lets any branch deploy right away", () => {
  expect(gate(none, "feature/x", null, queued, queued)).toEqual({ action: "run" });
});

test("only allowed branches may deploy, matched like branch protection", () => {
  const rules = { ...none, branches: ["main", "release/*"] };
  expect(gate(rules, "main", null, queued, queued).action).toBe("run");
  expect(gate(rules, "release/1.2", null, queued, queued).action).toBe("run");
  expect(gate(rules, "release/1/x", null, queued, queued)).toEqual({ action: "reject", reason: "release/1/x isn't allowed to deploy here" });
  // A disallowed branch is turned down before anyone is asked to approve it.
  expect(gate({ ...rules, reviewers: 2 }, "feature", null, queued, queued).action).toBe("reject");
});

test("with reviewers, a deployment waits for an approval, and a rejection turns it down", () => {
  const rules = { ...none, reviewers: 1 };
  expect(gate(rules, "main", null, queued, queued)).toEqual({ action: "await-review" });
  expect(gate(rules, "main", { approved: true, at: at(5) }, queued, at(5)).action).toBe("run");
  expect(gate(rules, "main", { approved: false, at: at(5) }, queued, at(5)).action).toBe("reject");
});

test("the wait timer counts from the approval, or from queueing when nobody has to approve", () => {
  expect(gate({ ...none, waitMinutes: 10 }, "main", null, queued, at(3))).toEqual({ action: "wait-until", at: at(10) });
  expect(gate({ ...none, waitMinutes: 10 }, "main", null, queued, at(10)).action).toBe("run");
  const rules = { ...none, reviewers: 1, waitMinutes: 10 };
  expect(gate(rules, "main", { approved: true, at: at(30) }, queued, at(31))).toEqual({ action: "wait-until", at: at(40) });
  expect(gate(rules, "main", { approved: true, at: at(30) }, queued, at(41)).action).toBe("run");
});
