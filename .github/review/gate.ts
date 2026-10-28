// Decides whether the review App would approve a pull request at its head commit, and reports it as the "Review gate"
// check run. Runs from main and never checks out the pull request's code.
//
//   bun .github/review/gate.ts --pr N [--dry-run]
//   bun .github/review/gate.ts --sha HEAD_SHA [--dry-run]    (workflow_run: finds the open PR with that head)
//
// Locally, --dry-run reads with `gh auth token` and prints the decision without posting anything.

import { parseArgs } from "node:util";
import { BOT_LOGIN, eligibility, GATE_CHECK, hidesDiff, LENS_GROUPS, NO_AUTOMERGE_LABEL, REPORT_ONLY, REQUIRED_CHECKS, type EligibilityVerdict, type LensGroup } from "./config";
import { parseSummaryMarker, postedFinding, type SummaryMarker } from "./findings";
import { github, isBot, isReviewBot, readToken, resolvedAsFixed, sameBot, type CheckRun, type Permission } from "./github";

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
  // Resolved by a person instead of by the App after a fix. Fine for merging, but a human has to approve it.
  dismissedFindings: number;
  // People whose latest review asks for changes. Their objection always wins over the App.
  changesRequestedBy: string[];
  ci: CiState;
}
export interface Decision {
  wouldApprove: boolean;
  // approved; waiting: only things still in progress stand in the way; blocked: the author has something to do; human:
  // the App won't approve this, a person has to.
  status: "approved" | "waiting" | "blocked" | "human";
  reasons: string[];
}

const TRUSTED: Permission[] = ["write", "maintain", "admin"];

export function decide(i: GateInput): Decision {
  const human: string[] = [];
  if (i.author.bot) human.push(`${i.author.login} is a bot`);
  else if (!TRUSTED.includes(i.author.permission)) human.push(`${i.author.login} has ${i.author.permission} permission, not write`);
  if (i.fork) human.push("the pull request comes from a fork");
  const pending: string[] = [];
  for (const lens of Object.keys(LENS_GROUPS) as LensGroup[]) {
    const r = i.reviews[lens];
    if (!r || r.reviewedSha !== i.headSha) pending.push(`the ${lens} review hasn't finished for ${i.headSha.slice(0, 7)}`);
    else if (r.state === "errored") human.push(`the ${lens} review errored`);
  }
  if (i.changesRequestedBy.length) human.push(`${i.changesRequestedBy.join(", ")} requested changes`);
  if (i.dismissedFindings) human.push(`${i.dismissedFindings} finding${i.dismissedFindings === 1 ? " was" : "s were"} resolved without the review confirming a fix`);
  if (!i.eligibility.eligible) human.push(`not eligible for auto-merge: ${i.eligibility.reason}`);

  const blocked: string[] = [];
  if (i.draft) blocked.push("the pull request is a draft");
  if (i.noAutomerge) blocked.push(`the ${NO_AUTOMERGE_LABEL} label is set`);
  if (i.openFindings) blocked.push(`${i.openFindings} review finding${i.openFindings === 1 ? " is" : "s are"} unresolved`);
  if (i.ci === "failure") blocked.push("CI is failing");
  if (i.ci === "pending") pending.push("CI is still running");

  const status = human.length ? "human" : blocked.length ? "blocked" : pending.length ? "waiting" : "approved";
  if (status !== "approved") return { wouldApprove: false, status, reasons: [...human.map((r) => `needs human approval: ${r}`), ...blocked, ...pending] };
  return { wouldApprove: true, status, reasons: [`${i.author.login} has ${i.author.permission} permission`, `eligible: ${i.eligibility.reason}`, "both reviews finished with no open findings", "CI passed"] };
}

// Each person's latest review that approves, requests changes or was dismissed; comments don't change the verdict.
export function changesRequested(reviews: { user: { login: string; type: string } | null; state: string }[]): string[] {
  const latest = new Map<string, string>();
  for (const r of reviews) if (r.user && r.user.type !== "Bot" && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user.login, r.state);
  return [...latest].filter(([, s]) => s === "CHANGES_REQUESTED").map(([login]) => login);
}

// The App's requests for changes, once no finding is open. A push doesn't dismiss them the way it does approvals.
export function staleChangeRequests(reviews: { id: number; user: { login: string; type: string } | null; state: string }[], openFindings: number, botLogin: string): number[] {
  if (openFindings) return [];
  return reviews.filter((r) => isReviewBot(r.user, botLogin) && r.state === "CHANGES_REQUESTED").map((r) => r.id);
}

