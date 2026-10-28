import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyReason, limiter } from "./agents";

// realpath matters: on macOS the temp dir is /var/folders/..., which is a symlink to /private/var/....
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "review-sandbox-")));
const root = join(tmp, "pr");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src/a.ts"), "");
writeFileSync(join(tmp, "secret.txt"), "");
symlinkSync(join(tmp, "secret.txt"), join(root, "src/leak.txt"));
symlinkSync(tmp, join(root, "up"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const read = (file_path: string) => denyReason(root, "Read", { file_path });

test("reads inside the checkout are allowed, relative or absolute, even for files that don't exist", () => {
  expect(read("src/a.ts")).toBeNull();
  expect(read(join(root, "src/a.ts"))).toBeNull();
  expect(read("src/missing/deeper.ts")).toBeNull();
});

test("reads that climb out with .. are denied", () => {
  expect(read("../secret.txt")).not.toBeNull();
  expect(read("src/../../secret.txt")).not.toBeNull();
  expect(read(join(root, "../secret.txt"))).not.toBeNull();
  expect(read("/etc/passwd")).not.toBeNull();
  expect(read("~/.ssh/id_ed25519")).not.toBeNull();
});

test("a symlink that points outside the checkout is denied, for files and directories", () => {
  expect(read("src/leak.txt")).not.toBeNull();
  expect(read("up/secret.txt")).not.toBeNull();
  expect(denyReason(root, "Grep", { pattern: "x", path: "up" })).not.toBeNull();
});

test("Grep and Glob are confined by their path, pattern and glob", () => {
  expect(denyReason(root, "Grep", { pattern: "password" })).toBeNull();
  expect(denyReason(root, "Grep", { pattern: "x", path: "src", glob: "**/*.ts" })).toBeNull();
  expect(denyReason(root, "Grep", { pattern: "x", path: tmp })).not.toBeNull();
  expect(denyReason(root, "Grep", { pattern: "x", glob: "../**" })).not.toBeNull();
  expect(denyReason(root, "Glob", { pattern: "src/**/*.ts" })).toBeNull();
  expect(denyReason(root, "Glob", { pattern: `${root}/**/*.ts` })).toBeNull();
  expect(denyReason(root, "Glob", { pattern: "**/../../*" })).not.toBeNull();
  expect(denyReason(root, "Glob", { pattern: "/etc/*" })).not.toBeNull();
  expect(denyReason(root, "Glob", { pattern: "/**/secret.txt" })).not.toBeNull();
  expect(denyReason(root, "Glob", { pattern: "*.txt", path: "/" })).not.toBeNull();
  expect(denyReason(root, "Glob", { pattern: "up/*" })).not.toBeNull();
});

test("tools other than the read-only three are denied; the structured output tool is allowed", () => {
  expect(denyReason(root, "Bash", { command: "env" })).not.toBeNull();
  expect(denyReason(root, "Write", { file_path: "src/a.ts", content: "" })).not.toBeNull();
  expect(denyReason(root, "WebFetch", { url: "https://example.com" })).not.toBeNull();
  expect(denyReason(root, "StructuredOutput", { anything: 1 })).toBeNull();
});

test("the limiter never runs more than its maximum at once", async () => {
  const limit = limiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limit(async () => {
        peak = Math.max(peak, ++active);
        await Bun.sleep(5);
        active--;
      }),
    ),
  );
  expect(peak).toBe(2);
});
