import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { AtSign, CircleX, Eye, GitMerge, MessageSquare, UserPlus, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { ErrorNote, StateIcon, useAction } from "../components/ui";
import { api, patch, post, timeAgo } from "../lib/api";
import { requireAccount } from "../lib/require-account";

export type Notification = {
  id: number;
  owner: string;
  repo: string;
  issueNumber: number | null;
  runId: number | null;
  isPull: boolean;
  state: "open" | "closed" | "merged" | null;
  reason: "review_requested" | "mention" | "review" | "comment" | "assigned" | "merged" | "closed" | "ci_failed";
  actor: string | null;
  title: string;
  excerpt: string;
  at: string;
  read: boolean;
};
type Inbox = { notifications: Notification[]; unread: number; next: string | null };

const REASON: Record<Notification["reason"], { text: string; icon: LucideIcon }> = {
  review_requested: { text: "asked for your review", icon: Eye },
  mention: { text: "mentioned you", icon: AtSign },
  review: { text: "reviewed", icon: Eye },
  comment: { text: "commented", icon: MessageSquare },
  assigned: { text: "assigned you", icon: UserPlus },
  merged: { text: "merged", icon: GitMerge },
  closed: { text: "closed", icon: CircleX },
  ci_failed: { text: "Your run failed", icon: CircleX },
};

export const Route = createFileRoute("/_authed/notifications")({
  validateSearch: (s: Record<string, unknown>): { filter?: "all" } => ({ filter: s.filter === "all" ? "all" : undefined }),
  beforeLoad: ({ context, location }) => requireAccount(context.me, location.href),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => api<Inbox>(`/api/me/notifications${deps.filter ? "?filter=all" : ""}`),
  component: Notifications,
});

function Notifications() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const { filter } = Route.useSearch();
  const [more, setMore] = useState<Notification[]>([]);
  const [next, setNext] = useState(data.next);
  const items = [...data.notifications, ...more.filter((m) => !data.notifications.some((n) => n.id === m.id))];
  const readAll = useAction(async () => {
    await post("/api/me/notifications/read");
    setMore([]);
    await router.invalidate();
  });
  const setRead = useAction(async (n: Notification, read: boolean) => {
    await patch(`/api/me/notifications/${n.id}`, { read });
    setMore((m) => m.map((x) => (x.id === n.id ? { ...x, read } : x)));
    await router.invalidate();
  });
  const loadMore = useAction(async () => {
    const page = await api<Inbox>(`/api/me/notifications?${new URLSearchParams({ ...(filter ? { filter } : {}), before: next ?? "" })}`);
    setMore((m) => [...m, ...page.notifications]);
    setNext(page.next);
  });

  return (
    <main className="page max-w-[900px] stack-md">
      <h1 className="m-0">Notifications</h1>
      <section className="card">
        <header>
          <Link to="/notifications" search={{}} className={!filter ? "active" : "text-muted"}>
            Unread<span className="count">{data.unread}</span>
          </Link>
          <Link to="/notifications" search={{ filter: "all" }} className={filter ? "active" : "text-muted"}>
            All
          </Link>
          <span className="flex-1" />
          {data.unread > 0 && (
            <button className="small" onClick={() => readAll.run()} disabled={readAll.pending}>
              Mark all as read
            </button>
          )}
        </header>
        <ErrorNote error={readAll.error ?? setRead.error ?? loadMore.error} />
        {items.length === 0 ? (
          <p className="empty">{filter ? "Nothing has happened yet that concerns you." : "You're all caught up."}</p>
        ) : (
          <ul className="list" aria-label="Notifications">
            {items.map((n) => (
              <Row key={n.id} n={n} onRead={(read) => setRead.run(n, read)} />
            ))}
          </ul>
        )}
      </section>
      {next && (
        <button onClick={() => loadMore.run()} disabled={loadMore.pending}>
          Load more
        </button>
      )}
    </main>
  );
}

function Row({ n, onRead }: { n: Notification; onRead: (read: boolean) => void }) {
  const Icon = REASON[n.reason].icon;
  const params = { owner: n.owner, repo: n.repo };
  const what = n.reason === "ci_failed" ? REASON.ci_failed.text : `${n.actor ?? "Someone"} ${REASON[n.reason].text}`;
  const link =
    n.runId !== null ? (
      <Link to="/$owner/$repo/ci/$id" params={{ ...params, id: String(n.runId) }} onClick={() => !n.read && onRead(true)} className="font-semibold">
        {n.title}
      </Link>
    ) : (
      <Link
        to={n.isPull ? "/$owner/$repo/pull/$number" : "/$owner/$repo/issues/$number"}
        params={{ ...params, number: String(n.issueNumber) }}
        onClick={() => !n.read && onRead(true)}
        className="font-semibold"
      >
        {n.title}
      </Link>
    );
  return (
    <li className={n.read ? "opacity-70" : ""} aria-label={`${n.read ? "Read" : "Unread"}: ${n.title}`}>
      {n.state ? <StateIcon state={n.state} isPull={n.isPull} /> : <Icon size={16} aria-hidden className="shrink-0 text-danger" />}
      <div className="min-w-0 flex-1">
        <div className="text-muted text-sm">
          {n.owner}/{n.repo}
          {n.issueNumber !== null && ` #${n.issueNumber}`}
        </div>
        {link}
        <div className="text-muted">
          <Icon size={14} aria-hidden className="inline align-[-2px]" /> {what} · {timeAgo(n.at)}
          {n.excerpt && <span className="block truncate">{n.excerpt}</span>}
        </div>
      </div>
      {!n.read && <span className="size-2 shrink-0 rounded-full bg-accent" aria-hidden />}
      <button className="ghost small" onClick={() => onRead(!n.read)}>
        {n.read ? "Mark unread" : "Mark read"}
      </button>
    </li>
  );
}
