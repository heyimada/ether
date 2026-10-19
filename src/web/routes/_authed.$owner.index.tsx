import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { BookLock, Building2, GitMerge, GitPullRequest, Link2, MapPin, MessageSquare, CircleDot, Plus, Smile, Users } from "lucide-react";
import { cloneElement, useEffect, useRef, useState } from "react";
import { ActivityCalendar, type Activity as Day } from "react-activity-calendar";
import { Markdown } from "../components/content";
import { Avatar, ErrorNote, useAction } from "../components/ui";
import { api, del, put, timeAgo } from "../lib/api";

type RepoCard = { owner: string; name: string; description: string; createdAt: string };
type Event = { kind: "opened-issue" | "opened-pull" | "commented" | "merged"; at: string; owner: string; repo: string; number: number; title: string };
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
  stars: RepoCard[];
  repos: RepoCard[];
  readme: string | null;
  contributions: { days: { date: string; count: number }[]; total: number };
  activity: Event[];
};
type Person = { username: string; displayName: string; avatarVersion: number | null };
type Tab = "overview" | "repositories" | "stars" | "followers" | "following";

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
    <main className="page profile-layout">
      <ProfileCard data={data} />
      <div className="profile-main stack-md">
        <nav className="tabs" aria-label="Profile sections">
          {(
            [
              ["overview", "Overview", null],
              ["repositories", "Repositories", data.repos.length],
              ["stars", "Stars", data.stars.length],
            ] as const
          ).map(([key, label, count]) => (
            <Link key={key} to="/$owner" params={{ owner }} search={key === "overview" ? {} : { tab: key }} className={tab === key ? "active" : ""} activeOptions={{ includeSearch: true }}>
              {label}
              {count !== null && <span className="count">{count}</span>}
            </Link>
          ))}
        </nav>
        {tab === "overview" && <Overview data={data} />}
        {tab === "repositories" && <Repositories data={data} />}
        {tab === "stars" &&
          (data.stars.length ? (
            <ul className="card list" aria-label="Starred repositories">
              {data.stars.map((r) => (
                <li key={`${r.owner}/${r.name}`} className="repo-row">
                  <div className="stack-sm" style={{ gap: 4 }}>
                    <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
                      <BookLock size={16} aria-hidden className="muted" />
                      {r.owner}/{r.name}
                    </Link>
                    {r.description && <span className="muted">{r.description}</span>}
                  </div>
                </li>
              ))}
            </ul>
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

function RepoTile({ r }: { r: RepoCard }) {
  return (
    <li className="repo-tile">
      <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
        <BookLock size={16} aria-hidden className="muted" />
        {r.owner}/{r.name}
      </Link>
      <span className="pill">Private</span>
      <p className="muted">{r.description || "No description."}</p>
    </li>
  );
}

function Overview({ data }: { data: ProfileData }) {
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
      <section className="stack-sm">
        <h2 className="section-title">Pinned</h2>
        {data.pinned.length ? (
          <ul className="repo-grid" aria-label="Pinned repositories">
            {data.pinned.map((r) => (
              <RepoTile key={`${r.owner}/${r.name}`} r={r} />
            ))}
          </ul>
        ) : (
          <p className="muted">{data.isSelf ? "Pin up to six repositories in Settings to show them here." : "Nothing pinned yet."}</p>
        )}
      </section>
      <section className="stack-sm">
        <h2 className="section-title">{plural(data.contributions.total, "contribution")} in the last year</h2>
        <div className="card body calendar">
          <Contributions days={data.contributions.days} />
        </div>
        {data.isSelf && !data.hasCommitEmails ? (
          <p className="notice" style={{ margin: 0 }}>
            Your commits aren't counted yet because Ether doesn't know which email you commit with. <Link to="/settings">Add your commit email</Link>{" "}
            (the one in <code>git config user.email</code>).
          </p>
        ) : (
          <p className="hint">Commits from the commit emails set in Settings, plus issues, pull requests and comments, in repositories you can see.</p>
        )}
      </section>
      <section className="stack-sm">
        <h2 className="section-title">Recent activity</h2>
        {data.activity.length ? (
          <ol className="timeline-list" aria-label="Recent activity">
            {data.activity.map((e, i) => (
              <ActivityRow key={i} e={e} />
            ))}
          </ol>
        ) : (
          <p className="muted">No recent activity you can see.</p>
        )}
      </section>
    </>
  );
}

const LEVELS = ["var(--surface-3)", "color-mix(in srgb, var(--accent) 30%, var(--surface-3))", "color-mix(in srgb, var(--accent) 55%, var(--surface-3))", "color-mix(in srgb, var(--accent) 80%, var(--surface-3))", "var(--accent)"];

function Contributions({ days }: { days: { date: string; count: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const data: Day[] = days.map((d) => ({ ...d, level: d.count === 0 ? 0 : Math.min(4, Math.ceil((d.count / max) * 4)) }));
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
        cloneElement(block, { style: { ...block.props.style, fill: LEVELS[a.level] } }, <title>{`${plural(a.count, "contribution")} on ${a.date}`}</title>)
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

function ActivityRow({ e }: { e: Event }) {
  const Icon = e.kind === "merged" ? GitMerge : e.kind === "opened-pull" ? GitPullRequest : e.kind === "commented" ? MessageSquare : CircleDot;
  const verb = { "opened-issue": "Opened issue", "opened-pull": "Opened pull request", commented: "Commented on", merged: "Merged" }[e.kind];
  const params = { owner: e.owner, repo: e.repo, number: String(e.number) };
  const isPull = e.kind === "opened-pull" || e.kind === "merged";
  return (
    <li>
      <Icon size={16} aria-hidden className="muted" />
      <span className="timeline-text">
        {verb}{" "}
        {isPull ? (
          <Link to="/$owner/$repo/pull/$number" params={params}>
            {e.title}
          </Link>
        ) : (
          <Link to="/$owner/$repo/issues/$number" params={params}>
            {e.title}
          </Link>
        )}{" "}
        <span className="muted">
          in {e.owner}/{e.repo}
        </span>
      </span>
      <span className="muted timeline-when">{timeAgo(e.at)}</span>
    </li>
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
        <ul className="card list" aria-label="Repositories">
          {shown.map((r) => (
            <li key={r.name} className="repo-row">
              <div className="stack-sm" style={{ gap: 4 }}>
                <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
                  <BookLock size={16} aria-hidden className="muted" />
                  {r.name}
                </Link>
                {r.description && <span className="muted">{r.description}</span>}
                <span className="muted hint">Created {timeAgo(r.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
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
        <ul className="card list" aria-label={title}>
          {people.map((p) => (
            <li key={p.username}>
              <Avatar name={p.username} size={40} />
              <div>
                {p.displayName && <strong>{p.displayName} </strong>}
                <Link to="/$owner" params={{ owner: p.username }}>
                  {p.username}
                </Link>
              </div>
            </li>
          ))}
        </ul>
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
  return (
    <main className="page stack">
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
      <nav className="tabs" aria-label="Organization sections">
        <Link to="/$owner" params={{ owner }} search={{}} className={current === "repositories" ? "active" : ""} activeOptions={{ includeSearch: true }}>
          Repositories<span className="count">{data.repos.length}</span>
        </Link>
        <Link to="/$owner" params={{ owner }} search={{ tab: "followers" }} className={current === "followers" ? "active" : ""} activeOptions={{ includeSearch: true }}>
          People<span className="count">{data.members.length}</span>
        </Link>
      </nav>
      {current === "repositories" ? <Repositories data={{ ...data, isSelf: data.viewerOrgRole === "owner" }} /> : <PeopleList title="People" people={data.members} />}
    </main>
  );
}
