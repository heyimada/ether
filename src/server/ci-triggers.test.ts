import { expect, test } from "bun:test";
import { dueCron, parseOn, resolveInputs, starts, type PullAction, type Trigger } from "./ci-triggers";

const push = (ref: string, changed: string[] | null = ["src/a.ts"]): Trigger => ({ event: "push", refType: "branch", ref, changed });
const tag = (ref: string): Trigger => ({ event: "push", refType: "tag", ref, changed: null });
const pull = (base: string, action: PullAction = "opened", changed: string[] | null = ["src/a.ts"]): Trigger => ({ event: "pull_request", action, base, changed });

test("on: takes a name, a list or a map", () => {
  expect(parseOn("push").push).toEqual({ branches: null, tags: null, paths: null });
  expect(Object.keys(parseOn(["push", "workflow_dispatch"])).filter((k) => parseOn(["push", "workflow_dispatch"])[k as "push"])).toEqual(["push", "workflow_dispatch"]);
  expect(parseOn({ pull_request: { branches: "main" } }).pull_request?.branches).toEqual({ ignore: false, patterns: ["main"] });
  expect(() => parseOn({ push: { branches: ["a"], "branches-ignore": ["b"] } })).toThrow("either branches or branches-ignore");
  expect(() => parseOn({ pull_request: { types: ["closed"] } })).toThrow('"closed" isn\'t supported');
  expect(() => parseOn([])).toThrow("at least one event");
  // Branch and tag patterns use the protected-branch glob syntax; nothing reaches a regular expression unchecked.
  expect(() => parseOn({ push: { branches: ["feat["] } })).toThrow('on.push: branches: "feat["');
  expect(() => parseOn({ push: { tags: ["(wip"] } })).toThrow('on.push: tags: "(wip"');
  expect(() => parseOn({ pull_request: { "branches-ignore": ["release+1"] } })).toThrow("branches-ignore");
  expect(() => parseOn({ push: { branches: ["releases/**", "!releases/**-alpha"], paths: ["src/[a]+.ts"] } })).not.toThrow();
});

test("a bare push runs for every branch and tag", () => {
  const t = parseOn("push");
  expect(starts(t, push("main"))).toBe(true);
  expect(starts(t, push("feature/x"))).toBe(true);
  expect(starts(t, tag("v1.0"))).toBe(true);
  expect(starts(t, pull("main"))).toBe(false);
});

test("naming branches leaves tags out, and the other way round", () => {
  const branches = parseOn({ push: { branches: ["main", "release/**"] } });
  expect(starts(branches, push("main"))).toBe(true);
  expect(starts(branches, push("release/1/2"))).toBe(true);
  expect(starts(branches, push("feature"))).toBe(false);
  expect(starts(branches, tag("v1"))).toBe(false);
  const tags = parseOn({ push: { tags: ["v*"] } });
  expect(starts(tags, tag("v1.2"))).toBe(true);
  expect(starts(tags, tag("nightly"))).toBe(false);
  expect(starts(tags, push("main"))).toBe(false);
});

test("a later ! pattern takes a match back; ignore lists exclude", () => {
  const t = parseOn({ push: { branches: ["releases/**", "!releases/**-alpha"] } });
  expect(starts(t, push("releases/10"))).toBe(true);
  expect(starts(t, push("releases/10-alpha"))).toBe(false);
  const ignore = parseOn({ push: { "branches-ignore": ["wip/**"] } });
  expect(starts(ignore, push("wip/x"))).toBe(false);
  expect(starts(ignore, push("main"))).toBe(true);
});

test("path filters look at the changed files, but not for tags or when they aren't known", () => {
  const docs = parseOn({ push: { paths: ["docs/**", "*.md"] } });
  expect(starts(docs, push("main", ["docs/guide/a.md"]))).toBe(true);
  expect(starts(docs, push("main", ["README.md"]))).toBe(true);
  // * stays within a directory, and paths are case-sensitive.
  expect(starts(docs, push("main", ["src/notes.md"]))).toBe(false);
  expect(starts(docs, push("main", ["DOCS/a"]))).toBe(false);
  expect(starts(docs, push("main", null))).toBe(true);
  expect(starts(docs, tag("v1"))).toBe(true);
  const code = parseOn({ push: { "paths-ignore": ["docs/**"] } });
  expect(starts(code, push("main", ["docs/a.md"]))).toBe(false);
  expect(starts(code, push("main", ["docs/a.md", "src/b.ts"]))).toBe(true);
  const negated = parseOn({ push: { paths: ["src/**", "!src/**/*.test.ts"] } });
  expect(starts(negated, push("main", ["src/a.test.ts"]))).toBe(false);
  expect(starts(negated, push("main", ["src/a.test.ts", "src/a.ts"]))).toBe(true);
});

