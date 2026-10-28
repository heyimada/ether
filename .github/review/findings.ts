import { createHash } from "node:crypto";
import type { EligibilityVerdict, Lens, LensGroup } from "./config";

export type Severity = "important" | "nit" | "preexisting";
export const SEVERITIES: Severity[] = ["important", "preexisting", "nit"];

// What a finder reports. file/line are on the RIGHT side of the PR diff.
export interface Candidate {
  file: string;
  line: number;
  lens: Lens;
  severity: Severity;
  title: string;
  failure: string;
}
export interface Finding extends Candidate {
  fingerprint: string;
}
export interface Vote {
  real: boolean;
  severity: Severity;
  duplicateOf: string | null;
  reason: string;
}

// State lives on GitHub in hidden markers, so there is no database to keep in sync.
export interface FindingMarker {
  fp: string;
  sha: string;
  lens: Lens;
  severity: Severity;
}
export type ReviewState = "done" | "errored" | "not-applicable";
export interface SummaryMarker {
  lens: LensGroup;
  round: number;
  reviewedSha: string;
  state: ReviewState;
  eligibility?: EligibilityVerdict;
}

const FINDING_TAG = "ether-review";
const SUMMARY_TAG = "ether-review-summary";
const FIXED_TAG = "ether-review-fixed";

const normalizeTitle = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Computed by us, not the model, so the same bug class in the same file always gets the same fingerprint.
export const fingerprint = (c: Pick<Candidate, "file" | "title" | "lens">) =>
  createHash("sha256").update(`${c.file}\0${normalizeTitle(c.title)}\0${c.lens}`).digest("hex").slice(0, 16);

const serialize = (tag: string, data: object) => `<!-- ${tag} ${JSON.stringify(data)} -->`;
// Only the one marker the engine appends at the very end counts; a marker anywhere else came from quoted model text.
function parse(tag: string, body: string): unknown {
  const m = body.match(new RegExp(`<!-- ${tag} (\\{[^\\n]*\\}) -->\\s*$`));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export const findingMarker = (m: FindingMarker) => serialize(FINDING_TAG, m);
export const summaryMarker = (m: SummaryMarker) => serialize(SUMMARY_TAG, m);

// On the App's "Fixed" reply. GraphQL's resolvedBy only returns users, so this is how a thread the App resolved is told
// apart from one a person resolved.
export const fixedMarker = (sha: string) => serialize(FIXED_TAG, { sha });
export const isFixedReply = (body: string) => typeof (parse(FIXED_TAG, body) as { sha?: unknown } | null)?.sha === "string";

// GitHub's compare lists at most this many files, so a list that long may be missing some.
export const COMPARE_FILE_LIMIT = 300;

// Every path a compare touched, old names of renamed files included, or null when the list can't be trusted: the old
// commit isn't an ancestor (force push) or the list may be truncated.
export function changedPaths(cmp: { status: string; files?: { filename: string; previous_filename?: string }[] }): Set<string> | null {
  if (cmp.status !== "ahead" || !cmp.files || cmp.files.length >= COMPARE_FILE_LIMIT) return null;
  return new Set(cmp.files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])));
}

// Whether a finding needs a re-check after these changes. A finding sits on one line, but its fix often lands in another
// file it names (a helper, the caller): a change to either counts. null changes means unknown, so check.
export function findingTouched(changed: Set<string> | null, file: string, body: string): boolean {
  if (!changed) return true;
  if (changed.has(file)) return true;
  return [...changed].some((p) => body.includes(p) || body.includes(p.split("/").at(-1)!));
}

export function parseFindingMarker(body: string): FindingMarker | null {
  const m = parse(FINDING_TAG, body) as Partial<FindingMarker> | null;
  if (!m || typeof m.fp !== "string" || typeof m.sha !== "string" || typeof m.lens !== "string" || !SEVERITIES.includes(m.severity as Severity)) return null;
  return m as FindingMarker;
}
export function parseSummaryMarker(body: string): SummaryMarker | null {
  const m = parse(SUMMARY_TAG, body) as Partial<SummaryMarker> | null;
  if (!m || typeof m.lens !== "string" || !Number.isInteger(m.round) || typeof m.reviewedSha !== "string" || typeof m.state !== "string") return null;
  return m as SummaryMarker;
}

// Merges the finders' candidates on exact fingerprint and drops anything already posted. Meaning-level duplicates are left to the voters.
export function dedupe(candidates: Candidate[], prior: Set<string>): Finding[] {
  const out = new Map<string, Finding>();
  for (const c of candidates) {
    const fp = fingerprint(c);
    if (!prior.has(fp) && !out.has(fp)) out.set(fp, { ...c, fingerprint: fp });
  }
  return [...out.values()];
}

export function tally(finding: Finding, votes: Vote[], needed: number): { post: boolean; severity: Severity } {
  const real = votes.filter((v) => v.real && !v.duplicateOf);
  if (real.length < needed) return { post: false, severity: finding.severity };
  const counts = new Map<Severity, number>();
  for (const v of real) counts.set(v.severity, (counts.get(v.severity) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const tied = SEVERITIES.filter((s) => counts.get(s) === top);
  return { post: true, severity: tied.includes(finding.severity) ? finding.severity : tied[0] };
}

export const bySeverity = (a: Finding, b: Finding) =>
  SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line;

// RIGHT-side line numbers a review comment can attach to. GitHub rejects the whole review if one comment is outside the hunks.
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let right = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) right = Number(hunk[1]);
    else if (line === "" || line.startsWith("-") || line.startsWith("\\")) continue;
    else if (right > 0) lines.add(right++);
  }
  return lines;
}

const TOKEN_PATTERNS = [/\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-ant-[A-Za-z0-9_-]{20,}/];

// True if the text contains any of the secrets or anything shaped like a GitHub or Anthropic token.
export function containsSecret(text: string, secrets: (string | undefined)[]): boolean {
  return secrets.some((s) => s && s.length >= 8 && text.includes(s)) || TOKEN_PATTERNS.some((p) => p.test(text));
}

// Model text comes from reading untrusted code: it must not open a marker or ping people.
export const sanitize = (text: string, max = 4000) =>
  (text.length > max ? `${text.slice(0, max)}…` : text).replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;").replace(/@(?=[A-Za-z0-9])/g, "@\u200b");

const LABEL: Record<Severity, string> = { important: "Important", preexisting: "Pre-existing", nit: "Nit" };

// The model names file and line, so both must point at a line the PR's diff shows; anything else is dropped.
export const onDiffLine = (c: Pick<Candidate, "file" | "line">, lines: Map<string, Set<number>>) =>
  Number.isInteger(c.line) && c.line > 0 && (lines.get(c.file)?.has(c.line) ?? false);

export function findingBody(f: Finding, sha: string): string {
  return `**${LABEL[f.severity]}** (${f.lens}): ${sanitize(f.title.replace(/\s+/g, " "), 200)}\n\n${sanitize(f.failure)}\n\n${findingMarker({ fp: f.fingerprint, sha, lens: f.lens, severity: f.severity })}`;
}

export interface Posted {
  marker: FindingMarker;
  title: string;
  file: string;
}

// The finding an earlier bot review comment on file carries, if any.
export function postedFinding(body: string, file: string): Posted | null {
  const marker = parseFindingMarker(body);
  if (!marker) return null;
  return { marker, title: body.match(/^\*\*[A-Za-z-]+\*\* \([a-z]+\): (.*)/)?.[1] ?? "", file };
}
