import { expect, test } from "bun:test";
import { fixPrompt, stagedChanges, trackedSymlinks } from "./fix";

const raw = (...entries: [string, string, string, string][]) =>
  entries.map(([oldMode, newMode, status, path]) => `:${oldMode} ${newMode} ${"1".repeat(40)} ${"2".repeat(40)} ${status}\0${path}\0`).join("");

test("added, modified and deleted regular files become a commit", () => {
  expect(stagedChanges(raw(["000000", "100644", "A", "src/new.ts"], ["100644", "100644", "M", "src/a b.ts"], ["100644", "000000", "D", "old.ts"]))).toEqual({
    additions: ["src/new.ts", "src/a b.ts"],
    deletions: ["old.ts"],
  });
  expect(stagedChanges("")).toEqual({ additions: [], deletions: [] });
});

test("workflow and review files are off limits, in any spelling", () => {
  expect(stagedChanges(raw(["100644", "100644", "M", ".github/workflows/ci.yml"]))).toHaveProperty("error");
  expect(stagedChanges(raw(["100644", "100644", "M", ".GitHub/review/gate.ts"]))).toHaveProperty("error");
});

test("symlinks, executables and mode changes can't be committed", () => {
  expect(stagedChanges(raw(["000000", "120000", "A", "link"]))).toHaveProperty("error");
  expect(stagedChanges(raw(["100755", "100755", "M", "run.sh"]))).toHaveProperty("error");
  expect(stagedChanges(raw(["100644", "100755", "M", "run.sh"]))).toHaveProperty("error");
  expect(stagedChanges(raw(["120000", "000000", "D", "link"]))).toHaveProperty("error");
  expect(stagedChanges(raw(["100644", "100644", "T", "x"]))).toHaveProperty("error");
});

test("the prompt quotes every finding and the maintainer's request", () => {
  const p = fixPrompt([{ fingerprint: "abc", file: "src/a.ts", line: 3, body: "**Important** (correctness): x" }], "only the first one");
  expect(p).toContain("[abc] src/a.ts:3");
  expect(p).toContain("<request>\nonly the first one\n</request>");
  expect(fixPrompt([], "")).not.toContain("<request>");
});

test("a commit's symlinks are found in its tree listing", () => {
  expect(trackedSymlinks(`100644 blob ${"1".repeat(40)}\tsrc/a.ts\x00120000 blob ${"2".repeat(40)}\tdocs/link with space\0`)).toEqual(["docs/link with space"]);
  expect(trackedSymlinks("")).toEqual([]);
});
