// Settings for the automated review (review.ts) and the merge gate (gate.ts).

export const MODEL = "claude-opus-5-5";

// Report-only: the App posts findings and a neutral "Review gate" check, but never approves or enables auto-merge.
export const REPORT_ONLY = false;

// Quick depth: each lens group gets 2 independent finders, and each candidate finding 2 voters. Post only if both say real.
export const DEPTH = { finders: 2, voters: 2, votesToPost: 2 };

// From this round on, only commits since the last reviewed SHA are reviewed. After it, only important findings are posted.
export const ROUND_CAP = 3;

// Parallel query() calls per process; each lens job is its own process.
export const concurrency = (raw: string | undefined) => (raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 3);
export const CONCURRENCY = concurrency(process.env.REVIEW_CONCURRENCY);

export const MAX_TURNS = { finder: 60, voter: 30, isFixed: 20, eligibility: 30 };

export const LENS_GROUPS = {
  bugs: ["correctness", "lifecycle", "contracts"],
  security: ["security"],
} as const;
export type LensGroup = keyof typeof LENS_GROUPS;
export type Lens = (typeof LENS_GROUPS)[LensGroup][number];

// Changes that touch only these paths can be auto-merged unless the eligibility check escalates them. Tests aren't
// here: a change that weakens an assertion looks harmless and isn't, so the eligibility check has to rate it.
export const LOW_RISK = ["**/*.md", "LICENSE", "design/**"];

// Always need a human, whatever the eligibility check says. Keep in sync with .github/CODEOWNERS. Agent instruction and
// config files are here because they steer every agent that works on the repo, like a system prompt.
export const SENSITIVE = [
  ".github/**",
  "claude.md",
  "agents.md",
  "gemini.md",
  "**/claude.md",
  "**/claude.local.md",
  "**/agents.md",
  "**/gemini.md",
  ".claude/**",
  "**/.claude/**",
  ".mcp.json",
  "**/.mcp.json",
  ".cursor/**",
  "**/.cursor/**",
  "**/.cursorrules",
  "src/server/ci-container.ts",
  "src/server/ci-secrets.ts",
  "src/server/secret-box.ts",
  "src/server/log-mask.ts",
  "src/server/access.ts",
  "src/server/auth.ts",
  "src/server/auth-plugins.ts",
  "src/server/ssh.ts",
  "src/server/ssh-relay.ts",
  "src/server/smart-http.ts",
  "src/server/git.ts",
  "src/server/db/**",
  "drizzle/**",
  "package.json",
  "bun.lock",
  "cli/Cargo.*",
];

// The required CI checks from branch protection, all run by GitHub Actions.
export const REQUIRED_CHECKS = ["Build and typecheck", "CLI (Rust)", "End-to-end tests"];

export const GATE_CHECK = "Review gate";
export const NO_AUTOMERGE_LABEL = "no-automerge";

export const REPO = process.env.GITHUB_REPOSITORY ?? "heyimada/ether";
// Markers are only trusted on comments by this login, so nobody else can plant "already reported" or "reviewed" state.
export const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN || "ether-review[bot]";
// The PR head is checked out here; agents can't read anything outside it.
export const PR_DIR = process.env.REVIEW_PR_DIR ?? "pr";

const matches = (globs: string[], path: string) => globs.some((g) => new Bun.Glob(g).match(path));
// Case-insensitive, so CLAUDE.md, Claude.md and claude.md all count.
const SENSITIVE_LOWER = SENSITIVE.map((g) => g.toLowerCase());
export const isSensitive = (path: string) => matches(SENSITIVE_LOWER, path.toLowerCase());
export const isLowRisk = (path: string) => matches(LOW_RISK, path);

// GitHub sends no patch for a binary file, a rename without changes, or a text diff too large to show. Only the last
// hides code from every agent, so such a change never rests on the model's verdict.
const BINARY = ["**/*.{png,jpg,jpeg,gif,webp,avif,ico,woff,woff2,ttf,otf,pdf,zip,gz}"];
export const hidesDiff = (f: { filename: string; status: string; patch?: string; changes?: number }) =>
  !f.patch && !(f.status === "renamed" && f.changes === 0) && !matches(BINARY, f.filename.toLowerCase());

export type EligibilityVerdict = "low" | "not-low" | "errored" | "missing";

// The path rules win over the model: a sensitive path is never eligible, and the model can only escalate an allowlisted
// change. Code outside the allowlist needs the model's "low", and a diff no agent saw (hidden) can't get one.
export function eligibility(paths: string[], verdict: EligibilityVerdict, hidden: string[]): { eligible: boolean; reason: string } {
  const sensitive = paths.filter(isSensitive);
  if (sensitive.length) return { eligible: false, reason: `touches sensitive paths: ${sensitive.slice(0, 5).join(", ")}${sensitive.length > 5 ? ", …" : ""}` };
  if (paths.length === 0) return { eligible: false, reason: "no changed files" };
  if (verdict === "not-low") return { eligible: false, reason: "the eligibility check rated the change above low risk" };
  if (paths.every(isLowRisk)) return { eligible: true, reason: "only low-risk paths" };
  if (hidden.length) return { eligible: false, reason: `GitHub shows no diff for ${hidden.slice(0, 5).join(", ")}${hidden.length > 5 ? ", …" : ""}, so no review saw it` };
  if (verdict === "low") return { eligible: true, reason: "the eligibility check rated the change low risk" };
  return { eligible: false, reason: verdict === "errored" ? "the eligibility check errored" : "no eligibility check for this commit" };
}
