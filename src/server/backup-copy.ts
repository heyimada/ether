import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

type List = (dir: string) => string[];
const listDir: List = (dir) => readdirSync(dir);

const vanished = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

// The entries of dir, or null if it's gone or isn't a directory.
export function listIfPresent(dir: string, list: List = listDir): string[] | null {
  try {
    return list(dir);
  } catch (e) {
    if (vanished(e) || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

// Anything listed but gone by the time it's copied is reported to onVanished, and the copy carries on.
function copyEntry(from: string, to: string, list: List, onVanished: (path: string) => void) {
  try {
    const stat = lstatSync(from);
    if (stat.isDirectory()) copyDir(from, to, list, onVanished);
    else if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  } catch (e) {
    if (!vanished(e)) throw e;
    onVanished(from);
  }
}

function copyDir(from: string, to: string, list: List, onVanished: (path: string) => void) {
  const entries = listIfPresent(from, list);
  if (!entries) return onVanished(from);
  mkdirSync(to, { recursive: true });
  for (const name of entries) copyEntry(join(from, name), join(to, name), list, onVanished);
}

// For folders whose files don't depend on each other (avatars, release assets): a file deleted mid-backup just isn't
// in it.
export function copyTree(from: string, to: string, list: List = listDir) {
  if (listIfPresent(from, list)) copyDir(from, to, list, () => {});
}

// Git's lock, temp and quarantine files come and go during every push; losing one changes nothing in the repository.
const isGitScratch = (path: string) => {
  const name = basename(path);
  return name.endsWith(".lock") || name.startsWith("tmp_") || name.startsWith("incoming-") || name === "gc.pid" || name === "gc.log";
};

// Copies a bare repository: loose refs, then packed-refs, then the rest, then objects. While objects are only added,
// every ref in the copy points at objects copied after it. gc and pack-refs break that by deleting loose objects, old
// packs and loose refs, so when anything but git's scratch files vanishes mid-copy, the repository is copied again. One
// that never holds still for a whole copy fails the backup rather than ending up in it broken.
export function copyRepoConsistently(from: string, to: string, list: List = listDir, attempts = 3) {
  const order = (name: string) => (name === "refs" ? 0 : name === "packed-refs" ? 1 : name === "objects" ? 3 : 2);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const entries = listIfPresent(from, list);
    if (!entries) return;
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    const lost: string[] = [];
    const onVanished = (path: string) => void (isGitScratch(path) || lost.push(path));
    for (const name of entries.toSorted((a, b) => order(a) - order(b))) copyEntry(join(from, name), join(to, name), list, onVanished);
    if (!lost.length) return;
    // The repository itself was deleted while it was being copied.
    if (!listIfPresent(from, list)) return void rmSync(to, { recursive: true, force: true });
    if (attempt === attempts) throw new Error(`${from} kept changing during the backup (${lost.slice(0, 3).join(", ")} vanished); run the backup again`);
  }
}
