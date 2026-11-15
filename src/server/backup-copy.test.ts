import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { copyRepoConsistently, copyTree, isGitScratch, listIfPresent } from "./backup-copy";

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

test("git's lock and temp files vanishing mid-copy are skipped, however often they do", () => {
  const from = bareRepo("scratch.git");
  // A push in flight: git lists its lock file and temp pack, then deletes them before the copy reaches them. Listed on
  // every pass, so a copy that counted them as changes would never settle and would fail.
  const list = (dir: string) => [...readdirSync(dir), ...(dir === from ? ["shallow.lock"] : basename(dir) === "pack" ? ["tmp_pack_x"] : [])];
  const to = join(tmp, "scratch-copy.git");
  copyRepoConsistently(from, to, list);
  expect(readFileSync(join(to, "refs", "heads", "main"), "utf8")).toBe("abc\n");
  expect(existsSync(join(to, "objects", "pack"))).toBe(true);
  expect(existsSync(join(to, "shallow.lock"))).toBe(false);
});

test("objects are copied after the refs that point at them", () => {
  const from = bareRepo("order.git");
  let pushed = false;
  // A push lands while refs/heads is being read: its new ref and its object appear together.
  const list = (dir: string) => {
    if (!pushed && dir === join(from, "refs", "heads")) {
      pushed = true;
      mkdirSync(join(from, "objects", "cd"), { recursive: true });
      writeFileSync(join(from, "objects", "cd", "new"), "object\n");
      writeFileSync(join(from, "refs", "heads", "late"), "cdnew\n");
    }
    return readdirSync(dir);
  };
  const to = join(tmp, "order-copy.git");
  copyRepoConsistently(from, to, list);
  expect(existsSync(join(to, "refs", "heads", "late"))).toBe(true);
  expect(existsSync(join(to, "objects", "cd", "new"))).toBe(true);
});

test("a loose object or ref that gc or pack-refs removes mid-copy doesn't fail the backup", () => {
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
  expect(readFileSync(join(to, "objects", "ab", "c"), "utf8")).toBe("object\n");
  expect(existsSync(join(to, "objects", "ab", "gone"))).toBe(false);
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

test("files inside a push's quarantine or a temp folder count as scratch, wherever the repository lives", () => {
  for (const p of ["shallow.lock", "refs/heads/main.lock", "objects/incoming-a1b2/pack/pack-123.pack", "objects/incoming-a1b2/ab/cdef", "objects/pack/tmp_pack_x", "gc.pid"])
    expect(isGitScratch(join(...p.split("/")))).toBe(true);
  for (const p of ["objects/ab/cdef", "objects/pack/pack-123.pack", "refs/heads/main", "packed-refs"]) expect(isGitScratch(join(...p.split("/")))).toBe(false);
});

test("a push finishing mid-copy, moving objects out of its quarantine folder, doesn't fail the backup", () => {
  const from = bareRepo("quarantine.git");
  mkdirSync(join(from, "objects", "incoming-a1b2", "pack"), { recursive: true });
  // The quarantine's pack is listed, then git moves it into objects/pack/ before the copy reaches it.
  const list = (dir: string) => {
    const names = readdirSync(dir);
    return dir === join(from, "objects", "incoming-a1b2", "pack") ? [...names, "pack-123.pack"] : names;
  };
  const to = join(tmp, "quarantine-copy.git");
  copyRepoConsistently(from, to, list);
  expect(readFileSync(join(to, "refs", "heads", "main"), "utf8")).toBe("abc\n");
});