// Every path a change touches, with the old name of a moved file, so moving a sensitive file out counts as touching it.
// null when GitHub's list is shorter than the pull request (it stops at 3000 files), so nothing can be ruled out.
export function touchedPaths(files: { filename: string; previous_filename?: string }[], changedFiles: number): string[] | null {
  if (files.length < changedFiles) return null;
  return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
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
  // Reviews before threads: the App posts a review and its finding threads in one call, so every change request read
  // here already has its threads, and staleChangeRequests can't dismiss one whose finding is still open.
  const prReviews = await read.reviews(number);
  const [permission, files, comments, threads, runs] = await Promise.all([
    // Through the App token, the path verified to work; a failed lookup fails the job instead of reading as "none".
    bot ? Promise.resolve<Permission>("none") : (dryRun ? read : github(appToken!)).permission(pull.user.login),
    read.pullFiles(number),
    read.issueComments(number),
    read.threads(number),
    read.checkRuns(head),
  ]);

  const summaries = comments.filter((c) => isReviewBot(c.user, BOT_LOGIN)).map((c) => parseSummaryMarker(c.body)).filter((m) => m !== null);
  const reviews = Object.fromEntries((Object.keys(LENS_GROUPS) as LensGroup[]).map((l) => [l, summaries.find((s) => s.lens === l) ?? null])) as Record<LensGroup, SummaryMarker | null>;
  const verdict: EligibilityVerdict = reviews.bugs?.reviewedSha === head ? (reviews.bugs.eligibility ?? "missing") : "missing";
  const findingThreads = threads.filter((t) => t.comment.byBot && sameBot(t.comment.login, BOT_LOGIN) && postedFinding(t.comment.body, t.comment.path));
  const openFindings = findingThreads.filter((t) => !t.isResolved).length;
  const dismissedFindings = findingThreads.filter((t) => t.isResolved && !resolvedAsFixed(t, BOT_LOGIN)).length;

  const input: GateInput = {
    headSha: head,
    author: { login: pull.user.login, bot, permission },
    fork: pull.head.repo?.full_name !== pull.base.repo.full_name,
    draft: pull.draft,
    noAutomerge: pull.labels.some((l) => l.name === NO_AUTOMERGE_LABEL),
    eligibility: ((paths) => (paths ? eligibility(paths, verdict, files.filter(hidesDiff).map((f) => f.filename)) : { eligible: false, reason: `GitHub listed ${files.length} of ${pull.changed_files} changed files` }))(touchedPaths(files, pull.changed_files)),
    reviews,
    openFindings,
    dismissedFindings,
    changesRequestedBy: changesRequested(prReviews),
    ci: ciState(runs),
  };
  const decision = decide(input);
  const title = { approved: REPORT_ONLY ? "Would approve" : "Approved", waiting: "Waiting for reviews or CI", blocked: "Blocked", human: "Needs human approval" }[decision.status];
  const summary = [
    REPORT_ONLY ? "Report-only: the review App doesn't approve or merge yet. This shows what it would do." : "",
    decision.reasons.map((r) => `- ${r}`).join("\n"),
  ].filter(Boolean).join("\n\n");

  if (dryRun) return console.log(JSON.stringify({ pr: number, input, decision }, null, 2));

  const write = github(appToken!);
  const output = { title, summary };
  // Never a failure: a pull request the App won't approve still merges with a person's approval.
  const conclusion = !REPORT_ONLY && decision.wouldApprove ? "success" : "neutral";
  const existing = runs.find((r) => r.name === GATE_CHECK && r.app && sameBot(r.app.slug, BOT_LOGIN));
  // Without it, "Details" links to the App's homepage instead of the run that made the decision.
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
  const details_url = server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : undefined;
  if (existing) await write.updateCheckRun(existing.id, { status: "completed", conclusion, details_url, output });
  else await write.createCheckRun({ name: GATE_CHECK, head_sha: head, status: "completed", conclusion, details_url, output });
  // File names come from the pull request and git allows newlines in them; a line starting with "::" would run a
  // workflow command in a job that holds the App's token.
  console.error(`#${number} at ${head.slice(0, 7)}: ${title}: ${decision.reasons.join("; ").replace(/[\r\n]+/g, " ")}`);
  // Before the report-only return: the App's own request for changes would otherwise block the merge for good.
  for (const id of staleChangeRequests(prReviews, openFindings, BOT_LOGIN)) await write.dismissReview(number, id, `Every review finding is resolved as of ${head.slice(0, 7)}.`);
  if (REPORT_ONLY) return;

  // The App's approval stands in for the human one only when decide() says so, and covers just this head commit:
  // branch protection dismisses it on the next push. When the decision flips on the same commit (a label, a dismissed
  // finding), the approval and the auto-merge the App enabled are withdrawn.
  const appApprovals = prReviews.filter((r) => isReviewBot(r.user, BOT_LOGIN) && r.state === "APPROVED");
  const appEnabledAutoMerge = !!pull.auto_merge?.enabled_by && isReviewBot(pull.auto_merge.enabled_by, BOT_LOGIN);
  if (!decision.wouldApprove) {
    for (const r of appApprovals) await write.dismissReview(number, r.id, `The review gate no longer approves ${head.slice(0, 7)}. See the Review gate check.`);
    if (appEnabledAutoMerge) await write.disableAutoMerge(pull.node_id);
    return;
  }
  if (!appApprovals.some((r) => r.commit_id === head)) await write.approve(number, head, `Approved by the review gate at ${head.slice(0, 7)}:\n\n${decision.reasons.map((r) => `- ${r}`).join("\n")}`);
  if (pull.auto_merge) return;
  // decide() waits for green CI, so the pull request can usually merge right away. If GitHub isn't ready yet (405: the
  // approval or a check is still being counted; 409: the head moved), auto-merge takes over, pinned to this commit.
  try {
    await write.merge(number, head);
    console.error(`#${number}: merged ${head.slice(0, 7)}`);
  } catch (e) {
    if (!/: 40[59] /.test((e as Error).message)) throw e;
    await write.enableAutoMerge(pull.node_id, head);
    console.error(`#${number}: auto-merge enabled for ${head.slice(0, 7)}`);
  }
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
    console.error(`gate failed: ${(e as Error).message.replace(/[\r\n]+/g, " ")}`);
    process.exit(1);
  }
}
