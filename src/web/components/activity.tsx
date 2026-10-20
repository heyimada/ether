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

// Three cells that answer "what is happening here?" before the file list.
export function ActivityStrip({ info, open, latest, activity }: { info: RepoInfo; open: Open; latest: Latest; activity: Activity }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const top = activity.authors.slice(0, 3);
  return (
    <section className="activity" aria-label="Activity">
      <div className="activity-cell">
        <Link to="/$owner/$repo/pulls" params={params} className="activity-head">
          <span className="activity-num">{open.pulls}</span> open {open.pulls === 1 ? "pull request" : "pull requests"}
        </Link>
        <p className="activity-detail">
          {latest.pull ? (
            <Link to="/$owner/$repo/pull/$number" params={{ ...params, number: String(latest.pull.number) }}>
              <span className="muted">#{latest.pull.number}</span> {latest.pull.title}
            </Link>
          ) : (
            <span className="muted">Nothing waiting for review</span>
          )}
        </p>
      </div>
      <div className="activity-cell">
        <span className="activity-head">
          <span className="activity-num">{activity.total}</span> {activity.total === 1 ? "commit" : "commits"} in the last 12 weeks
        </span>
        <p className="activity-detail">
          {top.length ? (
            top.map((a) => (
              <span key={a.email || a.name} className="activity-person">
                <Avatar name={a.username ?? a.name} />
                {a.name} <span className="muted num">{a.commits}</span>
              </span>
            ))
          ) : (
            <span className="muted">No commits on {info.repo.defaultBranch} lately</span>
          )}
        </p>
      </div>
      <div className="activity-cell">
        <Link to="/$owner/$repo/issues" params={params} className="activity-head">
          <span className="activity-num">{open.issues}</span> open {open.issues === 1 ? "issue" : "issues"}
        </Link>
        <p className="activity-detail">
          {latest.issue ? (
            <Link to="/$owner/$repo/issues/$number" params={{ ...params, number: String(latest.issue.number) }}>
              <span className="muted">#{latest.issue.number}</span> {latest.issue.title}
            </Link>
          ) : (
            <span className="muted">No open issues</span>
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
    <section className="side-section">
      <h3>Commits, last 12 weeks</h3>
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
      {activity.total === 0 && <p className="hint">No commits on the default branch in this window.</p>}
      <div className="spark-axis muted" aria-hidden>
        <span>{format(since, "MMM d")}</span>
        <span>This week</span>
      </div>
    </section>
  );
}

export function Contributors({ activity }: { activity: Activity }) {
  if (activity.authors.length === 0) return null;
  return (
    <section className="side-section">
      <h3>Contributors</h3>
      <motion.ul className="people" aria-label="Contributors" {...staggered}>
        {activity.authors.map((a, i) => (
          <motion.li key={a.email || a.name} variants={rise} custom={i}>
            <Avatar name={a.username ?? a.name} />
            <span className="people-name">{a.name}</span>
            <span className="muted num">{plural(a.commits, "commit")}</span>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  );
}

const fmtPercent = (p: number) => `${p.toFixed(1)}%`;
// Languages too small to see in the bar still get a legend entry; the colour is decoration.
const fallbackColor = "var(--control-border)";

// GitHub-style: one bar split by bytes, with a legend of name and share.
export function LanguageBar({ languages }: { languages: LanguageShare[] }) {
  if (languages.length === 0) return null;
  const shown = languages.slice(0, 6);
  const other = languages.slice(6).reduce((s, l) => s + l.percent, 0);
  return (
    <section className="side-section" aria-labelledby="side-languages">
      <h3 id="side-languages">Languages</h3>
      <div className="lang-bar" aria-hidden>
        {shown.map((l, i) => (
          <span key={l.name} style={{ width: `${l.percent}%`, background: l.color ?? fallbackColor, "--i": i } as CSSProperties} />
        ))}
        {other > 0 && <span style={{ width: `${other}%`, background: fallbackColor }} />}
      </div>
      <ul className="lang-legend" aria-label="Languages">
        {shown.map((l) => (
          <li key={l.name}>
            <span className="lang-dot" style={{ background: l.color ?? fallbackColor }} aria-hidden />
            <span className="lang-name">{l.name}</span> <span className="muted num">{fmtPercent(l.percent)}</span>
          </li>
        ))}
        {other > 0 && (
          <li>
            <span className="lang-dot" style={{ background: fallbackColor }} aria-hidden />
            <span className="lang-name">Other</span> <span className="muted num">{fmtPercent(other)}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

// The newest commits on the default branch, with whoever wrote them.
export function RecentCommits({ info, commits }: { info: RepoInfo; commits: AuthoredCommit[] }) {
  if (commits.length === 0) return null;
  const params = { owner: info.repo.owner, repo: info.repo.name };
  return (
    <section className="side-section" aria-labelledby="side-commits">
      <h3 id="side-commits">
        <Link to="/$owner/$repo/commits/$" params={{ ...params, _splat: info.repo.defaultBranch }} className="heading-link">
          Recent commits
        </Link>
      </h3>
      <motion.ul className="recent-commits" aria-label="Recent commits" {...staggered}>
        {commits.map((c, i) => (
          <motion.li key={c.sha} variants={rise} custom={i}>
            <Avatar name={c.username ?? c.author} size={24} />
            <div className="recent-commit-body">
              <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: c.sha }} className="recent-commit-subject">
                {c.subject}
              </Link>
              <span className="muted recent-commit-meta">
                {c.username ? (
                  <Link to="/$owner" params={{ owner: c.username }} className="recent-commit-author">
                    {c.username}
                  </Link>
                ) : (
                  <span className="recent-commit-author">{c.author}</span>
                )}{" "}
                · <span className="mono">{shortSha(c.sha)}</span> · {timeAgo(c.date)}
              </span>
            </div>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  );
}
