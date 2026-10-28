import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { BookLock, Building2, Globe, Link2, MapPin, Plus, Smile, Star, Users } from "lucide-react";
import { motion } from "motion/react";
import { cloneElement, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ActivityCalendar, type Activity as Day } from "react-activity-calendar";
import { Markdown } from "../components/content";
import { toast } from "sonner";
import { EventItem, type FeedEvent } from "../components/feed";
import { Avatar, ErrorNote, ROW, TabBar, useAction } from "../components/ui";
import { api, del, put, timeAgo } from "../lib/api";
import { rise, staggered } from "../lib/motion";

type RepoCard = {
  owner: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  createdAt: string;
  updatedAt: string;
  stars: number;
  language: { name: string; color: string | null } | null;
};
type ProfileData = {
  username: string;
  isOrg: boolean;
  members: Person[];
  viewerOrgRole: "owner" | "member" | null;
  organizations: { name: string; avatarVersion: number | null }[];
  isSelf: boolean;
  hasCommitEmails: boolean;
  profile: {
    displayName: string;
    bio: string;
    pronouns: string;
    company: string;
    location: string;
    website: string;
    socials: string[];
    status: string;
    avatarVersion: number | null;
  };
  followers: number;
  following: number;
  isFollowing: boolean;
  pinned: RepoCard[];
  popular: RepoCard[];
  stars: RepoCard[];
  repos: RepoCard[];
  teams: number | null;
  readme: string | null;
  contributions: { days: { date: string; count: number }[]; total: number; summary: { commits: number; pulls: number; issues: number; reviews: number } };
  activity: FeedEvent[];
};
type Person = { username: string; displayName: string; avatarVersion: number | null };
type Tab = "overview" | "repositories" | "stars" | "followers" | "following";

// Search params are matched partially by default, so the link without a tab counted as active on every
// tab: the router gave it the "active" class and data-status too, and the underline went to it first.
// With explicitUndefined, `tab: undefined` only matches when there is no tab.
const TAB_MATCH = { includeSearch: true, explicitUndefined: true };

