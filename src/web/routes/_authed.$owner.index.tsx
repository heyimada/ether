import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { BookLock, Building2, Globe, Link2, MapPin, Plus, Smile, Star, Users } from "lucide-react";
import { motion } from "motion/react";
import { cloneElement, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ActivityCalendar, type Activity as Day } from "react-activity-calendar";
import { Markdown } from "../components/content";
import { toast } from "sonner";
import { EventItem, type FeedEvent } from "../components/feed";
import { Avatar, ErrorNote, TabBar, useAction } from "../components/ui";
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

function Profile() {
  const { data, people } = Route.useLoaderData();
  const { tab = "overview" } = Route.useSearch();
  const { owner } = Route.useParams();
  if (data.isOrg) return <OrgView data={data} />;
  return (
    <main className="page wide profile-layout">
      <ProfileCard data={data} />
      <div className="profile-main stack-md">
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
                <motion.li key={`${r.owner}/${r.name}`} className="repo-row" variants={rise} custom={i}>
                  <div className="stack-sm" style={{ gap: 4 }}>
                    <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
                      <BookLock size={16} aria-hidden className="muted" />
                      {r.owner}/{r.name}
                    </Link>
                    {r.description && <span className="muted">{r.description}</span>}
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
    <aside className="profile-card" aria-label="Profile">
      <Avatar name={data.username} size={232} labelled />
      <div>
        <h1 className="profile-name">{p.displayName || data.username}</h1>
        {(p.displayName || p.pronouns) && (
          <p className="profile-handle">
            {p.displayName && data.username}
            {p.displayName && p.pronouns && " · "}
            {p.pronouns && <span className="muted">{p.pronouns}</span>}
          </p>
        )}
      </div>
      {p.status && (
        <p className="profile-status">
          <Smile size={16} aria-hidden /> {p.status}
        </p>
      )}
      {p.bio && <p className="profile-bio">{p.bio}</p>}
      <ErrorNote error={toggle.error} />
      {!signedIn ? null : data.isSelf ? (
        <Link to="/settings" className="button wide-link">
          Edit profile
        </Link>
      ) : (
        <button className={data.isFollowing ? "wide" : "primary wide"} onClick={() => toggle.run()} disabled={toggle.pending}>
          {data.isFollowing ? "Unfollow" : "Follow"}
        </button>
      )}
      <p className="profile-follow">
        <Users size={16} aria-hidden className="muted" />
        <Link to="/$owner" params={{ owner }} search={{ tab: "followers" }}>
          {plural(data.followers, "follower")}
        </Link>
        <span aria-hidden>·</span>
        <Link to="/$owner" params={{ owner }} search={{ tab: "following" }}>
          {data.following} following
        </Link>
      </p>
      {data.organizations.length > 0 && (
        <div className="stack-sm" style={{ gap: 8 }}>
          <h2 className="section-title" style={{ fontSize: 14 }}>
            Organizations
          </h2>
          <div className="org-avatars">
            {data.organizations.map((o) => (
              <Link key={o.name} to="/$owner" params={{ owner: o.name }} title={o.name} aria-label={o.name}>
                <Avatar name={o.name} size={32} />
              </Link>
            ))}
          </div>
        </div>
      )}
      <ul className="profile-facts">
        {p.company && (
          <li>
            <Building2 size={16} aria-hidden /> {p.company}
          </li>
        )}
        {p.location && (
          <li>
            <MapPin size={16} aria-hidden /> {p.location}
          </li>
        )}
        {[p.website, ...p.socials].filter(Boolean).map((url) => (
          <li key={url}>
            <Link2 size={16} aria-hidden />
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
    <span className="repo-meta">
      {r.language && (
        <span className="repo-lang">
          <span className="lang-dot" style={{ background: r.language.color ?? "var(--control-border)" }} aria-hidden />
          {r.language.name}
        </span>
      )}
      {r.stars > 0 && (
        <span title={plural(r.stars, "star")}>
          <Star size={14} aria-hidden /> <span className="num">{r.stars}</span>
        </span>
      )}
      {updated && <span>Updated {timeAgo(r.updatedAt)}</span>}
    </span>
  );
}

const VisibilityIcon = ({ r }: { r: RepoCard }) =>
  r.visibility === "public" ? <Globe size={16} aria-hidden className="muted" /> : <BookLock size={16} aria-hidden className="muted" />;

function RepoTile({ r, i }: { r: RepoCard; i: number }) {
  return (
    <motion.li className="repo-tile" variants={rise} custom={i}>
      <div className="repo-tile-head">
        <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
          <VisibilityIcon r={r} />
          {r.owner}/{r.name}
        </Link>
        <span className="pill">{r.visibility === "public" ? "Public" : "Private"}</span>
      </div>
      <p className="muted">{r.description || "No description."}</p>
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
            <span className="muted mono">
              {data.username}/{data.username.toLowerCase()}/README.md
            </span>
          </header>
          <Markdown source={data.readme} label="Profile README" />
        </section>
      )}
      {data.pinned.length > 0 ? (
        <section className="stack-sm">
          <h2 className="section-title">Pinned</h2>
          <motion.ul className="repo-grid" aria-label="Pinned repositories" {...staggered}>
            {data.pinned.map((r, i) => (
              <RepoTile key={`${r.owner}/${r.name}`} r={r} i={i} />
            ))}
          </motion.ul>
        </section>
      ) : data.popular.length > 0 ? (
        <section className="stack-sm">
          <div className="row">
            <h2 className="section-title">Popular repositories</h2>
            <span className="spacer" />
            {data.isSelf && (
              <Link to="/settings" className="hint">
                Pin repositories
              </Link>
            )}
          </div>
          <motion.ul className="repo-grid" aria-label="Popular repositories" {...staggered}>
            {data.popular.map((r, i) => (
              <RepoTile key={`${r.owner}/${r.name}`} r={r} i={i} />
            ))}
          </motion.ul>
        </section>
      ) : null}
      <section className="stack-sm">
        <h2 className="section-title">{plural(data.contributions.total, "contribution")} in the last year</h2>
        <div className="card contrib-card">
          <div className="body calendar">
            <Contributions days={data.contributions.days} />
          </div>
          <ul className="contrib-summary" aria-label="Contribution summary">
            <li>
              <strong className="num">{s.commits}</strong> {s.commits === 1 ? "commit" : "commits"}
            </li>
            <li>
              <strong className="num">{s.pulls}</strong> {s.pulls === 1 ? "pull request" : "pull requests"}
            </li>
            <li>
              <strong className="num">{s.issues}</strong> {s.issues === 1 ? "issue" : "issues"}
            </li>
            <li>
              <strong className="num">{s.reviews}</strong> {s.reviews === 1 ? "review" : "reviews"}
            </li>
          </ul>
        </div>
        {data.isSelf && !data.hasCommitEmails ? (
          <p className="notice" style={{ margin: 0 }}>
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
      <h2 className="section-title">Recent activity</h2>
      {events.length ? (
        <motion.ol className="timeline-list" aria-label="Recent activity" {...staggered}>
          {events.map((e, i) => (
            <EventItem key={e.id} e={e} i={i} avatar={false} />
          ))}
        </motion.ol>
      ) : (
        <p className="muted">{empty}</p>
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
    <div className="legend" aria-hidden>
      Less
      {LEVELS.map((fill) => (
        <span key={fill} style={{ background: fill }} />
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
      <div className="row">
        <input aria-label="Find a repository" placeholder="Find a repository…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        {data.isSelf && (
          <Link to="/new" className="button primary">
            <Plus size={16} aria-hidden /> New repository
          </Link>
        )}
      </div>
      {shown.length ? (
        <motion.ul className="card list" aria-label="Repositories" {...staggered}>
          {shown.map((r, i) => (
            <motion.li key={r.name} className="repo-row" variants={rise} custom={i}>
              <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
                <span className="row" style={{ gap: 8 }}>
                  <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
                    <VisibilityIcon r={r} />
                    {r.name}
                  </Link>
                  <span className="pill">{r.visibility === "public" ? "Public" : "Private"}</span>
                </span>
                {r.description && <span className="muted">{r.description}</span>}
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
      <h2 className="section-title">{title}</h2>
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
      <header className="org-head">
        <Avatar name={data.username} size={96} labelled />
        <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
          <h1 className="profile-name">{p.displayName || data.username}</h1>
          {p.bio && <p className="profile-bio muted">{p.bio}</p>}
          <ul className="profile-facts row" style={{ flexDirection: "row", gap: 16 }}>
            {p.location && (
              <li>
                <MapPin size={16} aria-hidden /> {p.location}
              </li>
            )}
            {p.website && (
              <li>
                <Link2 size={16} aria-hidden />
                <a href={p.website} rel="noopener noreferrer nofollow" target="_blank">
                  {linkText(p.website)}
                </a>
              </li>
            )}
            <li>
              <Users size={16} aria-hidden /> {plural(data.members.length, "member")}
            </li>
            {data.teams !== null && (
              <li>
                <Building2 size={16} aria-hidden /> {plural(data.teams, "team")}
              </li>
            )}
          </ul>
        </div>
        <span className="spacer" />
        {data.viewerOrgRole === "owner" && (
          <div className="row">
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
        <div className="org-layout">
          <div className="stack">
            <Repositories data={{ ...data, isSelf: data.viewerOrgRole === "owner" }} />
            <ActivitySection events={data.activity} empty="Nothing has happened in repositories you can see yet." />
          </div>
          <aside className="side-col">
            <section className="side-section" aria-labelledby="org-people">
              <h3 id="org-people">
                <Link to="/$owner" params={{ owner }} search={{ tab: "followers" }} className="heading-link">
                  People
                </Link>
              </h3>
              <ul className="member-grid" aria-label="People">
                {data.members.map((m) => (
                  <li key={m.username}>
                    <Link to="/$owner" params={{ owner: m.username }} title={m.displayName || m.username} aria-label={m.username}>
                      <Avatar name={m.username} size={40} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
            {languages.length > 0 && (
              <section className="side-section" aria-labelledby="org-langs">
                <h3 id="org-langs">Top languages</h3>
                <ul className="lang-legend lang-legend-stack">
                  {languages.map((l) => (
                    <li key={l.name}>
                      <span className="lang-dot" style={{ background: l.color ?? "var(--control-border)" }} aria-hidden />
                      <span className="lang-name">{l.name}</span> <span className="muted num">{plural(l.repos, "repository", "repositories")}</span>
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
