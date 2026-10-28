import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { copyRepoConsistently, copyTree, listIfPresent } from "./backup-copy";

const tmp = mkdtempSync(join(tmpdir(), "backup-copy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function bareRepo(name: string) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "refs", "heads"), { recursive: true });
  mkdirSync(join(dir, "objects", "pack"), { recursive: true });
  mkdirSync(join(dir, "objects", "ab"), { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "packed-refs"), "");
  writeFileSync(join(dir, "refs", "heads", "main"), "abc\n");
  writeFileSync(join(dir, "objects", "ab", "c"), "object\n");
  return dir;
}

test("git's lock and temp files vanishing mid-copy are skipped without a retry", () => {
  const from = bareRepo("scratch.git");
  const listed: string[] = [];
  // A push in flight: git lists its lock file and temp pack, then deletes them before the copy reaches them.
  const list = (dir: string) => {
    listed.push(dir);
    return [...readdirSync(dir), ...(dir === from ? ["shallow.lock"] : basename(dir) === "pack" ? ["tmp_pack_x"] : [])];
  };
  const to = join(tmp, "scratch-copy.git");
  copyRepoConsistently(from, to, list);
  expect(readFileSync(join(to, "refs", "heads", "main"), "utf8")).toBe("abc\n");
  expect(existsSync(join(to, "objects", "pack"))).toBe(true);
  expect(existsSync(join(to, "shallow.lock"))).toBe(false);
  expect(listed.filter((d) => d === from)).toHaveLength(1);
  // Loose refs are copied before objects.
  expect(listed.indexOf(join(from, "refs"))).toBeLessThan(listed.indexOf(join(from, "objects")));
});

test("a loose object or ref that gc or pack-refs removes mid-copy makes the repository copy again", () => {
  const from = bareRepo("gc.git");
  let firstPass = true;
  const list = (dir: string) => {
    const names = readdirSync(dir);
    // The first pass lists a loose object that gc packs and deletes before it's copied.
    if (firstPass && dir === join(from, "objects", "ab")) {
      firstPass = false;
      return [...names, "gone"];
    }
    return names;
  };
  const to = join(tmp, "gc-copy.git");
  copyRepoConsistently(from, to, list);
  expect(firstPass).toBe(false);
  expect(readFileSync(join(to, "objects", "ab", "c"), "utf8")).toBe("object\n");
});

test("a repository that keeps changing fails the backup instead of being copied broken", () => {
  const from = bareRepo("busy.git");
  const list = (dir: string) => [...readdirSync(dir), ...(dir === join(from, "refs", "heads") ? ["packed-away"] : [])];
  expect(() => copyRepoConsistently(from, join(tmp, "busy-copy.git"), list)).toThrow(/kept changing/);
});

test("a repository deleted mid-backup is left out, and empty folders are kept", () => {
  copyRepoConsistently(join(tmp, "deleted.git"), join(tmp, "deleted-copy"));
  expect(existsSync(join(tmp, "deleted-copy"))).toBe(false);
  const from = join(tmp, "empty");
  mkdirSync(join(from, "refs", "tags"), { recursive: true });
  copyTree(from, join(tmp, "empty-copy"));
  expect(existsSync(join(tmp, "empty-copy", "refs", "tags"))).toBe(true);
  expect(listIfPresent(join(tmp, "nope"))).toBeNull();
  writeFileSync(join(tmp, "file"), "");
  expect(listIfPresent(join(tmp, "file"))).toBeNull();
});
