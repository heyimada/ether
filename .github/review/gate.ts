// Decides whether the review App would approve a pull request at its head commit, and reports it as the "Review gate"
// check run. Runs from main and never checks out the pull request's code.
//
//   bun .github/review/gate.ts --pr N [--dry-run]
//   bun .github/review/gate.ts --sha HEAD_SHA [--dry-run]    (workflow_run: finds the open PR with that head)
//
// Locally, --dry-run reads with `gh auth token` and prints the decision without posting anything.

import { parseArgs } from "node:util";
import { BOT_LOGIN, eligibility, GATE_CHECK, LENS_GROUPS, NO_AUTOMERGE_LABEL, REPORT_ONLY, REQUIRED_CHECKS, type EligibilityVerdict, type LensGroup } from "./config";
import { parseSummaryMarker, postedFindings, type SummaryMarker } from "./findings";
import { github, isBot, readToken, sameBot, type CheckRun, type Permission } from "./github";

export type CiState = "success" | "pending" | "failure";

export interface GateInput {
  headSha: string;
  author: { login: string; bot: boolean; permission: Permission };
  fork: boolean;
  draft: boolean;
  noAutomerge: boolean;
  eligibility: { eligible: boolean; reason: string };
  // The latest bot summary per lens, whatever commit it was for.
  reviews: Record<LensGroup, SummaryMarker | null>;
  openFindings: number;
  ci: CiState;
}
export interface Decision {
  wouldApprove: boolean;
  reasons: string[];
}

const TRUSTED: Permission[] = ["write", "maintain", "admin"];

export function decide(i: GateInput): Decision {
  const human: string[] = [];
  if (i.author.bot) human.push(`${i.author.login} is a bot`);
  else if (!TRUSTED.includes(i.author.permission)) human.push(`${i.author.login} has ${i.author.permission} permission, not write`);
  if (i.fork) human.push("the pull request comes from a fork");
  for (const lens of Object.keys(LENS_GROUPS) as LensGroup[]) {
    const r = i.reviews[lens];
    if (!r || r.reviewedSha !== i.headSha) human.push(`the ${lens} review hasn't finished for ${i.headSha.slice(0, 7)}`);
    else if (r.state === "errored") human.push(`the ${lens} review errored`);
  }
  if (!i.eligibility.eligible) human.push(`not eligible for auto-merge: ${i.eligibility.reason}`);

  const blocked: string[] = [];
  if (i.draft) blocked.push("the pull request is a draft");
  if (i.noAutomerge) blocked.push(`the ${NO_AUTOMERGE_LABEL} label is set`);
  if (i.openFindings) blocked.push(`${i.openFindings} review finding${i.openFindings === 1 ? " is" : "s are"} unresolved`);
  if (i.ci !== "success") blocked.push(`CI is ${i.ci === "failure" ? "failing" : "still running"}`);

  if (human.length || blocked.length) return { wouldApprove: false, reasons: [...human.map((r) => `needs human approval: ${r}`), ...blocked] };
  return { wouldApprove: true, reasons: [`${i.author.login} has ${i.author.permission} permission`, `eligible: ${i.eligibility.reason}`, "both reviews finished with no open findings", "CI passed"] };
}

// Only GitHub Actions' own runs count, and only the latest run of each required check.
export function ciState(runs: CheckRun[], required = REQUIRED_CHECKS): CiState {
  const latest = new Map<string, CheckRun>();
  for (const r of runs) if (r.app?.slug === "github-actions" && required.includes(r.name) && (latest.get(r.name)?.id ?? -1) < r.id) latest.set(r.name, r);
  const states = required.map((name) => latest.get(name));
  if (states.some((r) => r?.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion ?? ""))) return "failure";
  return states.every((r) => r?.status === "completed") ? "success" : "pending";
}