test("pull_request filters on the base branch and the action", () => {
  const t = parseOn({ pull_request: { branches: ["main"], types: ["opened", "synchronize"] } });
  expect(starts(t, pull("main"))).toBe(true);
  expect(starts(t, pull("main", "synchronize"))).toBe(true);
  expect(starts(t, pull("main", "reopened"))).toBe(false);
  expect(starts(t, pull("develop"))).toBe(false);
  expect(starts(t, push("main"))).toBe(false);
  expect(starts(parseOn({ pull_request: { paths: ["src/**"] } }), pull("main", "opened", ["docs/a"]))).toBe(false);
});

test("workflow_dispatch inputs are checked and filled in", () => {
  const t = parseOn({
    workflow_dispatch: {
      inputs: {
        target: { type: "choice", options: ["staging", "production"], default: "staging" },
        "dry-run": { type: "boolean" },
        count: { type: "number", required: true },
        note: { description: "Why" },
      },
    },
  });
  expect(starts(t, { event: "workflow_dispatch" })).toBe(true);
  const inputs = t.workflow_dispatch!.inputs;
  expect(resolveInputs(inputs, { count: 3 })).toEqual({ target: "staging", "dry-run": "false", count: "3", note: "" });
  expect(resolveInputs(inputs, { count: "1", target: "production", "dry-run": true, note: "hi" })).toEqual({ target: "production", "dry-run": "true", count: "1", note: "hi" });
  expect(() => resolveInputs(inputs, {})).toThrow('"count" is required');
  expect(() => resolveInputs(inputs, { count: "x" })).toThrow("must be a number");
  expect(() => resolveInputs(inputs, { count: 1, target: "prod" })).toThrow("one of staging, production");
  expect(() => resolveInputs(inputs, { count: 1, other: "x" })).toThrow('no input "other"');
  expect(() => parseOn({ workflow_dispatch: { inputs: { a: { type: "choice", options: ["x"], default: "y" } } } })).toThrow("its default must be one of x");
  expect(() => parseOn({ workflow_dispatch: { inputs: { "a-b": {}, a_b: {} } } })).toThrow("both become CI_INPUT_A_B");
});

test("path globs match in linear time, even for patterns built to backtrack", () => {
  const evil = parseOn({ push: { paths: ["**a".repeat(60) + "**b", "**/".repeat(60) + "z"] } });
  const started = performance.now();
  expect(starts(evil, push("main", ["a".repeat(4000), "/".repeat(2000) + "y", `${"x/".repeat(1500)}y`]))).toBe(false);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(starts(evil, push("main", [`${"a".repeat(70)}b`]))).toBe(true);
});

test("schedule takes a list of crons, and starts the workflow in the minutes one of them names", () => {
  const t = parseOn({ push: null, schedule: [{ cron: "0 3 * * *" }, { cron: " 30 12 * * MON " }] });
  expect(t.schedule).toEqual(["0 3 * * *", "30 12 * * MON"]);
  const at = (iso: string): Trigger => ({ event: "schedule", at: new Date(`${iso}Z`) });
  expect(starts(t, at("2026-11-06T03:00:00"))).toBe(true);
  expect(starts(t, at("2026-11-06T03:01:00"))).toBe(false);
  expect(dueCron(t, new Date("2026-11-09T12:30:00Z"))).toBe("30 12 * * MON");
  // A schedule doesn't make a workflow run on anything else, nor a push on a schedule.
  expect(starts(parseOn({ schedule: [{ cron: "0 3 * * *" }] }), push("main"))).toBe(false);
  expect(starts(parseOn("push"), at("2026-11-06T03:00:00"))).toBe(false);
  for (const [raw, why] of [
    [{ schedule: null }, "must be a list"],
    [{ schedule: [] }, "must be a list"],
    [{ schedule: ["0 3 * * *"] }, "cron:"],
    [{ schedule: [{ cron: "0 3 * * *", tz: "Europe/Berlin" }] }, "cron:"],
    [{ schedule: [{ cron: "* * * * *" }] }, "on.schedule:"],
    [{ schedule: Array(11).fill({ cron: "0 3 * * *" }) }, "at most 10"],
  ] as const)
    expect(() => parseOn(raw), JSON.stringify(raw)).toThrow(why);
});

test("marking a draft ready for review only starts workflows that ask for it, as on GitHub", () => {
  expect(starts(parseOn("pull_request"), pull("main", "ready_for_review"))).toBe(false);
  expect(parseOn("pull_request").pull_request?.types).toEqual(["opened", "synchronize", "reopened"]);
  const t = parseOn({ pull_request: { types: ["ready_for_review"] } });
  expect(starts(t, pull("main", "ready_for_review"))).toBe(true);
  expect(starts(t, pull("main", "opened"))).toBe(false);
});
