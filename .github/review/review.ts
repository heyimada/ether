// Reviews one pull request through one lens group and posts the verified findings as a single review.
//
//   bun .github/review/review.ts --pr N --lens bugs|security [--dry-run]
//
// In CI, review.yml checks the PR head out into pr/. To try it locally against your Claude login without posting anything
// (reads use `gh auth token`):
//
//   git fetch origin pull/2/head && git worktree add --detach pr FETCH_HEAD && find pr -type l -delete
//   bun .github/review/review.ts --pr 2 --lens bugs --dry-run
//   git worktree remove --force pr

import { parseArgs } from "node:util";
import { classifyEligibility, findSymlink, isFixed, runFinder, runVoter, type Context } from "./agents";
import { BOT_LOGIN, DEPTH, isSensitive, LENS_GROUPS, PR_DIR, REPORT_ONLY, ROUND_CAP, type EligibilityVerdict, type LensGroup } from "./config";
import {
  bySeverity,
  commentableLines,
  containsSecret,
  dedupe,
  findingBody,
  parseSummaryMarker,
  postedFindings,
  sanitize,
  summaryMarker,
  tally,
  type Finding,
  type Posted,
  type ReviewState,
} from "./findings";
import { github, readToken, sameBot, type GitHub, type PullFile, type ReviewComment } from "./github";

const DIFF_BUDGET = 150_000;
const ELIGIBILITY_DIFF_BUDGET = 60_000;

