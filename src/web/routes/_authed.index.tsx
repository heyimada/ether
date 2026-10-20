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

function Dashboard() {
  const { repos, orgs, feed, work } = Route.useLoaderData();
  const { me } = Route.useRouteContext();
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const by = (relation: RepoRow["relation"]) => repos.filter((r) => r.relation === relation && (!q || `${r.owner}/${r.name}`.includes(q)));
  const feedSection = (
    <section className="dash-main stack-sm" aria-labelledby="feed-title">
      <h2 id="feed-title" className="section-title">
        Feed
      </h2>
      <Feed initial={feed} empty={me ? "Nothing has happened in repositories you can see yet. Push some code or open an issue to get things going." : "Nothing has happened in public repositories yet."} />
    </section>
  );
  if (!me)
    return (
      <main className="page wide stack">
        <div className="row page-head">
          <h1 style={{ margin: 0 }}>Public repositories</h1>
          <span className="spacer" />
          <Link to="/login" className="button primary small">
            Sign in
          </Link>
        </div>
        <div className="dash-grid dash-grid-2">
          <aside className="dash-left stack-md" aria-label="Repositories">
            <RepoSection title="Public repositories" repos={by("public")} empty="Nothing public yet." />
          </aside>
          {feedSection}
        </div>
      </main>
    );
  return (
    <main className="page wide stack">
      <div className="row page-head">
        <h1 style={{ margin: 0 }}>Welcome, {me.username}</h1>
        <span className="spacer" />
        <Link to="/organizations/new" className="button small">
          <Building2 size={16} aria-hidden /> New organization
        </Link>
      </div>
      <div className="dash-grid">
        <aside className="dash-left stack-md" aria-label="Repositories">
          <label className="dash-filter">
            <Search size={16} aria-hidden className="muted" />
            <input aria-label="Find a repository" placeholder="Find a repository…" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
    <section className="dash-repos" aria-labelledby={id}>
      <header className="dash-repos-head">
        {icon}
        <h2 id={id} className="dash-repos-title">
          {titleLink ? (
            <Link to="/$owner" params={{ owner: titleLink }} className="heading-link">
              {title}
            </Link>
          ) : (
            title
          )}
        </h2>
        <span className="spacer" />
        {action}
      </header>
      {repos.length === 0 ? (
        <p className="dash-empty">{empty}</p>
      ) : (
        <motion.ul className="dash-repo-list" {...staggered}>
          {shown.map((r, i) => (
            <motion.li key={`${r.owner}/${r.name}`} variants={rise} custom={i}>
              <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="dash-repo" title={r.description || undefined}>
                {r.visibility === "public" ? <Globe size={14} aria-hidden className="muted" /> : <BookLock size={14} aria-hidden className="muted" />}
                <span className="dash-repo-name">
                  {r.owner}/<strong>{r.name}</strong>
                </span>
              </Link>
              {r.stars > 0 && (
                <span className="dash-repo-stars muted num" title={`${r.stars} stars`}>
                  <Star size={12} aria-hidden /> {r.stars}
                </span>
              )}
            </motion.li>
          ))}
        </motion.ul>
      )}
      {repos.length > TOP && (
        <button type="button" className="ghost dash-more" onClick={() => setAll(!all)}>
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
    <aside className="dash-right stack-md" aria-label="Your work">
      <Panel title="Waiting for your review" items={work.reviews}>
        {(p) => (
          <>
            <IssueTitle r={p} isPull />
            <span className="muted panel-meta">
              {p.owner}/{p.repo}#{p.number} · by {p.author}
            </span>
          </>
        )}
      </Panel>
      <Panel title="Assigned to you" items={work.assigned}>
        {(i) => (
          <>
            <IssueTitle r={i} isPull={i.isPull} />
            <span className="muted panel-meta">
              {i.owner}/{i.repo}#{i.number} · updated {timeAgo(i.updatedAt)}
            </span>
          </>
        )}
      </Panel>
      <Panel title="Your pull requests" items={work.pulls}>
        {(p) => (
          <>
            <IssueTitle r={p} isPull />
            <span className="panel-meta panel-status">
              <span className="muted">
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
            <Link to="/$owner/$repo" params={{ owner: s.owner, repo: s.repo }} className="panel-title">
              {s.owner}/{s.repo}
            </Link>
            {s.description && <span className="muted panel-meta">{s.description}</span>}
          </>
        )}
      </Panel>
      <section className="panel" aria-labelledby="server-title">
        <h2 id="server-title" className="panel-head">
          On this server
        </h2>
        <dl className="server-stats">
          <div>
            <dt>Repositories you can see</dt>
            <dd className="num">{c.repos}</dd>
          </div>
          <div>
            <dt>Public repositories</dt>
            <dd className="num">{c.publicRepos}</dd>
          </div>
          <div>
            <dt>People</dt>
            <dd className="num">{c.people}</dd>
          </div>
          <div>
            <dt>Your organizations</dt>
            <dd className="num">{c.orgs}</dd>
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
    <section className="panel" aria-labelledby={id}>
      <h2 id={id} className="panel-head">
        {title} <span className="count">{items.length}</span>
      </h2>
      <motion.ul className="panel-list" {...staggered}>
        {items.map((item, i) => (
          <motion.li key={i} variants={rise} custom={i}>
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
    <Link to="/$owner/$repo/pull/$number" params={params} className="panel-title">
      {r.title}
    </Link>
  ) : (
    <Link to="/$owner/$repo/issues/$number" params={params} className="panel-title">
      {r.title}
    </Link>
  );
}

function ReviewChip({ decision }: { decision: "approved" | "changes_requested" | null }) {
  if (decision === "approved") return <span className="review-state review-approved">Approved</span>;
  if (decision === "changes_requested") return <span className="review-state review-changes_requested">Changes requested</span>;
  return <span className="review-state">Review pending</span>;
}
