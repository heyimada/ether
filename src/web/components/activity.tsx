import { Link } from "@tanstack/react-router";
import { addDays, format } from "date-fns";
import { api, repoApi, type Issue, type RepoInfo } from "../lib/api";
import { Avatar } from "./ui";

export type Activity = { since: number | null; weeks: number[]; total: number; authors: { name: string; email: string; commits: number }[] };

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
                <Avatar name={a.name} />
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
              <span className="spark-bar" style={{ height: `${n === 0 ? 0 : Math.max(8, (n / max) * 100)}%` }} aria-hidden />
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
      <ul className="people" aria-label="Contributors">
        {activity.authors.map((a) => (
          <li key={a.email || a.name}>
            <Avatar name={a.name} />
            <span className="people-name">{a.name}</span>
            <span className="muted num">{plural(a.commits, "commit")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