export const Route = createFileRoute("/_authed/$owner/")({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({
    tab: s.tab === "repositories" || s.tab === "stars" || s.tab === "followers" || s.tab === "following" ? s.tab : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: async ({ params, deps }) => {
    const base = `/api/users/${encodeURIComponent(params.owner)}`;
    const [data, people] = await Promise.all([
      api<ProfileData>(`${base}/profile`),
      deps.tab === "followers" || deps.tab === "following" ? api<{ users: Person[] }>(`${base}/${deps.tab}`).then((r) => r.users) : Promise.resolve(null),
    ]);
    return { data, people };
  },
  component: Profile,
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const linkText = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

const SECTION_TITLE = "m-0 text-lg";
const SIDE_HEADING = "m-0 mb-2 text-base";
const SUMMARY_ITEM = "px-4 py-3 text-sm text-muted";
const PROFILE_NAME = "m-0 text-4xl tracking-tighter wrap-anywhere";
const REPO_LINK = "inline-flex items-center gap-2 font-semibold wrap-anywhere";
const REPO_GRID = "m-0 grid list-none grid-cols-[repeat(2,minmax(0,1fr))] gap-4 p-0 max-lg:grid-cols-[minmax(0,1fr)]";
const META_ITEM = "inline-flex items-center gap-1";
const LANG_DOT = "inline-block flex-none size-2.5 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--text)_15%,transparent)]";
const FACT = "flex min-w-0 items-center gap-2 wrap-anywhere";
const FACT_ICON = "flex-none text-muted";
const FIGURE = "block text-2xl tracking-tighter tabular-nums text-fg";

function Profile() {
  const { data, people } = Route.useLoaderData();
  const { tab = "overview" } = Route.useSearch();
  const { owner } = Route.useParams();
  if (data.isOrg) return <OrgView data={data} />;
  return (
    <main className="page wide grid grid-cols-[260px_minmax(0,1fr)] items-start gap-8 max-lg:grid-cols-[minmax(0,1fr)] max-lg:gap-6">
      <ProfileCard data={data} />
      <div className="stack-md min-w-0 [&>.tabs]:m-0">
        <TabBar label="Profile sections" activeSelector=".active">
          {(
            [
              ["overview", "Overview", null],
              ["repositories", "Repositories", data.repos.length],
              ["stars", "Stars", data.stars.length],
            ] as const
          ).map(([key, label, count]) => (
            <Link key={key} to="/$owner" params={{ owner }} search={{ tab: key === "overview" ? undefined : key }} className={tab === key ? "active" : ""} activeOptions={TAB_MATCH}>
              {label}
              {count !== null && <span className="count">{count}</span>}
            </Link>
          ))}
        </TabBar>
        {tab === "overview" && <Overview data={data} />}
        {tab === "repositories" && <Repositories data={data} />}
        {tab === "stars" &&
          (data.stars.length ? (
            <motion.ul className="card list" aria-label="Starred repositories" {...staggered}>
              {data.stars.map((r, i) => (
                <motion.li key={`${r.owner}/${r.name}`} variants={rise} custom={i}>
                  <div className="stack-sm gap-1">
                    <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className={REPO_LINK}>
                      <BookLock size={16} aria-hidden className="text-muted" />
                      {r.owner}/{r.name}
                    </Link>
                    {r.description && <span className="text-muted">{r.description}</span>}
                  </div>
                </motion.li>
              ))}
            </motion.ul>
          ) : (
            <p className="empty card">{data.isSelf ? "Star repositories to keep track of them here." : "No starred repositories you can see."}</p>
          ))}
        {(tab === "followers" || tab === "following") && <PeopleList title={tab === "followers" ? "Followers" : "Following"} people={people ?? []} />}
      </div>
    </main>
  );
}

function ProfileCard({ data }: { data: ProfileData }) {
  const router = useRouter();
  const signedIn = !!Route.useRouteContext().me;
  const { owner } = Route.useParams();
  const p = data.profile;
  const toggle = useAction(async () => {
    const url = `/api/users/${encodeURIComponent(data.username)}/follow`;
    await (data.isFollowing ? del(url) : put(url, {}));
    await router.invalidate();
    toast(data.isFollowing ? `Unfollowed ${data.username}` : `You're following ${data.username}`);
  });
  return (
    <aside
      className="flex min-w-0 flex-col gap-3 [&>.avatar]:aspect-square [&>.avatar]:h-auto! [&>.avatar]:w-full! [&>.avatar]:max-w-[260px] max-lg:[&>.avatar]:max-w-[120px] [&>.avatar]:border [&>.avatar]:border-border [&>.avatar]:bg-transparent [&>.avatar]:bg-[radial-gradient(circle_at_30%_25%,color-mix(in_srgb,var(--accent)_28%,var(--surface)),var(--accent-soft)_70%)] [&>.avatar]:text-[96px]! max-lg:[&>.avatar]:text-[48px]! [&>.avatar]:shadow-[0_0_0_5px_var(--surface),0_0_0_6px_var(--border),var(--elevation-lift)]"
      aria-label="Profile"
    >
      <Avatar name={data.username} size={232} labelled />
      <div>
        <h1 className={PROFILE_NAME}>{p.displayName || data.username}</h1>
        {(p.displayName || p.pronouns) && (
          <p className="m-0 text-xl font-light text-muted wrap-anywhere">
            {p.displayName && data.username}
            {p.displayName && p.pronouns && " · "}
            {p.pronouns && <span className="text-muted">{p.pronouns}</span>}
          </p>
        )}
      </div>
      {p.status && (
        <p className="m-0 flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm shadow-xs">
          <Smile size={16} aria-hidden /> {p.status}
        </p>
      )}
      {p.bio && <p className="m-0 wrap-anywhere">{p.bio}</p>}
      <ErrorNote error={toggle.error} />
      {!signedIn ? null : data.isSelf ? (
        <Link to="/settings" className="button justify-center">
          Edit profile
        </Link>
      ) : (
        <button className={data.isFollowing ? "wide" : "primary wide"} onClick={() => toggle.run()} disabled={toggle.pending}>
          {data.isFollowing ? "Unfollow" : "Follow"}
        </button>
      )}
      <p className="m-0 flex flex-wrap items-center gap-1.5 text-base">
        <Users size={16} aria-hidden className="text-muted" />
        <Link to="/$owner" params={{ owner }} search={{ tab: "followers" }} className="text-fg">
          {plural(data.followers, "follower")}
        </Link>
        <span aria-hidden>·</span>
        <Link to="/$owner" params={{ owner }} search={{ tab: "following" }} className="text-fg">
          {data.following} following
        </Link>
      </p>
      {data.organizations.length > 0 && (
        <div className="stack-sm gap-2">
          <h2 className="m-0 text-base">
            Organizations
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {data.organizations.map((o) => (
              <Link key={o.name} to="/$owner" params={{ owner: o.name }} title={o.name} aria-label={o.name}>
                <Avatar name={o.name} size={32} />
              </Link>
            ))}
          </div>
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-base">
        {p.company && (
          <li className={FACT}>
            <Building2 size={16} aria-hidden className={FACT_ICON} /> {p.company}
          </li>
        )}
        {p.location && (
          <li className={FACT}>
            <MapPin size={16} aria-hidden className={FACT_ICON} /> {p.location}
          </li>
        )}
        {[p.website, ...p.socials].filter(Boolean).map((url) => (
          <li key={url} className={FACT}>
            <Link2 size={16} aria-hidden className={FACT_ICON} />
            <a href={url} rel="noopener noreferrer nofollow" target="_blank">
              {linkText(url)}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// Language, stars and last activity: what tells repositories apart at a glance.
function RepoMeta({ r, updated = false }: { r: RepoCard; updated?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {r.language && (
        <span className={`${META_ITEM} text-fg`}>
          <span className={LANG_DOT} style={{ background: r.language.color ?? "var(--control-border)" }} aria-hidden />
          {r.language.name}
        </span>
      )}
      {r.stars > 0 && (
        <span className={META_ITEM} title={plural(r.stars, "star")}>
          <Star size={14} aria-hidden /> <span className="tabular-nums">{r.stars}</span>
        </span>
      )}
      {updated && <span className={META_ITEM}>Updated {timeAgo(r.updatedAt)}</span>}
    </span>
  );
}

const VisibilityIcon = ({ r }: { r: RepoCard }) =>
  r.visibility === "public" ? <Globe size={16} aria-hidden className="text-muted" /> : <BookLock size={16} aria-hidden className="text-muted" />;

function RepoTile({ r, i }: { r: RepoCard; i: number }) {
  // Lift on hover: the deeper shadow fades in on a pseudo-element instead of animating box-shadow.
  return (
    <motion.li
      className="relative flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-4 shadow-card transition-[border-color] duration-220 hover:border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] after:pointer-events-none after:absolute after:-inset-px after:content-[''] after:rounded-[inherit] after:opacity-0 after:shadow-lift after:transition-opacity after:duration-220 hover:after:opacity-100"
      variants={rise}
      custom={i}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className={REPO_LINK}>
          <VisibilityIcon r={r} />
          {r.owner}/{r.name}
        </Link>
        <span className="pill self-start">{r.visibility === "public" ? "Public" : "Private"}</span>
      </div>
      <p className="m-0 flex-1 text-sm wrap-anywhere text-muted">{r.description || "No description."}</p>
      <RepoMeta r={r} />
    </motion.li>
  );
}

function Overview({ data }: { data: ProfileData }) {
  const s = data.contributions.summary;
  return (
    <>
      {data.readme !== null && (
        <section className="card">
          <header>
            <span className="text-muted font-mono">
              {data.username}/{data.username.toLowerCase()}/README.md
            </span>
          </header>
          <Markdown source={data.readme} label="Profile README" />
        </section>
      )}
      {data.pinned.length > 0 ? (
        <section className="stack-sm">
          <h2 className={SECTION_TITLE}>Pinned</h2>
          <motion.ul className={REPO_GRID} aria-label="Pinned repositories" {...staggered}>
            {data.pinned.map((r, i) => (
              <RepoTile key={`${r.owner}/${r.name}`} r={r} i={i} />
            ))}
          </motion.ul>
        </section>
      ) : data.popular.length > 0 ? (
        <section className="stack-sm">
          <div className={ROW}>
            <h2 className={SECTION_TITLE}>Popular repositories</h2>
            <span className="flex-1" />
            {data.isSelf && (
              <Link to="/settings" className="hint">
                Pin repositories
              </Link>
            )}
          </div>
          <motion.ul className={REPO_GRID} aria-label="Popular repositories" {...staggered}>
            {data.popular.map((r, i) => (
              <RepoTile key={`${r.owner}/${r.name}`} r={r} i={i} />
            ))}
          </motion.ul>
        </section>
      ) : null}
      <section className="stack-sm">
        <h2 className={SECTION_TITLE}>{plural(data.contributions.total, "contribution")} in the last year</h2>
        <div className="card">
          <div className="body calendar border-b border-border">
            <Contributions days={data.contributions.days} />
          </div>
          <ul className="m-0 grid list-none grid-cols-[repeat(4,minmax(0,1fr))] p-0 max-sm:grid-cols-[repeat(2,minmax(0,1fr))]" aria-label="Contribution summary">
            <li className={SUMMARY_ITEM}>
              <strong className={FIGURE}>{s.commits}</strong> {s.commits === 1 ? "commit" : "commits"}
            </li>
            <li className={`${SUMMARY_ITEM} border-border border-l`}>
              <strong className={FIGURE}>{s.pulls}</strong> {s.pulls === 1 ? "pull request" : "pull requests"}
            </li>
            <li className={`${SUMMARY_ITEM} border-border border-l max-sm:border-t max-sm:border-l-0`}>
              <strong className={FIGURE}>{s.issues}</strong> {s.issues === 1 ? "issue" : "issues"}
            </li>
            <li className={`${SUMMARY_ITEM} border-border border-l max-sm:border-t`}>
              <strong className={FIGURE}>{s.reviews}</strong> {s.reviews === 1 ? "review" : "reviews"}
            </li>
          </ul>
        </div>
        {data.isSelf && !data.hasCommitEmails ? (
          <p className="notice m-0">
            Your commits aren't counted yet because Ether doesn't know which email you commit with. <Link to="/settings">Add your commit email</Link>{" "}
            (the one in <code>git config user.email</code>).
          </p>
        ) : (
          <p className="hint">Commits on default branches from the commit emails set in Settings, plus issues, pull requests and comments, in repositories you can see. Reviews appear in the summary only.</p>
        )}
      </section>
      <ActivitySection events={data.activity} empty="No recent activity you can see." />
    </>
  );
}

function ActivitySection({ events, empty }: { events: FeedEvent[]; empty: string }) {
  return (
    <section className="stack-sm">
      <h2 className={SECTION_TITLE}>Recent activity</h2>
      {events.length ? (
        <motion.ol className="timeline-list" aria-label="Recent activity" {...staggered}>
          {events.map((e, i) => (
            <EventItem key={e.id} e={e} i={i} avatar={false} />
          ))}
        </motion.ol>
      ) : (
        <p className="text-muted">{empty}</p>
      )}
    </section>
  );
}

const LEVELS = ["var(--surface-3)", "color-mix(in srgb, var(--accent) 30%, var(--surface-3))", "color-mix(in srgb, var(--accent) 55%, var(--surface-3))", "color-mix(in srgb, var(--accent) 80%, var(--surface-3))", "var(--accent)"];

function Contributions({ days }: { days: { date: string; count: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const data: Day[] = days.map((d) => ({ ...d, level: d.count === 0 ? 0 : Math.min(4, Math.ceil((d.count / max) * 4)) }));
  // Week of each day, so the year can fill in as a wave from left to right.
  const week = useMemo(() => new Map(days.map((d, i) => [d.date, Math.floor(i / 7)])), [days]);
  // Narrow screens scroll the year sideways; start at the most recent weeks like GitHub.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current?.closest(".calendar");
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  return (
    <div ref={scroller}>
    <ActivityCalendar
      data={data}
      blockSize={11}
      blockMargin={3}
      fontSize={12}
      showTotalCount={false}
      theme={{ light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"] }}
      renderBlock={(block, a) =>
        cloneElement(block, { style: { ...block.props.style, fill: LEVELS[a.level], "--w": week.get(a.date) ?? 0 } as CSSProperties }, <title>{`${plural(a.count, "contribution")} on ${a.date}`}</title>)
      }
      showColorLegend={false}
    />
    <div className="mt-2 flex items-center justify-end gap-[3px] text-xs text-muted" aria-hidden>
      Less
      {LEVELS.map((fill) => (
        <span key={fill} className="size-[11px] rounded-[2px] first-of-type:ml-1 last-of-type:mr-1" style={{ background: fill }} />
      ))}
      More
    </div>
    </div>
  );
}

function Repositories({ data }: { data: ProfileData }) {
  const [filter, setFilter] = useState("");
  const shown = data.repos.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="stack-md">
      <div className={ROW}>
        <input className="flex-1 min-w-0" aria-label="Find a repository" placeholder="Find a repository…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {data.isSelf && (
          <Link to="/new" className="button primary">
            <Plus size={16} aria-hidden /> New repository
          </Link>
        )}
      </div>
      {shown.length ? (
        <motion.ul className="card list" aria-label="Repositories" {...staggered}>
          {shown.map((r, i) => (
            <motion.li key={r.name} variants={rise} custom={i}>
              <div className="stack-sm gap-1 min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className={REPO_LINK}>
                    <VisibilityIcon r={r} />
                    {r.name}
                  </Link>
                  <span className="pill">{r.visibility === "public" ? "Public" : "Private"}</span>
                </span>
                {r.description && <span className="text-muted">{r.description}</span>}
                <RepoMeta r={r} updated />
              </div>
            </motion.li>
          ))}
        </motion.ul>
      ) : (
        <p className="empty card">{filter ? "No repositories match." : "No repositories you can see."}</p>
      )}
    </div>
  );
}

function PeopleList({ title, people }: { title: string; people: Person[] }) {
  return (
    <section className="stack-sm">
      <h2 className={SECTION_TITLE}>{title}</h2>
      {people.length ? (
        <motion.ul className="card list" aria-label={title} {...staggered}>
          {people.map((p, i) => (
            <motion.li key={p.username} variants={rise} custom={i}>
              <Avatar name={p.username} size={40} />
              <div>
                {p.displayName && <strong>{p.displayName} </strong>}
                <Link to="/$owner" params={{ owner: p.username }}>
                  {p.username}
                </Link>
              </div>
            </motion.li>
          ))}
        </motion.ul>
      ) : (
        <p className="empty card">Nobody yet.</p>
      )}
    </section>
  );
}

function OrgView({ data }: { data: ProfileData }) {
  const { tab } = Route.useSearch();
  const { owner } = Route.useParams();
  const p = data.profile;
  // Organizations have Repositories and People; "followers" doubles as the People tab key.
  const current = tab === "followers" ? "followers" : "repositories";
  // How many repositories use each language, across what this viewer can see.
  const languages = useMemo(() => {
    const counts = new Map<string, { name: string; color: string | null; repos: number }>();
    for (const r of data.repos) if (r.language) counts.set(r.language.name, { ...r.language, repos: (counts.get(r.language.name)?.repos ?? 0) + 1 });
    return [...counts.values()].sort((a, b) => b.repos - a.repos || a.name.localeCompare(b.name)).slice(0, 6);
  }, [data.repos]);
  return (
    <main className="page wide stack">
      <header className="flex flex-wrap items-center gap-4 pb-4">
        <Avatar name={data.username} size={96} labelled />
        <div className="stack-sm gap-1 min-w-0">
          <h1 className={PROFILE_NAME}>{p.displayName || data.username}</h1>
          {p.bio && <p className="m-0 wrap-anywhere text-muted">{p.bio}</p>}
          <ul className="m-0 flex list-none flex-wrap items-center gap-4 p-0 text-base">
            {p.location && (
              <li className={FACT}>
                <MapPin size={16} aria-hidden className={FACT_ICON} /> {p.location}
              </li>
            )}
            {p.website && (
              <li className={FACT}>
                <Link2 size={16} aria-hidden className={FACT_ICON} />
                <a href={p.website} rel="noopener noreferrer nofollow" target="_blank">
                  {linkText(p.website)}
                </a>
              </li>
            )}
            <li className={FACT}>
              <Users size={16} aria-hidden className={FACT_ICON} /> {plural(data.members.length, "member")}
            </li>
            {data.teams !== null && (
              <li className={FACT}>
                <Building2 size={16} aria-hidden className={FACT_ICON} /> {plural(data.teams, "team")}
              </li>
            )}
          </ul>
        </div>
        <span className="flex-1" />
        {data.viewerOrgRole === "owner" && (
          <div className={ROW}>
            <Link to="/new" className="button primary">
              <Plus size={16} aria-hidden /> New repository
            </Link>
            <Link to="/organizations/$org/settings" params={{ org: data.username }} className="button">
              Settings
            </Link>
          </div>
        )}
      </header>
      <TabBar label="Organization sections" activeSelector=".active">
        <Link to="/$owner" params={{ owner }} search={{ tab: undefined }} className={current === "repositories" ? "active" : ""} activeOptions={TAB_MATCH}>
          Repositories<span className="count">{data.repos.length}</span>
        </Link>
        <Link to="/$owner" params={{ owner }} search={{ tab: "followers" }} className={current === "followers" ? "active" : ""} activeOptions={TAB_MATCH}>
          People<span className="count">{data.members.length}</span>
        </Link>
      </TabBar>
      {current === "repositories" ? (
        <div className="grid grid-cols-[minmax(0,1fr)_280px] items-start gap-8 max-lg:grid-cols-[minmax(0,1fr)]">
          <div className="stack">
            <Repositories data={{ ...data, isSelf: data.viewerOrgRole === "owner" }} />
            <ActivitySection events={data.activity} empty="Nothing has happened in repositories you can see yet." />
          </div>
          <aside className="flex min-w-0 flex-col gap-6">
            <section aria-labelledby="org-people">
              <h3 id="org-people" className={SIDE_HEADING}>
                <Link to="/$owner" params={{ owner }} search={{ tab: "followers" }} className="text-fg">
                  People
                </Link>
              </h3>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="People">
                {data.members.map((m) => (
                  <li key={m.username}>
                    <Link
                      to="/$owner"
                      params={{ owner: m.username }}
                      title={m.displayName || m.username}
                      aria-label={m.username}
                      className="block rounded-full transition-transform duration-220 ease-out hover:-translate-y-0.5"
                    >
                      <Avatar name={m.username} size={40} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
            {languages.length > 0 && (
              <section aria-labelledby="org-langs">
                <h3 id="org-langs" className={SIDE_HEADING}>
                  Top languages
                </h3>
                <ul className="m-0 flex list-none flex-col flex-wrap gap-x-3.5 gap-y-1.5 p-0 text-sm">
                  {languages.map((l) => (
                    <li key={l.name} className="inline-flex items-center gap-1.5">
                      <span className={LANG_DOT} style={{ background: l.color ?? "var(--control-border)" }} aria-hidden />
                      <span className="font-semibold">{l.name}</span> <span className="text-muted tabular-nums">{plural(l.repos, "repository", "repositories")}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      ) : (
        <PeopleList title="People" people={data.members} />
      )}
    </main>
  );
}
