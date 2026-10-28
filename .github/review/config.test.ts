import { expect, test } from "bun:test";
import { concurrency, eligibility, isLowRisk, isSensitive } from "./config";

test("workflow files, auth and the lockfile are sensitive; app code and docs are not", () => {
  for (const p of [".github/workflows/ci.yml", "src/server/access.ts", "src/server/db/schema.ts", "drizzle/0001_x.sql", "bun.lock", "cli/Cargo.toml"]) expect(isSensitive(p)).toBe(true);
  for (const p of ["src/server/routes/repos.ts", "README.md", "cli/src/main.rs", "src/web/app.tsx"]) expect(isSensitive(p)).toBe(false);
});

test("docs and design are low risk at any depth; source code is not", () => {
  for (const p of ["README.md", "docs/a/b.md", "design/mock.png"]) expect(isLowRisk(p)).toBe(true);
  for (const p of ["src/server/ci.ts", "package.json", "vite.config.ts"]) expect(isLowRisk(p)).toBe(false);
});

test("a sensitive path is never eligible, even when the model rates it low", () => {
  expect(eligibility(["README.md", ".github/workflows/ci.yml"], "low").eligible).toBe(false);
});

test("an allowlisted change is eligible unless the model escalates it", () => {
  expect(eligibility(["README.md", "design/x.md"], "missing").eligible).toBe(true);
  expect(eligibility(["README.md"], "not-low").eligible).toBe(false);
});

test("other code needs the model to rate it low", () => {
  expect(eligibility(["src/web/app.tsx"], "low").eligible).toBe(true);
  expect(eligibility(["src/web/app.tsx"], "not-low").eligible).toBe(false);
  expect(eligibility(["src/web/app.tsx"], "errored").eligible).toBe(false);
  expect(eligibility(["src/web/app.tsx"], "missing").eligible).toBe(false);
});

test("an empty change is not eligible", () => {
  expect(eligibility([], "low").eligible).toBe(false);
});

test("concurrency falls back to 3 unless it's a positive integer", () => {
  for (const raw of [undefined, "", "0", "-2", "abc", "1.5"]) expect(concurrency(raw)).toBe(3);
  expect(concurrency("5")).toBe(5);
});

test("agent instructions and CI secrets are sensitive; tests alone are no longer low risk", () => {
  for (const p of ["CLAUDE.md", "docs/CLAUDE.md", "AGENTS.md", ".claude/settings.json", "src/server/secret-box.ts", "src/server/log-mask.ts"]) expect(isSensitive(p)).toBe(true);
  for (const p of ["src/server/x.test.ts", "e2e/git.spec.ts"]) expect(isLowRisk(p)).toBe(false);
  expect(eligibility(["CLAUDE.md"], "low").eligible).toBe(false);
});

test("every SENSITIVE path is covered by CODEOWNERS", async () => {
  const owners = (await Bun.file(".github/CODEOWNERS").text()).split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)[0]);
  const covered = (p: string) => owners.some((o) => (o.endsWith("/") ? `/${p}`.startsWith(o) : o.startsWith("/") ? `/${p}` === o : p === o || p.endsWith(`/${o}`)));
  for (const p of [".github/workflows/ci.yml", "CLAUDE.md", "docs/AGENTS.md", ".claude/x", "src/server/access.ts", "src/server/db/schema.ts", "drizzle/0001.sql", "package.json", "bun.lock", "cli/Cargo.toml", "cli/Cargo.lock", "src/server/secret-box.ts"]) {
    expect(isSensitive(p)).toBe(true);
    expect(covered(p)).toBe(true);
  }
});
