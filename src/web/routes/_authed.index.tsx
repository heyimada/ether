import { Link, createFileRoute } from "@tanstack/react-router";
import { BookLock, Building2, Globe, Plus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Avatar } from "../components/ui";
import { api } from "../lib/api";

type RepoRow = { owner: string; name: string; description: string; visibility: "private" | "public"; relation: "owner" | "org" | "collaborator" | "public" };
type OrgRow = { name: string; role: "owner" | "member" };

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [{ repos }, { orgs }] = await Promise.all([api<{ repos: RepoRow[] }>("/api/repos"), api<{ orgs: OrgRow[] }>("/api/me/orgs")]);
    return { repos, orgs };
  },
  component: Dashboard,
});

function Dashboard() {
  const { repos, orgs } = Route.useLoaderData();
  const { me } = Route.useRouteContext();
  const by = (relation: RepoRow["relation"]) => repos.filter((r) => r.relation === relation);
  return (
    <main className="page stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>Welcome, {me.username}</h1>
        <span className="spacer" />
        <Link to="/organizations/new" className="button small">
          <Building2 size={16} aria-hidden /> New organization
        </Link>
      </div>
      <RepoSection
        title="Your repositories"
        repos={by("owner")}
        empty="You don’t have any repositories yet."
        action={
          <Link to="/new" className="button primary small">
            <Plus size={16} aria-hidden /> New repository
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
          empty={o.role === "owner" ? "No repositories in this organization yet." : "No repositories you can see yet."}
        />
      ))}
      <RepoSection title="Shared with you" repos={by("collaborator")} empty="Nobody has added you to a repository yet." />
      <RepoSection title="Public repositories" repos={by("public")} empty="No public repositories from other people yet." />
    </main>
  );
}

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
  return (
    <section className="card" aria-labelledby={id}>
      <header>
        {icon}
        <h2 id={id} style={{ margin: 0 }}>
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
        <p className="empty">{empty}</p>
      ) : (
        <ul className="list">
          {repos.map((r) => (
            <li key={`${r.owner}/${r.name}`}>
              <div>
                <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
                  {r.visibility === "public" ? <Globe size={16} aria-hidden className="muted" /> : <BookLock size={16} aria-hidden className="muted" />}
                  {r.owner}/{r.name}
                </Link>
                {r.description && <div className="muted">{r.description}</div>}
              </div>
              <span className="spacer" />
              <span className="pill">{r.visibility === "public" ? "Public" : "Private"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
