import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";

type List = (dir: string) => string[];
const listDir: List = (dir) => readdirSync(dir);

// A backup runs while the server keeps serving: git deletes its lock and temp files when a push or repack finishes, and
// a repository can be deleted. Anything gone by the time it's copied is skipped.
const vanished = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

function copyEntry(from: string, to: string, list: List) {
  try {
    const stat = lstatSync(from);
    if (stat.isDirectory()) copyTree(from, to, list);
    else if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  } catch (e) {
    if (!vanished(e)) throw e;
  }
}

// The entries of dir, or null if it's gone or isn't a directory.
export function listIfPresent(dir: string, list: List = listDir): string[] | null {
  try {
    return list(dir);
  } catch (e) {
    if (vanished(e) || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

export function copyTree(from: string, to: string, list: List = listDir) {
  const entries = listIfPresent(from, list);
  if (!entries) return;
  mkdirSync(to, { recursive: true });
  for (const name of entries) copyEntry(join(from, name), join(to, name), list);
}

// Copies a bare repository refs-first. Objects are only ever added, so every ref in the copy points at objects that are
// copied after it, even if a push lands mid-copy.
export function copyRepoConsistently(from: string, to: string, list: List = listDir) {
  const entries = listIfPresent(from, list);
  if (!entries) return;
  mkdirSync(to, { recursive: true });
  for (const name of entries) if (name !== "objects") copyEntry(join(from, name), join(to, name), list);
  if (entries.includes("objects")) copyEntry(join(from, "objects"), join(to, "objects"), list);
}
