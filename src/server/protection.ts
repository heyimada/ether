import { eq } from "drizzle-orm";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BranchRule } from "./branch-rules";
import { config } from "./config";
import { db } from "./db/client";
import { branchProtection } from "./db/schema";

export const branchRules = (repoId: number): BranchRule[] =>
  db
    .select({ pattern: branchProtection.pattern, requirePullRequest: branchProtection.requirePullRequest, allowForcePush: branchProtection.allowForcePush, allowDeletion: branchProtection.allowDeletion })
    .from(branchProtection)
    .where(eq(branchProtection.repoId, repoId))
    .all();

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// A hooks folder holding only Ether's pre-receive. Written on first use, so it follows this Bun and checkout.
let hooksDir: string | null = null;
function ensureHooks(): string {
  if (hooksDir) return hooksDir;
  const dir = join(config.dataDir, "hooks");
  mkdirSync(dir, { recursive: true });
  const script = resolve(import.meta.dirname, "hooks/pre-receive.ts");
  const hook = join(dir, "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)}\n`);
  chmodSync(hook, 0o755);
  hooksDir = dir;
  return dir;
}

// Extra `git` arguments and environment for receive-pack into a repository, so its branch rules
// are enforced the same way over HTTPS and SSH. Unprotected repositories get no hook at all.
export function receivePackGuard(repoId: number): { args: string[]; env: Record<string, string> } {
  const rules = branchRules(repoId);
  if (rules.length === 0) return { args: [], env: {} };
  return { args: ["-c", `core.hooksPath=${ensureHooks()}`], env: { ETHER_BRANCH_RULES: JSON.stringify(rules) } };
}
