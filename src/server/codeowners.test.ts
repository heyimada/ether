import { expect, test } from "bun:test";
import { ownedFiles, ownersFor, ownerText, parseCodeOwners } from "./codeowners";

const owners = (text: string, path: string) => ownersFor(parseCodeOwners(text), path).map(ownerText);

test("the last matching line decides, as on GitHub", () => {
  const co = `
# Everyone else
*       @global
*.js    @js-owner   # trailing comment
/build/logs/ @logs
docs/*  @docs
apps/   @apps
**/logs @any-logs
/scripts/ @scripts @org/Ops
/scripts/generated/
`;
  expect(owners(co, "README.md")).toEqual(["@global"]);
  expect(owners(co, "src/deep/a.js")).toEqual(["@js-owner"]);
  // docs/* owns files right in docs, not deeper ones; an unanchored name owns that directory anywhere.
  expect(owners(co, "docs/start.md")).toEqual(["@docs"]);
  expect(owners(co, "docs/build/trouble.md")).toEqual(["@global"]);
  expect(owners(co, "web/apps/x/y.ts")).toEqual(["@apps"]);
  expect(owners(co, "deeply/nested/logs/today.txt")).toEqual(["@any-logs"]);
  expect(owners(co, "build/logs/x.txt")).toEqual(["@any-logs"]);
  // Teams keep their organization, lowercased; a line without owners takes ownership away.
  expect(owners(co, "scripts/run.sh")).toEqual(["@scripts", "@org/ops"]);
  expect(owners(co, "scripts/generated/out.sh")).toEqual([]);
});

test("a leading slash anchors, a trailing slash means only what's inside", () => {
  const co = parseCodeOwners("/src @root-src\nlib/ @lib\n");
  expect(ownersFor(co, "src/a.ts").map(ownerText)).toEqual(["@root-src"]);
  expect(ownersFor(co, "pkg/src/a.ts")).toEqual([]);
  expect(ownersFor(co, "pkg/lib/a.ts").map(ownerText)).toEqual(["@lib"]);
  expect(ownersFor(co, "lib")).toEqual([]);
});

test("lines it can't use are reported with their line number and skipped", () => {
  const { rules, problems } = parseCodeOwners("*.md @ok\n!*.txt @x\n[ab].ts @x\n*.go octocat@example.com\n*.rb @a/b/c\n");
  expect(rules.map((r) => r.pattern)).toEqual(["*.md"]);
  expect(problems.map((p) => p.line)).toEqual([2, 3, 4, 5]);
  expect(problems[2].message).toContain("by email");
  expect(parseCodeOwners("x".repeat(300 * 1024)).problems[0].message).toContain("ignored");
});

test("ownedFiles groups changed files by the rule that owns them, and gives up past its budget", () => {
  const co = parseCodeOwners("*.ts @ts\n/docs/ @docs\n");
  const owned = ownedFiles(co, ["a.ts", "docs/x.md", "b.txt", "src/c.ts"])!;
  expect([...owned.entries()].map(([r, files]) => [r.pattern, files])).toEqual([
    ["*.ts", ["a.ts", "src/c.ts"]],
    ["/docs/", ["docs/x.md"]],
  ]);
  const big = parseCodeOwners(Array.from({ length: 1000 }, (_, i) => `/p${i}/**/${"*a".repeat(100)} @x`).join("\n"));
  expect(ownedFiles(big, Array.from({ length: 3000 }, (_, i) => `f${i}/${"a".repeat(200)}`))).toBeNull();
});
