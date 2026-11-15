import { Link } from "@tanstack/react-router";
import { format, isToday, isYesterday, startOfDay } from "date-fns";
import {
  BookOpen,
  BookPlus,
  CircleCheck,
  CircleDot,
  CircleX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
  Star,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { plural, shortSha, timeAgo } from "../lib/format";
import { rise, staggered } from "../lib/motion";
import type { Kind, Payloads } from "../../server/events";
import { Avatar } from "./ui";

// Dates arrive as strings, so `at` differs from the server's FeedEvent.
export type FeedEvent<K extends Kind = Kind> = {
  [P in K]: { id: number; kind: P; owner: string; repo: string; visibility: "private" | "public"; actor: string; at: string; payload: Payloads[P] };
}[K];

export type FeedPage = { events: FeedEvent[]; next: string | null };

const ICONS: Record<FeedEvent["kind"], LucideIcon> = {
  create: BookPlus,
  push: GitCommitHorizontal,
  issue_opened: CircleDot,
  issue_closed: CircleCheck,
  issue_reopened: CircleDot,
  pull_opened: GitPullRequest,
  pull_closed: GitPullRequestClosed,
  pull_reopened: GitPullRequest,
  pull_merged: GitMerge,
  comment: MessageSquare,
  review: CircleCheck,
  release: Tag,
  star: Star,
  wiki: BookOpen,
  ci_failed: CircleX,
};

const TONE: Partial<Record<FeedEvent["kind"], string>> = {
  issue_opened: "text-open",
  issue_reopened: "text-open",
  pull_opened: "text-open",
  pull_reopened: "text-open",
  issue_closed: "text-merged",
  pull_closed: "text-closed",
  pull_merged: "text-merged",
  ci_failed: "text-danger",
  star: "text-star",
};

const FEED_REF = "rounded-full bg-accent-soft px-1.5 py-px text-xs text-fg";
const FEED_OBJECT = "font-medium";
const DETAIL = "m-0 flex min-w-0 flex-col gap-1";
const INLINE_DETAIL = "m-0 flex min-w-0 flex-row flex-wrap items-center gap-1.5 text-sm";
const QUOTE = "m-0 min-w-0 border-l-[3px] border-border px-2.5 py-1.5 text-sm text-muted wrap-anywhere line-clamp-3";

type IssueKind = "issue_opened" | "issue_closed" | "issue_reopened" | "pull_opened" | "pull_closed" | "pull_reopened" | "pull_merged" | "comment" | "review";

function RepoLink({ e }: { e: FeedEvent }) {
  return (
    <Link to="/$owner/$repo" params={{ owner: e.owner, repo: e.repo }} className="font-semibold text-fg">
      {e.owner}/{e.repo}
    </Link>
  );
}

function IssueLink({ e }: { e: FeedEvent<IssueKind> }) {
  const isPull = e.kind.startsWith("pull_") || e.kind === "review" || (e.kind === "comment" && e.payload.isPull);
  const params = { owner: e.owner, repo: e.repo, number: String(e.payload.number) };
  const text = (
    <>
      {e.payload.title} <span className="text-muted">#{e.payload.number}</span>
    </>
  );
  return isPull ? (
    <Link to="/$owner/$repo/pull/$number" params={params} className={FEED_OBJECT}>
      {text}
    </Link>
  ) : (
    <Link to="/$owner/$repo/issues/$number" params={params} className={FEED_OBJECT}>
      {text}
    </Link>
  );
}

const REVIEW_VERB = { approved: "approved", changes_requested: "requested changes on", commented: "reviewed" } as Record<string, string>;

function sentence(e: FeedEvent): ReactNode {
  const who = (
    <Link to="/$owner" params={{ owner: e.actor }} className="font-bold text-fg">
      {e.actor}
    </Link>
  );
  const inRepo = (
    <>
      {" "}
      in <RepoLink e={e} />
    </>
  );
  switch (e.kind) {
    case "create":
      return (
        <>
          {who} created repository <RepoLink e={e} />
        </>
      );
    case "push":
      return e.payload.commits === 0 && e.payload.created ? (
        <>
          {who} created branch <code className={FEED_REF}>{e.payload.ref}</code>
          {inRepo}
        </>
      ) : (
        <>
          {who} pushed {plural(e.payload.commits, "commit")} to <code className={FEED_REF}>{e.payload.ref}</code>
          {inRepo}
        </>
      );
    case "issue_opened":
    case "issue_closed":
    case "issue_reopened":
      return (
        <>
          {who} {e.kind.slice(6)} issue <IssueLink e={e} />
          {inRepo}
        </>
      );
    case "pull_opened":
    case "pull_closed":
    case "pull_reopened":
    case "pull_merged":
      return (
        <>
          {who} {e.kind.slice(5)} pull request <IssueLink e={e} />
          {inRepo}
        </>
      );
    case "comment":
      return (
        <>
          {who} commented on <IssueLink e={e} />
          {inRepo}
        </>
      );
    case "review":
      return (
        <>
          {who} {REVIEW_VERB[e.payload.state] ?? "reviewed"} <IssueLink e={e} />
          {inRepo}
        </>
      );
    case "release":
      return (
        <>
          {who} published release{" "}
          <Link to="/$owner/$repo/releases/tag/$tag" params={{ owner: e.owner, repo: e.repo, tag: e.payload.tag }} className={FEED_OBJECT}>
            {e.payload.title}
          </Link>
          {inRepo}
        </>
      );
    case "star":
      return (
        <>
          {who} starred <RepoLink e={e} />
        </>
      );
    case "wiki":
      return (
        <>
          {who} {e.payload.created ? "created" : "edited"} wiki page{" "}
          <Link to="/$owner/$repo/wiki/$slug" params={{ owner: e.owner, repo: e.repo, slug: e.payload.slug }} className={FEED_OBJECT}>
            {e.payload.title}
          </Link>
          {inRepo}
        </>
      );
    case "ci_failed":
      return (
        <>
          Checks failed on <code className={FEED_REF}>{e.payload.ref}</code>
          {inRepo}
        </>
      );
  }
}

const SHOWN = 3;

function Detail({ e }: { e: FeedEvent }) {
  const params = { owner: e.owner, repo: e.repo };
  if (e.kind === "push" && e.payload.shown?.length) {
    const more = e.payload.commits - Math.min(SHOWN, e.payload.shown.length);
    return (
      <div className={DETAIL}>
        <ul className="m-0 flex list-none flex-col gap-1 rounded-sm border border-border bg-surface-2 px-2.5 py-2 text-sm" aria-label="Commits">
          {e.payload.shown.slice(0, SHOWN).map((c) => (
            <li key={c.sha} className="flex min-w-0 items-baseline gap-2.5">
              <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: c.sha }} className="flex-none font-mono text-xs">
                {shortSha(c.sha)}
              </Link>
              <span className="min-w-0 truncate">{c.subject}</span>
            </li>
          ))}
        </ul>
        {more > 0 && (
          <Link to="/$owner/$repo/commits/$" params={{ ...params, _splat: e.payload.ref }} className="text-xs">
            {plural(more, "more commit")}
          </Link>
        )}
      </div>
    );
  }
  if (e.kind === "comment" && e.payload.excerpt) return <p className={QUOTE}>{e.payload.excerpt}</p>;
  if (e.kind === "release" && e.payload.tag)
    return (
      <p className={INLINE_DETAIL}>
        <Tag size={14} aria-hidden className="text-muted" /> <span className="font-mono">{e.payload.tag}</span>
        {e.payload.prerelease && <span className="pill">Pre-release</span>}
      </p>
    );
  if (e.kind === "ci_failed")
    return (
      <p className={INLINE_DETAIL}>
        <CircleX size={14} aria-hidden className="text-danger" />
        <Link to="/$owner/$repo/ci/$id" params={{ ...params, id: String(e.payload.runId) }}>
          {e.payload.subject || shortSha(e.payload.sha)}
        </Link>
        <span className="font-mono text-muted">{shortSha(e.payload.sha)}</span>
      </p>
    );
  return null;
}

