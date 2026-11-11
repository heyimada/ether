import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "./git";

const me = { name: "merger", email: "merger@example.invalid" };
const author = { name: "author", email: "author@example.invalid" };

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: "dev@example.invalid", GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: "dev@example.invalid" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

// main: base; feature: two commits on a.txt; main moves on with b.txt.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ether-merge-"));
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "base");
  sh(dir, "checkout", "-q", "-b", "feature");
  for (const n of [2, 3]) {
    writeFileSync(join(dir, "a.txt"), `${n}\n`);
    sh(dir, "commit", "-qam", `a${n}`);
  }
  sh(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), "b\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "b");
  return dir;
}

// Ether's git helpers take the git directory, as for its bare repositories.
const gd = (dir: string) => join(dir, ".git");
const subjects = (dir: string, rev: string) => sh(dir, "log", "--format=%s", rev).split("\n");

test("squash makes one commit by the author on top of base, with all of head's changes", async () => {
  const dir = repo();
  const r = await git.mergeBranches(gd(dir), "main", "feature", "Feature (#1)\n\n* a2\n* a3", me, undefined, { method: "squash", author });
  expect(r.ok).toBe(true);
  expect(subjects(dir, "main")).toEqual(["Feature (#1)", "b", "base"]);
  expect(sh(dir, "log", "-1", "--format=%an|%cn|%P", "main").split("|")[0]).toBe("author");
  expect(sh(dir, "log", "-1", "--format=%cn", "main")).toBe("merger");
  expect(sh(dir, "log", "-1", "--format=%P", "main").split(" ")).toHaveLength(1);
  expect(sh(dir, "show", "main:a.txt")).toBe("3");
  expect(sh(dir, "show", "main:b.txt")).toBe("b");
});

test("rebase makes each commit again on top of base, keeping authors and messages", async () => {
  const dir = repo();
  const r = await git.mergeBranches(gd(dir), "main", "feature", "", me, undefined, { method: "rebase" });
  expect(r.ok).toBe(true);
  expect(subjects(dir, "main")).toEqual(["a3", "a2", "b", "base"]);
  expect(sh(dir, "log", "-1", "--format=%an|%cn", "main")).toBe("dev|merger");
  expect(sh(dir, "show", "main:a.txt")).toBe("3");
  // The head branch itself is left alone.
  expect(subjects(dir, "feature")).toEqual(["a3", "a2", "base"]);
});

test("rebase refuses merge commits and conflicts; merge still makes a merge commit", async () => {
  const dir = repo();
  sh(dir, "checkout", "-q", "feature");
  sh(dir, "merge", "-q", "--no-edit", "main");
  sh(dir, "checkout", "-q", "main");
  expect(await git.mergeBranches(gd(dir), "main", "feature", "", me, undefined, { method: "rebase" })).toEqual({ ok: false, reason: "merges" });

  const clash = repo();
  writeFileSync(join(clash, "a.txt"), "other\n");
  sh(clash, "commit", "-qam", "clash");
  expect(await git.mergeBranches(gd(clash), "main", "feature", "", me, undefined, { method: "rebase" })).toEqual({ ok: false, reason: "conflict" });

  const plain = repo();
  expect((await git.mergeBranches(gd(plain), "main", "feature", "Merge", me)).ok).toBe(true);
  expect(sh(plain, "log", "-1", "--format=%P", "main").split(" ")).toHaveLength(2);
});

test("restack moves a branch's own commits onto a new base", async () => {
  const dir = repo();
  // upper builds on feature with one commit of its own.
  sh(dir, "checkout", "-q", "-b", "upper", "feature");
  writeFileSync(join(dir, "c.txt"), "c\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "c");
  sh(dir, "checkout", "-q", "main");
  const featureTip = sh(dir, "rev-parse", "feature");
  const squashed = await git.mergeBranches(gd(dir), "main", "feature", "Feature", me, undefined, { method: "squash", author });
  if (!squashed.ok) throw new Error("squash failed");
  const moved = await git.restack(gd(dir), "upper", featureTip, squashed.sha, me);
  expect(moved.ok).toBe(true);
  expect(subjects(dir, "upper")).toEqual(["c", "Feature", "b", "base"]);
  // Only c is left between main and upper: the squashed changes aren't shown twice.
  expect(sh(dir, "diff", "--name-only", "main...upper")).toBe("c.txt");
});
