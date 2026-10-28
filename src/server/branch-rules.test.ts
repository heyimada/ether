import { describe, expect, test } from "bun:test";
import { effectiveRule, matches, patternProblem, refusal, type BranchRule, type PushContext } from "./branch-rules";

const Z = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const rule = (pattern: string, o: Partial<BranchRule> = {}): BranchRule => ({ pattern, requirePullRequest: false, allowForcePush: false, allowDeletion: false, ...o });
const ctx = (o: Partial<PushContext> = {}): PushContext => ({ isAncestor: async () => true, branches: async () => ["main"], freshRepo: false, ...o });
const push = (ref: string, old: string, next: string) => ({ ref: `refs/heads/${ref}`, old, new: next });

describe("patterns", () => {
  test("* stays in one segment, ** spans several, ? is one character", () => {
    expect(matches("main", "main")).toBe(true);
    expect(matches("main", "main2")).toBe(false);
    expect(matches("release/*", "release/1.0")).toBe(true);
    expect(matches("release/*", "release/1/x")).toBe(false);
    expect(matches("release/**", "release/1/x")).toBe(true);
    expect(matches("v?.x", "v1.x")).toBe(true);
    expect(matches("a.b", "aXb")).toBe(false);
  });
  test("case is ignored, since a case-insensitive disk treats both spellings as one ref", () => {
    expect(matches("release/*", "RELEASE/1.0")).toBe(true);
    expect(matches("Main", "main")).toBe(true);
  });
  test("bad patterns are explained", () => {
    expect(patternProblem("refs/heads/main")).not.toBeNull();
    expect(patternProblem("a b")).not.toBeNull();
    expect(patternProblem("/main")).not.toBeNull();
    expect(patternProblem("main")).toBeNull();
  });
  test("the strictest of all matching rules wins", () => {
    expect(effectiveRule([rule("release/*", { allowForcePush: true }), rule("release/**", { requirePullRequest: true })], "release/1")).toEqual({
      requirePullRequest: true,
      allowForcePush: false,
      allowDeletion: false,
    });
  });
});

describe("refusal", () => {
  test("a name that differs from a branch only in case is refused, protected or not, for any change", async () => {
    const rules = [rule("main", { requirePullRequest: true })];
    expect(await refusal(rules, push("MAIN", Z, B), ctx())).toContain("only in case");
    expect(await refusal(rules, push("MAIN", A, B), ctx())).toContain("only in case");
    expect(await refusal(rules, push("Main", A, Z), ctx())).toContain("only in case");
    expect(await refusal([], push("Feature", Z, B), ctx({ branches: async () => ["feature"] }))).toContain("only in case");
    expect(await refusal(rules, push("other", Z, B), ctx())).toBeNull();
  });

  test("where both spellings really exist, each can be updated and deleted", async () => {
    const both = ctx({ branches: async () => ["Foo", "foo"] });
    expect(await refusal([rule("bar")], push("Foo", A, B), both)).toBeNull();
    expect(await refusal([rule("bar")], push("foo", A, Z), both)).toBeNull();
    // A third spelling is still a clash.
    expect(await refusal([rule("bar")], push("FOO", Z, B), both)).toContain("only in case");
  });

  test("a deleted protected branch can't come back under another spelling", async () => {
    const rules = [rule("release/*", { requirePullRequest: true, allowDeletion: true })];
    const gone = ctx({ branches: async () => ["main"] });
    expect(await refusal(rules, push("RELEASE/1.0", Z, B), gone)).toContain("can't be created by a push");
  });

  test("deleting and creating again can't get around pull requests", async () => {
    const rules = [rule("release/*", { requirePullRequest: true, allowDeletion: true })];
    expect(await refusal(rules, push("release/1", A, Z), ctx())).toBeNull();
    expect(await refusal(rules, push("release/1", Z, B), ctx())).toContain("can't be created by a push");
    // A repository's very first push still goes through.
    expect(await refusal(rules, push("release/1", Z, B), ctx({ freshRepo: true, branches: async () => [] }))).toBeNull();
  });

  test("without deletion, new protected branches can be created", async () => {
    expect(await refusal([rule("release/*", { requirePullRequest: true })], push("release/2", Z, B), ctx())).toBeNull();
    expect(await refusal([rule("release/*")], push("release/2", Z, B), ctx())).toBeNull();
  });

  test("direct, force and deleting pushes follow the rule", async () => {
    expect(await refusal([rule("main", { requirePullRequest: true })], push("main", A, B), ctx())).toContain("pull request");
    expect(await refusal([rule("main")], push("main", A, B), ctx({ isAncestor: async () => false }))).toContain("force pushes");
    expect(await refusal([rule("main", { allowForcePush: true })], push("main", A, B), ctx({ isAncestor: async () => false }))).toBeNull();
    expect(await refusal([rule("main")], push("main", A, Z), ctx())).toContain("can't be deleted");
    expect(await refusal([rule("main")], push("main", A, B), ctx())).toBeNull();
    expect(await refusal([rule("main")], { ref: "refs/tags/main", old: A, new: Z }, ctx())).toBeNull();
  });
});
