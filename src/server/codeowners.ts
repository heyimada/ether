// CODEOWNERS, as on GitHub: each line is a path pattern and the owners of the files it matches, and the
// last line that matches a file decides. Pure, so it can be tested without a database.
import { globMatch } from "./branch-rules";

// Where the file is looked for, in order; the first one that exists counts.
export const CODEOWNERS_PATHS = [".ether/CODEOWNERS", ".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

// GitHub ignores a CODEOWNERS file over 3 MB; Ether reads much less, since every pull request matches against it.
export const MAX_CODEOWNERS_BYTES = 256 * 1024;
const MAX_RULES = 2000;
const MAX_PATTERN = 512;
const MAX_OWNERS = 50;

// An owner is a user (`@name`) or an organization's team (`@org/team`).
export type Owner = { kind: "user"; name: string } | { kind: "team"; org: string; team: string };
export type Rule = { line: number; pattern: string; owners: Owner[]; globs: string[] };
export type Problem = { line: number; message: string };
export type CodeOwners = { rules: Rule[]; problems: Problem[] };

const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,38})$/i;

export const ownerText = (o: Owner) => (o.kind === "user" ? `@${o.name}` : `@${o.org}/${o.team}`);

function parseOwner(raw: string): Owner | string {
  if (!raw.startsWith("@")) return raw.includes("@") ? `${raw}: owners by email aren't supported; use @username` : `${raw}: owners start with @`;
  const parts = raw.slice(1).split("/");
  if (parts.length === 1 && NAME.test(parts[0])) return { kind: "user", name: parts[0].toLowerCase() };
  if (parts.length === 2 && NAME.test(parts[0]) && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(parts[1])) return { kind: "team", org: parts[0].toLowerCase(), team: parts[1].toLowerCase() };
  return `${raw} isn't a username or @org/team`;
}

// The globs (for globMatch with `dirs`) a pattern stands for. As in .gitignore: a pattern with no / but at its
// end matches at any depth, a leading / anchors it to the root, a trailing / only matches what's inside a
// directory, and a pattern that names a directory owns everything in it.
function globsFor(pattern: string): string[] | string {
  if (pattern.startsWith("!")) return `${pattern}: negated patterns aren't supported in CODEOWNERS`;
  if (/[[\]]/.test(pattern)) return `${pattern}: character ranges aren't supported in CODEOWNERS`;
  if (pattern.includes("\\")) return `${pattern}: escapes aren't supported`;
  const dirOnly = pattern.endsWith("/");
  let p = pattern.replace(/\/+$/, "");
  if (!p) return [`**`];
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\/+/, "");
  if (!p) return [`**`];
  const base = anchored || p.startsWith("**") ? p : `**/${p}`;
  if (dirOnly) return [`${base}/**`];
  // A wildcard in the last segment stays at that level, as GitHub documents: docs/* doesn't own docs/a/b.md.
  return p.split("/").pop()!.includes("*") ? [base] : [base, `${base}/**`];
}

export function parseCodeOwners(text: string): CodeOwners {
  const rules: Rule[] = [];
  const problems: Problem[] = [];
  if (text.length > MAX_CODEOWNERS_BYTES) return { rules, problems: [{ line: 0, message: `CODEOWNERS is larger than ${MAX_CODEOWNERS_BYTES / 1024} KiB and is ignored` }] };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    // A # starts a comment unless it's escaped; Ether doesn't take escapes, so it always does.
    const content = lines[i].replace(/(^|\s)#.*$/, "").trim();
    if (!content) continue;
    if (rules.length >= MAX_RULES) {
      problems.push({ line, message: `Only the first ${MAX_RULES} rules are read` });
      break;
    }
    const [pattern, ...rest] = content.split(/\s+/);
    if (pattern.length > MAX_PATTERN) {
      problems.push({ line, message: `Patterns can be up to ${MAX_PATTERN} characters` });
      continue;
    }
    const globs = globsFor(pattern);
    if (typeof globs === "string") {
      problems.push({ line, message: globs });
      continue;
    }
    const owners: Owner[] = [];
    let bad = false;
    for (const raw of rest.slice(0, MAX_OWNERS)) {
      const o = parseOwner(raw);
      if (typeof o === "string") (bad = true), problems.push({ line, message: o });
      else if (!owners.some((x) => ownerText(x) === ownerText(o))) owners.push(o);
    }
    // As on GitHub, a line with a mistake is skipped as a whole, rather than taking ownership away from earlier lines.
    if (bad) continue;
    if (rest.length > MAX_OWNERS) problems.push({ line, message: `Only the first ${MAX_OWNERS} owners of a line are read` });
    // A pattern with no owners is allowed: it takes ownership away from earlier lines.
    rules.push({ line, pattern, owners, globs });
  }
  return { rules, problems };
}

// Matching costs about pattern length × path length; past this much work for one pull request the owners are
// reported as unknown rather than stalling the server.
export const MAX_OWNER_WORK = 50_000_000;

// The rule that decides a path's owners, or null when none matches (or the rule clears ownership).
export function ruleFor(co: CodeOwners, path: string, budget = { left: MAX_OWNER_WORK }): Rule | null | "too-much" {
  for (let i = co.rules.length - 1; i >= 0; i--) {
    const r = co.rules[i];
    for (const g of r.globs) {
      budget.left -= (g.length + 1) * (path.length + 1);
      if (budget.left < 0) return "too-much";
      if (globMatch(g, path, { dirs: true })) return r.owners.length ? r : null;
    }
  }
  return null;
}

export function ownersFor(co: CodeOwners, path: string): Owner[] {
  const r = ruleFor(co, path);
  return r && r !== "too-much" ? r.owners : [];
}

// Each changed file with owners, by the rule that owns it. `null` when matching ran out of budget.
export function ownedFiles(co: CodeOwners, files: string[]): Map<Rule, string[]> | null {
  const budget = { left: MAX_OWNER_WORK };
  const out = new Map<Rule, string[]>();
  for (const f of files) {
    const r = ruleFor(co, f, budget);
    if (r === "too-much") return null;
    if (r) out.set(r, [...(out.get(r) ?? []), f]);
  }
  return out;
}
