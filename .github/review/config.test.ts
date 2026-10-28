import { expect, test } from "bun:test";
import { eligibility, isLowRisk, isSensitive } from "./config";

test("workflow files, auth and the lockfile are sensitive; app code and docs are not", () => {
  for (const p of [".github/workflows/ci.yml", "src/server/access.ts", "src/server/db/schema.ts", "drizzle/0001_x.sql", "bun.lock", "cli/Cargo.toml"]) expect(isSensitive(p)).toBe(true);
  for (const p of ["src/server/routes/repos.ts", "README.md", "cli/src/main.rs", "src/web/app.tsx"]) expect(isSensitive(p)).toBe(false);
});

test("docs, design and tests are low risk at any depth; source code is not", () => {
  for (const p of ["README.md", "docs/a/b.md", "design/mock.png", "src/server/x.test.ts", "e2e/git.spec.ts"]) expect(isLowRisk(p)).toBe(true);
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
