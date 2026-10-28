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

// * matches within one path segment, ** across segments, ? one character. Case is ignored: on a
// case-insensitive disk RELEASE/1.0 is the same ref as release/1.0, so a rule must cover both spellings.
export function matches(pattern: string, branch: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") (re += ".*"), i++;
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.\-/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(branch);
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

export type PushContext = {
  // Whether old is contained in new, asked of git.
  isAncestor: (old: string, next: string) => Promise<boolean>;
  // The repository's branch names right now.
  branches: () => Promise<string[]>;
  // Ether has never seen a branch in this repository, so nothing created now can be a deleted one coming back.
  freshRepo: boolean;
};

// Why an update is refused, or null.
export async function refusal(rules: BranchRule[], u: RefUpdate, ctx: PushContext): Promise<string | null> {
  if (!u.ref.startsWith("refs/heads/")) return null;
  const branch = u.ref.slice("refs/heads/".length);
  // On a case-insensitive disk refs/heads/MAIN is the file of refs/heads/main, so a name that isn't a
  // branch itself but differs from one only in case would write that branch, whether git calls it a
  // creation or (with a forged old value) an update. Where both spellings really exist, as a
  // case-sensitive disk allows, each is its own branch and may be changed.
  const branches = await ctx.branches();
  const lower = branch.toLowerCase();
  const clash = branches.includes(branch) ? undefined : branches.find((b) => b.toLowerCase() === lower);
  if (clash) return `${branch} differs from the existing branch ${clash} only in case`;

  const rule = effectiveRule(rules, branch);
  if (!rule) return null;
  if (isZero(u.old)) {
    // Creating a branch is allowed, except where it could bring back a deleted branch that requires pull requests.
    if (rule.requirePullRequest && rule.allowDeletion && !ctx.freshRepo)
      return `${branch} is protected: it requires pull requests and may be deleted, so it can't be created by a push`;
    return null;
  }
  if (isZero(u.new)) return rule.allowDeletion ? null : `${branch} is protected and can't be deleted`;
  if (rule.requirePullRequest) return `${branch} is protected: changes have to go through a pull request`;
  if (!rule.allowForcePush && !(await ctx.isAncestor(u.old, u.new))) return `${branch} is protected: force pushes aren't allowed`;
  return null;
}