export function EventItem({ e, i, avatar = true }: { e: FeedEvent; i: number; avatar?: boolean }) {
  const Icon = e.kind === "push" && e.payload.commits === 0 ? GitBranch : ICONS[e.kind];
  const tone = TONE[e.kind] ?? "text-muted";
  // Feed rows are divided list items. On profiles and organizations the rows hang off a rail of beads instead.
  return (
    <motion.li className={avatar ? `flex items-start gap-3 px-4 py-3${i > 0 ? " border-t border-border" : ""}` : undefined} variants={rise} custom={i}>
      {avatar ? (
        <span className="relative flex-none">
          <Avatar name={e.actor} size={32} />
          <span className={`absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full border border-border bg-surface ${tone}`}>
            <Icon size={12} aria-hidden />
          </span>
        </span>
      ) : (
        <Icon size={16} aria-hidden className={`box-content flex-none rounded-full border border-border bg-surface p-1 ${e.kind === "star" ? "" : tone}`} />
      )}
      <div className={`flex min-w-0 flex-1 flex-col ${avatar ? "gap-1.5" : "gap-1 pt-0.5"}`}>
        <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 wrap-anywhere">
          <span className="min-w-0 flex-[1_1_260px]">{sentence(e)}</span>
          <time className="whitespace-nowrap text-xs text-muted" dateTime={e.at} title={format(new Date(e.at), "PPpp")}>
            {timeAgo(e.at)}
          </time>
        </p>
        <Detail e={e} />
      </div>
    </motion.li>
  );
}

const dayLabel = (d: Date) => (isToday(d) ? "Today" : isYesterday(d) ? "Yesterday" : format(d, d.getFullYear() === new Date().getFullYear() ? "EEEE, MMMM d" : "MMMM d, yyyy"));

export function Feed({ initial, empty }: { initial: FeedPage; empty: ReactNode }) {
  const [events, setEvents] = useState(initial.events);
  const [next, setNext] = useState(initial.next);
  const [loading, setLoading] = useState(false);
  const more = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const page = await api<FeedPage>(`/api/feed?${new URLSearchParams({ before: next })}`);
      setEvents((prev) => [...prev, ...page.events]);
      setNext(page.next);
    } finally {
      setLoading(false);
    }
  };
  if (events.length === 0) return <p className="empty card">{empty}</p>;
  const days: { key: number; label: string; items: FeedEvent[] }[] = [];
  for (const e of events) {
    const key = startOfDay(new Date(e.at)).getTime();
    const last = days.at(-1);
    if (last?.key === key) last.items.push(e);
    else days.push({ key, label: dayLabel(new Date(e.at)), items: [e] });
  }
  return (
    <div className="flex flex-col gap-5">
      {days.map((d) => (
        <section key={d.key} className="flex flex-col gap-2" aria-label={d.label}>
          <h3 className="m-0 text-xs font-bold tracking-wider uppercase text-muted">{d.label}</h3>
          <motion.ol className="m-0 list-none rounded-md border border-border bg-surface p-0 shadow-card" {...staggered}>
            {d.items.map((e, i) => (
              <EventItem key={e.id} e={e} i={i} />
            ))}
          </motion.ol>
        </section>
      ))}
      {next && (
        <button type="button" className="self-center" onClick={more} disabled={loading}>
          {loading ? "Loading…" : "Show older activity"}
        </button>
      )}
    </div>
  );
}
