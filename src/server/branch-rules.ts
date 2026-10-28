// Pure branch protection logic, shared by the server and the pre-receive hook (which has no database).

export type BranchRule = { pattern: string; requirePullRequest: boolean; allowForcePush: boolean; allowDeletion: boolean };

const PATTERN_RE = /^[A-Za-z0-9._\-/*?]+$/;

// Why a pattern can't be used, or null when it's fine.
export function patternProblem(pattern: string): string | null {
  if (!pattern || pattern.length > 200) return "Enter a branch name or pattern, up to 200 characters";
  if (!PATTERN_RE.test(pattern)) return "Patterns may use letters, digits, . _ - / and the wildcards * ? **";
  if (pattern.startsWith("/") || pattern.endsWith("/") || pattern.includes("//")) return "Patterns can't start or end with / or contain //";
  if (pattern.startsWith("refs/")) return "Use the branch name without refs/heads/";
  return null;
}

// * matches within one path segment, ** across segments, ? one character.
export function matches(pattern: string, branch: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") (re += ".*"), i++;
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.\-/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(branch);
}

// Every matching rule applies; the strictest setting wins.
export function effectiveRule(rules: BranchRule[], branch: string): Omit<BranchRule, "pattern"> | null {
  const hits = rules.filter((r) => matches(r.pattern, branch));
  if (hits.length === 0) return null;
  return {
    requirePullRequest: hits.some((r) => r.requirePullRequest),
    allowForcePush: hits.every((r) => r.allowForcePush),
    allowDeletion: hits.every((r) => r.allowDeletion),
  };
}

export type RefUpdate = { old: string; new: string; ref: string };
const isZero = (sha: string) => /^0+$/.test(sha);

// Why an update is refused, or null. `isAncestor` asks git whether old is contained in new.
export async function refusal(rules: BranchRule[], u: RefUpdate, isAncestor: (old: string, next: string) => Promise<boolean>): Promise<string | null> {
  if (!u.ref.startsWith("refs/heads/")) return null;
  const branch = u.ref.slice("refs/heads/".length);
  const rule = effectiveRule(rules, branch);
  // Creating a branch is always allowed, so a protected repository can still receive its first push.
  if (!rule || isZero(u.old)) return null;
  if (isZero(u.new)) return rule.allowDeletion ? null : `${branch} is protected and can't be deleted`;
  if (rule.requirePullRequest) return `${branch} is protected: changes have to go through a pull request`;
  if (!rule.allowForcePush && !(await isAncestor(u.old, u.new))) return `${branch} is protected: force pushes aren't allowed`;
  return null;
}
