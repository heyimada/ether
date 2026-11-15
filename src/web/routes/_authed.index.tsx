import { Link, createFileRoute } from "@tanstack/react-router";
import { BookLock, Building2, Globe, Plus, Search, Star } from "lucide-react";
import { motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { CiBadge, type CiStatus } from "../components/ci";
import { Feed, type FeedPage } from "../components/feed";
import { Avatar } from "../components/ui";
import { api, timeAgo } from "../lib/api";
import { rise, staggered } from "../lib/motion";

type RepoRow = {
  owner: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  relation: "owner" | "org" | "collaborator" | "public";
  stars: number;
  updatedAt: string;
};
type OrgRow = { name: string; role: "owner" | "member" };
type Ref = { owner: string; repo: string; number: number; title: string };
type Work = {
  assigned: (Ref & { isPull: boolean; updatedAt: string })[];
  pulls: (Ref & { updatedAt: string; reviewDecision: "approved" | "changes_requested" | null; checks: CiStatus | null })[];
  reviews: (Ref & { author: string })[];
  starred: { owner: string; repo: string; description: string }[];
  counts: { repos: number; publicRepos: number; people: number; orgs: number };
};

export const Route = createFileRoute("/_authed/")({
  loader: async ({ context: { me } }) => {
    const [{ repos }, { orgs }, feed, work] = await Promise.all([
      api<{ repos: RepoRow[] }>("/api/repos"),
      me ? api<{ orgs: OrgRow[] }>("/api/me/orgs") : Promise.resolve({ orgs: [] as OrgRow[] }),
      api<FeedPage>("/api/feed"),
      me ? api<Work>("/api/me/work") : Promise.resolve(null),
    ]);
    // Most recently active first, like GitHub's "Top repositories".
    repos.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { repos, orgs, feed, work };
  },
  component: Dashboard,
});

// Repositories on the left, the feed in the middle, your work on the right. Narrower screens
// move your work above the feed, then stack everything with your work first.
const GRID = "grid grid-cols-[260px_minmax(0,1fr)_300px] [grid-template-areas:'left_main_right'] items-start gap-x-8 gap-y-6 max-2xl:grid-cols-[240px_minmax(0,1fr)] max-2xl:[grid-template-areas:'left_right'_'left_main'] max-[820px]:grid-cols-[minmax(0,1fr)] max-[820px]:[grid-template-areas:'right'_'left'_'main']";
const GRID_TWO = "grid grid-cols-[280px_minmax(0,1fr)] [grid-template-areas:'left_main'] items-start gap-x-8 gap-y-6 max-2xl:grid-cols-[240px_minmax(0,1fr)] max-2xl:[grid-template-areas:'left_right'_'left_main'] max-[820px]:grid-cols-[minmax(0,1fr)] max-[820px]:[grid-template-areas:'right'_'left'_'main']";
const PANEL = "rounded-md border border-border bg-surface shadow-card";
const PANEL_HEAD = "m-0 flex items-center gap-1 border-b border-border px-3.5 py-2.5 text-base";
const PANEL_TITLE = "font-semibold text-fg wrap-anywhere";
const PANEL_META = "text-xs text-muted wrap-anywhere";
const PANEL_STATUS = "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs wrap-anywhere";
const REPO_ICON = "flex-none text-muted";
const STAT = "flex flex-col-reverse gap-0.5 border-t border-border px-3.5 py-3 [&:nth-child(-n+2)]:border-t-0 [&:nth-child(even)]:border-l";
const STAT_VALUE = "m-0 text-[22px] font-bold tracking-tighter tabular-nums";

function Dashboard() {
  const { repos, orgs, feed, work } = Route.useLoaderData();
  const { me } = Route.useRouteContext();
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const by = (relation: RepoRow["relation"]) => repos.filter((r) => r.relation === relation && (!q || `${r.owner}/${r.name}`.includes(q)));
  const feedSection = (
    <section className="stack-sm [grid-area:main] min-w-0" aria-labelledby="feed-title">
      <h2 id="feed-title" className="m-0 text-lg">
        Feed
      </h2>
      <Feed initial={feed} empty={me ? "Nothing has happened in repositories you can see yet. Push some code or open an issue to get things going." : "Nothing has happened in public repositories yet."} />
    </section>
  );
  if (!me)
    return (
      <main className="page wide stack">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl m-0">
            Public repositories
          </h1>
          <span className="flex-1" />
          <Link to="/login" className="button primary small">
            Sign in
          </Link>
        </div>
        <div className={GRID_TWO}>
          <aside className="[grid-area:left] min-w-0 stack-md" aria-label="Repositories">
            <RepoSection title="Public repositories" repos={by("public")} empty="Nothing public yet." />
          </aside>
          {feedSection}
        </div>
      </main>
    );
  return (
    <main className="page wide stack">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-4xl m-0">
          Welcome, {me.username}
        </h1>
        <span className="flex-1" />
        <Link to="/organizations/new" className="button small">
          <Building2 size={16} aria-hidden /> New organization
        </Link>
      </div>
      <div className={GRID}>
        <aside className="[grid-area:left] min-w-0 stack-md" aria-label="Repositories">
          <label className="m-0 flex items-center gap-2 rounded-sm border border-control-border bg-surface px-2.5 font-normal [transition:border-color_150ms_ease,box-shadow_220ms_ease] focus-within:border-focus focus-within:shadow-[0_0_0_5px_color-mix(in_srgb,var(--focus)_16%,transparent)]">
            <Search size={16} aria-hidden className="text-muted" />
            <input
              className="min-w-0 border-0 bg-transparent px-0 py-1.5 focus-visible:shadow-none focus-visible:outline-none"
              aria-label="Find a repository"
              placeholder="Find a repository…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <RepoSection
            title="Your repositories"
            repos={by("owner")}
            empty={q ? "No matches." : "You don’t have any repositories yet."}
            action={
              <Link to="/new" className="button primary small">
                <Plus size={16} aria-hidden /> New<span className="sr-only"> repository</span>
              </Link>
            }
          />
          {orgs.map((o) => (
            <RepoSection
              key={o.name}
              title={o.name}
              icon={<Avatar name={o.name} size={20} />}
              titleLink={o.name}
              repos={by("org").filter((r) => r.owner === o.name)}
              empty={q ? "No matches." : o.role === "owner" ? "No repositories in this organization yet." : "No repositories you can see yet."}
            />
          ))}
          <RepoSection title="Shared with you" repos={by("collaborator")} empty={q ? "No matches." : "Nobody has added you to a repository yet."} />
          <RepoSection title="Public repositories" repos={by("public")} empty={q ? "No matches." : "No public repositories from other people yet."} />
        </aside>
        {feedSection}
        {work && <YourWork work={work} />}
      </div>
    </main>
  );
}

const TOP = 6;

// A compact list of repository names, most recently active first, with the rest a click away.
function RepoSection({
  title,
  repos,
  empty,
  action,
  icon,
  titleLink,
}: {
  title: string;
  repos: RepoRow[];
  empty: string;
  action?: ReactNode;
  icon?: ReactNode;
  titleLink?: string;
}) {
  const id = useId();
  const [all, setAll] = useState(false);
  const shown = all ? repos : repos.slice(0, TOP);
  return (
    <section className="flex flex-col gap-1.5" aria-labelledby={id}>
      <header className="flex min-h-7 items-center gap-2">
        {icon}
        <h2 id={id} className="m-0 text-base font-bold wrap-anywhere">
          {titleLink ? (
            <Link to="/$owner" params={{ owner: titleLink }} className="text-fg">
              {title}
            </Link>
          ) : (
            title
          )}
        </h2>
        <span className="flex-1" />
        {action}
      </header>
      {repos.length === 0 ? (
        <p className="m-0 text-sm text-muted">{empty}</p>
      ) : (
        <motion.ul className="m-0 flex list-none flex-col p-0" {...staggered}>
          {shown.map((r, i) => (
            <motion.li key={`${r.owner}/${r.name}`} variants={rise} custom={i} className="flex min-w-0 items-center gap-2">
              <Link
                to="/$owner/$repo"
                params={{ owner: r.owner, repo: r.name }}
                className="-mx-1.5 flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-base text-fg transition-[background-color] hover:bg-surface-3 hover:no-underline"
                title={r.description || undefined}
              >
                {r.visibility === "public" ? <Globe size={14} aria-hidden className={REPO_ICON} /> : <BookLock size={14} aria-hidden className={REPO_ICON} />}
                <span className="min-w-0 truncate">
                  {r.owner}/<strong className="font-semibold">{r.name}</strong>
                </span>
              </Link>
              {r.stars > 0 && (
                <span className="inline-flex flex-none items-center gap-[3px] text-xs text-muted tabular-nums" title={`${r.stars} stars`}>
                  <Star size={12} aria-hidden /> {r.stars}
                </span>
              )}
            </motion.li>
          ))}
        </motion.ul>
      )}
      {repos.length > TOP && (
        <button
          type="button"
          className="ghost self-start min-h-0 text-sm text-link hover:not-disabled:bg-transparent hover:not-disabled:underline hover:not-disabled:underline-offset-[3px]"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show ${repos.length - TOP} more`}
        </button>
      )}
    </section>
  );
}

// "Your work": each panel only appears when it has something in it.
function YourWork({ work }: { work: Work }) {
  const c = work.counts;
  return (
    <aside className="[grid-area:right] min-w-0 stack-md" aria-label="Your work">
      <Panel title="Waiting for your review" items={work.reviews}>
        {(p) => (
          <>
            <IssueTitle r={p} isPull />
            <span className={PANEL_META}>
              {p.owner}/{p.repo}#{p.number} · by {p.author}
            </span>
          </>
        )}
      </Panel>
      <Panel title="Assigned to you" items={work.assigned}>
        {(i) => (
          <>
            <IssueTitle r={i} isPull={i.isPull} />
            <span className={PANEL_META}>
              {i.owner}/{i.repo}#{i.number} · updated {timeAgo(i.updatedAt)}
            </span>
          </>
        )}
      </Panel>
      <Panel title="Your pull requests" items={work.pulls}>
        {(p) => (
          <>
            <IssueTitle r={p} isPull />
            <span className={PANEL_STATUS}>
              <span className="text-muted">
                {p.owner}/{p.repo}#{p.number}
              </span>
              <ReviewChip decision={p.reviewDecision} />
              {p.checks && <CiBadge status={p.checks} />}
            </span>
          </>
        )}
      </Panel>
      <Panel title="Recently starred" items={work.starred}>
        {(s) => (
          <>
            <Link to="/$owner/$repo" params={{ owner: s.owner, repo: s.repo }} className={PANEL_TITLE}>
              {s.owner}/{s.repo}
            </Link>
            {s.description && <span className={PANEL_META}>{s.description}</span>}
          </>
        )}
      </Panel>
      <section className={PANEL} aria-labelledby="server-title">
        <h2 id="server-title" className={PANEL_HEAD}>
          On this server
        </h2>
        <dl className="m-0 grid grid-cols-2">
          <div className={STAT}>
            <dt className="text-xs text-muted">Repositories you can see</dt>
            <dd className={STAT_VALUE}>{c.repos}</dd>
          </div>
          <div className={STAT}>
            <dt className="text-xs text-muted">Public repositories</dt>
            <dd className={STAT_VALUE}>{c.publicRepos}</dd>
          </div>
          <div className={STAT}>
            <dt className="text-xs text-muted">People</dt>
            <dd className={STAT_VALUE}>{c.people}</dd>
          </div>
          <div className={STAT}>
            <dt className="text-xs text-muted">Your organizations</dt>
            <dd className={STAT_VALUE}>{c.orgs}</dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}

function Panel<T>({ title, items, children }: { title: string; items: T[]; children: (item: T) => ReactNode }) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section className={PANEL} aria-labelledby={id}>
      <h2 id={id} className={PANEL_HEAD}>
        {title} <span className="count">{items.length}</span>
      </h2>
      <motion.ul className="m-0 list-none px-0 py-1" {...staggered}>
        {items.map((item, i) => (
          <motion.li key={i} variants={rise} custom={i} className={`flex min-w-0 flex-col gap-0.5 px-3.5 py-2${i > 0 ? " border-t border-border" : ""}`}>
            {children(item)}
          </motion.li>
        ))}
      </motion.ul>
    </section>
  );
}

function IssueTitle({ r, isPull }: { r: Ref; isPull: boolean }) {
  const params = { owner: r.owner, repo: r.repo, number: String(r.number) };
  return isPull ? (
    <Link to="/$owner/$repo/pull/$number" params={params} className={PANEL_TITLE}>
      {r.title}
    </Link>
  ) : (
    <Link to="/$owner/$repo/issues/$number" params={params} className={PANEL_TITLE}>
      {r.title}
    </Link>
  );
}

function ReviewChip({ decision }: { decision: "approved" | "changes_requested" | null }) {
  const base = "inline-flex items-center gap-1 text-xs whitespace-nowrap";
  if (decision === "approved") return <span className={`${base} text-open`}>Approved</span>;
  if (decision === "changes_requested") return <span className={`${base} text-danger`}>Changes requested</span>;
  return <span className={`${base} text-muted`}>Review pending</span>;
}
