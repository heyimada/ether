import { Link } from "@tanstack/react-router";
import { addDays, format } from "date-fns";
import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { api, repoApi, shortSha, timeAgo, type Commit, type Issue, type RepoInfo } from "../lib/api";
import { rise, staggered } from "../lib/motion";
import { Avatar } from "./ui";

export type Activity = { since: number | null; weeks: number[]; total: number; authors: { name: string; email: string; commits: number; username: string | null }[] };
export type LanguageShare = { name: string; color: string | null; bytes: number; percent: number };
export type AuthoredCommit = Commit & { username: string | null };

export const loadLanguages = (info: RepoInfo) => api<{ languages: LanguageShare[] }>(`${repoApi(info.repo.owner, info.repo.name)}/languages`).then((r) => r.languages);
export const loadRecentCommits = (info: RepoInfo) =>
  api<{ commits: AuthoredCommit[] }>(`${repoApi(info.repo.owner, info.repo.name)}/commits?${new URLSearchParams({ ref: info.repo.defaultBranch, limit: "5" })}`).then((r) => r.commits);

export const loadActivity = (info: RepoInfo) => api<Activity>(`${repoApi(info.repo.owner, info.repo.name)}/activity`);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Open = { issues: number; pulls: number };
type Latest = { issue: Issue | null; pull: Issue | null };

const CELL = "min-w-0 border-l border-border px-4 py-3.5 first:border-l-0 max-md:border-l-0 max-md:border-t max-md:first:border-t-0";
const HEAD = "block font-semibold text-fg";
// The figure lights up when its link is hovered.
const NUM = "mr-0.5 text-3xl font-bold tracking-tighter tabular-nums group-hover/head:text-link";
const DETAIL = "m-0 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm wrap-anywhere";

// Three cells that answer "what is happening here?" before the file list.
export function ActivityStrip({ info, open, latest, activity }: { info: RepoInfo; open: Open; latest: Latest; activity: Activity }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const top = activity.authors.slice(0, 3);
  return (
    <section className="grid grid-cols-3 max-md:grid-cols-[1fr] rounded-md border border-border bg-surface shadow-card" aria-label="Activity">
      <div className={CELL}>
        <Link to="/$owner/$repo/pulls" params={params} className={`${HEAD} group/head hover:no-underline`}>
          <span className={NUM}>{open.pulls}</span> open {open.pulls === 1 ? "pull request" : "pull requests"}
        </Link>
        <p className={DETAIL}>
          {latest.pull ? (
            <Link to="/$owner/$repo/pull/$number" params={{ ...params, number: String(latest.pull.number) }} className="text-fg">
              <span className="text-muted">#{latest.pull.number}</span> {latest.pull.title}
            </Link>
          ) : (
            <span className="text-muted">Nothing waiting for review</span>
          )}
        </p>
      </div>
      <div className={CELL}>
        <span className={HEAD}>
          <span className={NUM}>{activity.total}</span> {activity.total === 1 ? "commit" : "commits"} in the last 12 weeks
        </span>
        <p className={DETAIL}>
          {top.length ? (
            top.map((a) => (
              <span key={a.email || a.name} className="inline-flex items-center gap-1.5">
                <Avatar name={a.username ?? a.name} />
                {a.name} <span className="text-muted tabular-nums">{a.commits}</span>
              </span>
            ))
          ) : (
            <span className="text-muted">No commits on {info.repo.defaultBranch} lately</span>
          )}
        </p>
      </div>
      <div className={CELL}>
        <Link to="/$owner/$repo/issues" params={params} className={`${HEAD} group/head hover:no-underline`}>
          <span className={NUM}>{open.issues}</span> open {open.issues === 1 ? "issue" : "issues"}
        </Link>
        <p className={DETAIL}>
          {latest.issue ? (
            <Link to="/$owner/$repo/issues/$number" params={{ ...params, number: String(latest.issue.number) }} className="text-fg">
              <span className="text-muted">#{latest.issue.number}</span> {latest.issue.title}
            </Link>
          ) : (
            <span className="text-muted">No open issues</span>
          )}
        </p>
      </div>
    </section>
  );
}

// Weekly commit bars on a zero-based scale. Each bar is a list item so the counts are
// readable without the chart.
export function CommitSparkline({ activity }: { activity: Activity }) {
  if (activity.since === null) return null;
  const max = Math.max(1, ...activity.weeks);
  const since = activity.since;
  return (
    <section>
      <h3 className="m-0 mb-2 text-base">Commits, last 12 weeks</h3>
      <ol className="spark" aria-label="Commits per week">
        {activity.weeks.map((n, i) => {
          const label = `Week of ${format(addDays(since, i * 7), "MMM d")}: ${plural(n, "commit")}`;
          return (
            <li key={i} title={label}>
              <span className="spark-bar" style={{ height: `${n === 0 ? 0 : Math.max(8, (n / max) * 100)}%`, "--i": i } as CSSProperties} aria-hidden />
              <span className="sr-only">{label}</span>
            </li>
          );
        })}
      </ol>
      {activity.total === 0 && <p className="hint mt-2">No commits on the default branch in this window.</p>}
      <div className="flex justify-between mt-1 text-xs text-muted" aria-hidden>
        <span>{format(since, "MMM d")}</span>
        <span>This week</span>
      </div>
    </section>
  );
}