function renderDiff(files: PullFile[], budget: number): string {
  let out = "";
  const skipped: string[] = [];
  for (const f of files) {
    const chunk = `--- ${f.filename} (${f.status})\n${f.patch ?? "(no textual diff)"}\n`;
    if (out.length + chunk.length > budget) skipped.push(f.filename);
    else out += chunk;
  }
  return skipped.length ? `${out}\nToo large to include; read these files yourself:\n${skipped.join("\n")}` : out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (sha: string) => sha.slice(0, 7);

async function review(prNumber: number, group: LensGroup, dryRun: boolean) {
  const read = github(readToken(dryRun));
  const appToken = process.env.REVIEW_APP_TOKEN;
  if (!dryRun && !appToken) throw new Error("REVIEW_APP_TOKEN is not set");
  const write: GitHub | null = dryRun ? null : github(appToken!);
  const secrets = [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.GITHUB_TOKEN, appToken];
  const guard = (text: string) => {
    if (containsSecret(text, secrets)) throw new Error("refusing to post: outgoing text contains a token");
    return text;
  };
  const log = (msg: string) => console.error(`[${group}] ${msg}`);

  const pull = await read.pull(prNumber);
  const head = pull.head.sha;
  const checkedOut = Bun.spawnSync(["git", "-C", PR_DIR, "rev-parse", "HEAD"]).stdout.toString().trim();
  if (checkedOut !== head) throw new Error(`${PR_DIR}/ is at ${checkedOut || "nothing"}, but the pull request head is ${head}`);

  const [comments, threads, reviews, files] = await Promise.all([read.issueComments(prNumber), read.threads(prNumber), read.reviews(prNumber), read.pullFiles(prNumber)]);
  const lenses: readonly string[] = LENS_GROUPS[group];
  const summaryComment = comments.find((c) => c.user && sameBot(c.user.login, BOT_LOGIN) && parseSummaryMarker(c.body)?.lens === group);
  const prev = summaryComment ? parseSummaryMarker(summaryComment.body) : null;
  if (prev && prev.reviewedSha === head && prev.state !== "errored" && !dryRun) return log(`already reviewed ${short(head)}`);
  const round = !prev ? 1 : prev.reviewedSha === head ? prev.round : prev.round + 1;

  const botThreads = threads
    .filter((t) => t.comment.byBot && sameBot(t.comment.login, BOT_LOGIN))
    .flatMap((t) => postedFindings(t.comment.body, t.comment.path).map((p) => ({ thread: t, posted: p })))
    .filter((t) => lenses.includes(t.posted.marker.lens));
  const inBodies = reviews.filter((r) => r.user && sameBot(r.user.login, BOT_LOGIN)).flatMap((r) => postedFindings(r.body));
  const prior: Posted[] = [...botThreads.map((t) => t.posted), ...inBodies.filter((p) => lenses.includes(p.marker.lens))];
  const errors: string[] = [];
  // The path hook can't see what a glob matches, so a symlink anywhere in the checkout stops the agents (review.yml deletes them first).
  const symlink = findSymlink(PR_DIR);
  if (symlink) errors.push(`${symlink} is a symlink; refusing to run agents over this checkout`);
  let costUsd = 0;
  const spend = <T extends { costUsd: number }>(r: T) => ((costUsd += r.costUsd), r);

  // Threads whose finding is fixed at this head get a short reply and are resolved.
  const resolved: { file: string; title: string; reason: string }[] = [];
  const stale = symlink ? [] : botThreads.filter((t) => !t.thread.isResolved && t.posted.marker.sha !== head);
  await Promise.all(
    stale.map(async ({ thread, posted }) => {
      const res = spend(await isFixed({ file: posted.file, line: thread.comment.line, title: posted.title, failure: thread.comment.body }, PR_DIR));
      if (!res.ok) return void errors.push(`isFixed ${posted.file}: ${res.error}`);
      if (!res.value.fixed) return;
      resolved.push({ file: posted.file, title: posted.title, reason: res.value.reason });
      if (!write) return;
      await write.reply(prNumber, thread.comment.databaseId, guard(`Fixed as of ${short(head)}: ${sanitize(res.value.reason, 1000)}`));
      await write.resolveThread(thread.id);
    }),
  );

  // Rounds before the cap see the whole PR; from the cap on, only what changed since the last reviewed commit.
  let scope = files;
  let sinceSha: string | null = null;
  if (round >= ROUND_CAP && prev && prev.reviewedSha !== head) {
    const cmp = await read.compare(prev.reviewedSha, head).catch(() => null);
    // After a force push the old SHA is no longer an ancestor, so fall back to the full diff.
    if (cmp?.status === "ahead" && cmp.files) (scope = cmp.files), (sinceSha = prev.reviewedSha);
  }
  const reviewable = scope.filter((f) => f.patch && f.status !== "removed");
  const ctx: Context = {
    pr: prNumber,
    title: pull.title,
    body: pull.body ?? "",
    diff: renderDiff(reviewable, DIFF_BUDGET),
    sinceSha,
    prior: prior.map((p) => ({ fingerprint: p.marker.fp, file: p.file, lens: p.marker.lens, title: p.title })),
    cwd: PR_DIR,
  };

  // The gate reads this verdict from the bugs summary; a change on a sensitive path is never eligible, so don't ask.
  const eligibilityRun: Promise<EligibilityVerdict | undefined> =
    group !== "bugs" ? Promise.resolve(undefined)
    : symlink ? Promise.resolve("errored")
    : files.some((f) => isSensitive(f.filename)) ? Promise.resolve("missing")
    : classifyEligibility({ ...ctx, diff: renderDiff(files, ELIGIBILITY_DIFF_BUDGET), sinceSha: null }).then((r) => {
        spend(r);
        if (!r.ok) return errors.push(`eligibility: ${r.error}`), "errored";
        return r.value.risk;
      });

  let posted: Finding[] = [];
  let candidates = 0;
  if (reviewable.length && !symlink) {
    const found = await Promise.all(Array.from({ length: DEPTH.finders }, () => runFinder(group, ctx).then(spend)));
    for (const r of found) if (!r.ok) errors.push(`finder: ${r.error}`);
    const all = found.flatMap((r) => (r.ok ? r.value : []));
    candidates = all.length;
    const findings = dedupe(all, new Set(prior.map((p) => p.marker.fp)));
    log(`${plural(all.length, "candidate")}, ${findings.length} after exact dedupe`);

    const patches = new Map(files.map((f) => [f.filename, f.patch ?? ""]));
    const voted = await Promise.all(
      findings.map(async (f, i) => {
        const voterCtx = { ...ctx, diff: renderDiff([{ filename: f.file, status: "modified", patch: patches.get(f.file) || "(not changed by this pull request)" }], DIFF_BUDGET) };
        const votes = await Promise.all(Array.from({ length: DEPTH.voters }, () => runVoter(f, findings.slice(0, i), voterCtx).then(spend)));
        for (const v of votes) if (!v.ok) errors.push(`voter ${f.fingerprint}: ${v.error}`);
        const result = tally(f, votes.flatMap((v) => (v.ok ? [v.value] : [])), DEPTH.votesToPost);
        return result.post ? { ...f, severity: result.severity } : null;
      }),
    );
    posted = voted.filter((f) => f !== null).filter((f) => round <= ROUND_CAP || f.severity === "important").sort(bySeverity);
  }
  const eligibility = await eligibilityRun;
  const state: ReviewState = errors.length ? "errored" : reviewable.length ? "done" : "not-applicable";

  const lines = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]));
  const inline = posted.filter((f) => lines.get(f.file)?.has(f.line));
  const outside = posted.filter((f) => !inline.includes(f));
  const comments_: ReviewComment[] = inline.map((f) => ({ path: f.file, line: f.line, side: "RIGHT", body: guard(findingBody(f, head)) }));
  const reviewBody = guard(
    [
      `Automated ${group} review, round ${round} at ${short(head)}${sinceSha ? ` (changes since ${short(sinceSha)})` : ""}.`,
      outside.length ? `These findings are outside the diff, so they can't be inline comments:\n\n${outside.map((f) => findingBody(f, head, true)).join("\n\n---\n\n")}` : "",
    ].filter(Boolean).join("\n\n"),
  );
  const counts = (["important", "preexisting", "nit"] as const).map((s) => [s, posted.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  const summary = guard(
    [
      `### Automated review: ${group}`,
      `Round ${round} at ${short(head)}: ${posted.length ? `${plural(posted.length, "finding")} (${counts.map(([s, n]) => `${n} ${s}`).join(", ")})` : "no findings"}.` +
        (resolved.length ? ` ${plural(resolved.length, "earlier finding")} resolved as fixed.` : ""),
      state === "errored" ? "Part of the review failed, so this commit needs a human review. The workflow log has the details." : "",
      state === "not-applicable" ? "Nothing to review in this commit." : "",
      round > ROUND_CAP ? `This pull request is past ${ROUND_CAP} review rounds, so only important findings are posted now. If findings keep coming, consider a different approach.` : "",
      "Answer each finding: fix it, or resolve the thread with a reason.",
      REPORT_ONLY ? "Report-only: this review doesn't approve or block merging yet." : "",
      summaryMarker({ lens: group, round, reviewedSha: head, state, ...(eligibility ? { eligibility } : {}) }),
    ].filter(Boolean).join("\n\n"),
  );

  for (const e of errors) log(`error: ${e}`);
  log(`done: ${posted.length} posted, ${resolved.length} resolved, $${costUsd.toFixed(2)}`);

  if (!write) {
    console.log(
      JSON.stringify(
        { pr: prNumber, lens: group, head, round, state, sinceSha, scopeFiles: reviewable.length, candidates, eligibility, resolved, findings: posted, inline: inline.length, inBody: outside.length, errors, costUsd: Number(costUsd.toFixed(4)) },
        null,
        2,
      ),
    );
    return;
  }
  if (posted.length) await write.createReview(prNumber, { commit_id: head, body: reviewBody, comments: comments_ });
  if (summaryComment) await write.updateIssueComment(summaryComment.id, summary);
  else await write.createIssueComment(prNumber, summary);
  if (state === "errored") console.log(`::warning::The ${group} review errored; see the log above.`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { pr: { type: "string" }, lens: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
  const pr = Number(values.pr);
  const lens = values.lens as LensGroup;
  if (!Number.isInteger(pr) || pr <= 0 || !(lens in LENS_GROUPS)) {
    console.error("usage: bun .github/review/review.ts --pr N --lens bugs|security [--dry-run]");
    process.exit(2);
  }
  try {
    await review(pr, lens, values["dry-run"]!);
  } catch (e) {
    console.error(`[${lens}] failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
