import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRepoConsistently, copyTree, listIfPresent } from "./backup-copy";

const tmp = mkdtempSync(join(tmpdir(), "backup-copy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("files and folders that vanish between listing and copying are skipped", () => {
  const from = join(tmp, "repo.git");
  mkdirSync(join(from, "refs", "heads"), { recursive: true });
  mkdirSync(join(from, "objects", "pack"), { recursive: true });
  writeFileSync(join(from, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(from, "refs", "heads", "main"), "abc\n");
  // A push in flight: git lists its lock file and temp pack, then deletes them before the copy reaches them.
  const list = (dir: string) => [...readdirSync(dir), ...(dir === from ? ["shallow.lock"] : dir.endsWith("pack") ? ["tmp_pack_x"] : [])];
  const to = join(tmp, "copy.git");
  copyRepoConsistently(from, to, list);
  expect(readFileSync(join(to, "refs", "heads", "main"), "utf8")).toBe("abc\n");
  expect(existsSync(join(to, "objects", "pack"))).toBe(true);
  expect(existsSync(join(to, "shallow.lock"))).toBe(false);
});

test("empty folders are kept and a deleted repository is skipped", () => {
  const from = join(tmp, "empty");
  mkdirSync(join(from, "refs", "tags"), { recursive: true });
  copyTree(from, join(tmp, "empty-copy"));
  expect(existsSync(join(tmp, "empty-copy", "refs", "tags"))).toBe(true);
  copyRepoConsistently(join(tmp, "deleted.git"), join(tmp, "deleted-copy"));
  expect(existsSync(join(tmp, "deleted-copy"))).toBe(false);
  expect(listIfPresent(join(tmp, "nope"))).toBeNull();
  writeFileSync(join(tmp, "file"), "");
  expect(listIfPresent(join(tmp, "file"))).toBeNull();
});