export function Contributors({ activity }: { activity: Activity }) {
  if (activity.authors.length === 0) return null;
  return (
    <section>
      <h3 className="m-0 mb-2 text-base">Contributors</h3>
      <motion.ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Contributors" {...staggered}>
        {activity.authors.map((a, i) => (
          <motion.li key={a.email || a.name} variants={rise} custom={i} className="flex items-center gap-2 text-sm">
            <Avatar name={a.username ?? a.name} />
            <span className="min-w-0 flex-1 wrap-anywhere">{a.name}</span>
            <span className="text-muted tabular-nums">{plural(a.commits, "commit")}</span>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  );
}

const fmtPercent = (p: number) => `${p.toFixed(1)}%`;
// Languages too small to see in the bar still get a legend entry; the colour is decoration.
const fallbackColor = "var(--control-border)";
const LANG_SEGMENT = "block min-w-[2px] origin-left animate-[bar-grow-x_420ms_var(--ease-out)_calc(var(--i,0)*50ms)_backwards]";
const LANG_DOT = "inline-block size-2.5 flex-none rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--text)_15%,transparent)]";

// GitHub-style: one bar split by bytes, with a legend of name and share.
export function LanguageBar({ languages }: { languages: LanguageShare[] }) {
  if (languages.length === 0) return null;
  const shown = languages.slice(0, 6);
  const other = languages.slice(6).reduce((s, l) => s + l.percent, 0);
  return (
    <section aria-labelledby="side-languages">
      <h3 id="side-languages" className="m-0 mb-2 text-base">
        Languages
      </h3>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        {shown.map((l, i) => (
          <span key={l.name} className={LANG_SEGMENT} style={{ width: `${l.percent}%`, background: l.color ?? fallbackColor, "--i": i } as CSSProperties} />
        ))}
        {other > 0 && <span className={LANG_SEGMENT} style={{ width: `${other}%`, background: fallbackColor }} />}
      </div>
      <ul className="m-0 mt-2.5 flex list-none flex-wrap gap-x-3.5 gap-y-1.5 p-0 text-sm" aria-label="Languages">
        {shown.map((l) => (
          <li key={l.name} className="inline-flex items-center gap-1.5">
            <span className={LANG_DOT} style={{ background: l.color ?? fallbackColor }} aria-hidden />
            <span className="font-semibold">{l.name}</span> <span className="text-muted tabular-nums">{fmtPercent(l.percent)}</span>
          </li>
        ))}
        {other > 0 && (
          <li className="inline-flex items-center gap-1.5">
            <span className={LANG_DOT} style={{ background: fallbackColor }} aria-hidden />
            <span className="font-semibold">Other</span> <span className="text-muted tabular-nums">{fmtPercent(other)}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

const COMMIT_AUTHOR = "font-semibold text-fg";

// The newest commits on the default branch, with whoever wrote them.
export function RecentCommits({ info, commits }: { info: RepoInfo; commits: AuthoredCommit[] }) {
  if (commits.length === 0) return null;
  const params = { owner: info.repo.owner, repo: info.repo.name };
  return (
    <section aria-labelledby="side-commits">
      <h3 id="side-commits" className="m-0 mb-2 text-base">
        <Link to="/$owner/$repo/commits/$" params={{ ...params, _splat: info.repo.defaultBranch }} className="text-fg">
          Recent commits
        </Link>
      </h3>
      <motion.ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Recent commits" {...staggered}>
        {commits.map((c, i) => (
          <motion.li key={c.sha} variants={rise} custom={i} className="flex min-w-0 items-start gap-2">
            <Avatar name={c.username ?? c.author} size={24} />
            <div className="flex min-w-0 flex-col text-sm">
              <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: c.sha }} className="font-medium text-fg wrap-anywhere">
                {c.subject}
              </Link>
              <span className="text-xs text-muted wrap-anywhere">
                {c.username ? (
                  <Link to="/$owner" params={{ owner: c.username }} className={COMMIT_AUTHOR}>
                    {c.username}
                  </Link>
                ) : (
                  <span className={COMMIT_AUTHOR}>{c.author}</span>
                )}{" "}
                · <span className="font-mono">{shortSha(c.sha)}</span> · {timeAgo(c.date)}
              </span>
            </div>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  );
}