async function gate(target: { pr: number } | { sha: string }, dryRun: boolean) {
  const read = github(readToken(dryRun));
  const appToken = process.env.REVIEW_APP_TOKEN;
  if (!dryRun && !appToken) throw new Error("REVIEW_APP_TOKEN is not set");

  // workflow_run events from forks carry no pull_requests, so look the PR up by its head commit.
  const number = "pr" in target ? target.pr : (await read.openPulls()).find((p) => p.head.sha === target.sha)?.number;
  if (!number) return console.error(`no open pull request has head ${"sha" in target ? target.sha : ""}`);
  const pull = await read.pull(number);
  if (pull.state !== "open") return console.error(`#${number} is ${pull.state}`);
  const head = pull.head.sha;

  const bot = isBot(pull.user);
  const [permission, files, comments, threads, runs] = await Promise.all([
    bot ? Promise.resolve<Permission>("none") : read.permission(pull.user.login).catch(() => "none" as const),
    read.pullFiles(number),
    read.issueComments(number),
    read.threads(number),
    read.checkRuns(head),
  ]);

  const summaries = comments.filter((c) => c.user && sameBot(c.user.login, BOT_LOGIN)).map((c) => parseSummaryMarker(c.body)).filter((m) => m !== null);
  const reviews = Object.fromEntries((Object.keys(LENS_GROUPS) as LensGroup[]).map((l) => [l, summaries.find((s) => s.lens === l) ?? null])) as Record<LensGroup, SummaryMarker | null>;
  const verdict: EligibilityVerdict = reviews.bugs?.reviewedSha === head ? (reviews.bugs.eligibility ?? "missing") : "missing";
  const openFindings = threads.filter((t) => !t.isResolved && t.comment.byBot && sameBot(t.comment.login, BOT_LOGIN) && postedFindings(t.comment.body).length).length;

  const input: GateInput = {
    headSha: head,
    author: { login: pull.user.login, bot, permission },
    fork: pull.head.repo?.full_name !== pull.base.repo.full_name,
    draft: pull.draft,
    noAutomerge: pull.labels.some((l) => l.name === NO_AUTOMERGE_LABEL),
    eligibility: eligibility(files.map((f) => f.filename), verdict),
    reviews,
    openFindings,
    ci: ciState(runs),
  };
  const decision = decide(input);
  const title = decision.wouldApprove ? "Would approve" : "Needs human approval";
  const summary = [
    REPORT_ONLY ? "Report-only: the review App doesn't approve or merge yet. This shows what it would do." : "",
    decision.reasons.map((r) => `- ${r}`).join("\n"),
  ].filter(Boolean).join("\n\n");

  if (dryRun) return console.log(JSON.stringify({ pr: number, input, decision }, null, 2));

  const write = github(appToken!);
  const output = { title, summary };
  // Neutral while report-only, so a check nobody requires yet never shows as a failure.
  const conclusion = REPORT_ONLY ? "neutral" : decision.wouldApprove ? "success" : "action_required";
  const existing = runs.find((r) => r.name === GATE_CHECK && r.app && sameBot(r.app.slug, BOT_LOGIN));
  if (existing) await write.updateCheckRun(existing.id, { status: "completed", conclusion, output });
  else await write.createCheckRun({ name: GATE_CHECK, head_sha: head, status: "completed", conclusion, output });
  console.error(`#${number} at ${head.slice(0, 7)}: ${title}\n${summary}`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { pr: { type: "string" }, sha: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
  const pr = Number(values.pr);
  const sha = values.sha ?? "";
  if (!(Number.isInteger(pr) && pr > 0) && !/^[0-9a-f]{40}$/.test(sha)) {
    console.error("usage: bun .github/review/gate.ts (--pr N | --sha HEAD_SHA) [--dry-run]");
    process.exit(2);
  }
  try {
    await gate(Number.isInteger(pr) && pr > 0 ? { pr } : { sha }, values["dry-run"]!);
  } catch (e) {
    console.error(`gate failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
