import { and, eq } from "drizzle-orm";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BranchRule } from "./branch-rules";
import { config } from "./config";
import { db } from "./db/client";
import { branchProtection, event } from "./db/schema";

export const branchRules = (repoId: number): BranchRule[] =>
  db
    .select({ pattern: branchProtection.pattern, requirePullRequest: branchProtection.requirePullRequest, allowForcePush: branchProtection.allowForcePush, allowDeletion: branchProtection.allowDeletion })
    .from(branchProtection)
    .where(eq(branchProtection.repoId, repoId))
    .all();

// Thrown when the hook can't be relied on; the push is refused rather than let through unchecked.
export class ProtectionUnavailable extends Error {}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// git ignores a hook that is missing or not executable with nothing but a hint, which would turn
// protection off silently. So every protected push rewrites the hook if it changed, checks it can be
// executed, and has it actually run once per process (that catches a noexec data folder).
let proven: string | null = null;
function hooksDir(): string {
  const dir = join(config.dataDir, "hooks");
  const hook = join(dir, "update");
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(resolve(import.meta.dirname, "hooks/update.ts"))} "$@"\n`;
  try {
    mkdirSync(dir, { recursive: true });
    let current: string | null = null;
    try {
      current = readFileSync(hook, "utf8");
    } catch {}
    if (current !== script) writeFileSync(hook, script);
    chmodSync(hook, 0o755);
    // From before protection used the update hook.
    rmSync(join(dir, "pre-receive"), { force: true });
    if (process.platform !== "win32") accessSync(hook, constants.X_OK);
    if (proven !== script) {
      const run = spawnSync(process.platform === "win32" ? "sh" : hook, process.platform === "win32" ? [hook, "--check"] : ["--check"], { timeout: 30_000 });
      if (run.status !== 0) throw new Error(run.error?.message ?? `exited ${run.status}`);
      proven = script;
    }
  } catch (e) {
    proven = null;
    console.error(`Branch protection hook unusable at ${hook}: ${(e as Error).message}`);
    throw new ProtectionUnavailable("Branch protection can't run on this server right now, so the push was refused. An admin can find the reason in Ether's log.");
  }
  return dir;
}

export type Guard = { args: string[]; env: Record<string, string> };

// Extra `git` arguments and environment for receive-pack into a repository, so its branch rules are
// enforced the same way over HTTPS and SSH. Unprotected repositories get no hook at all.
// Throws ProtectionUnavailable when the rules exist but can't be enforced.
export function receivePackGuard(repoId: number, hasBranches: boolean): Guard {
  const rules = branchRules(repoId);
  if (rules.length === 0) return { args: [], env: {} };
  const pushedBefore = !!db.select({ id: event.id }).from(event).where(and(eq(event.repoId, repoId), eq(event.kind, "push"))).get();
  return {
    args: ["-c", `core.hooksPath=${hooksDir()}`],
    env: { ETHER_BRANCH_RULES: JSON.stringify(rules), ETHER_FRESH_REPO: !hasBranches && !pushedBefore ? "1" : "0" },
  };
}
