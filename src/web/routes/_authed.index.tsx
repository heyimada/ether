import { Link, createFileRoute } from "@tanstack/react-router";
import { BookLock, Building2, ChevronRight, Globe, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { Avatar } from "../components/ui";
import { api } from "../lib/api";
import { rise, staggered } from "../lib/motion";

type RepoRow = { owner: string; name: string; description: string; visibility: "private" | "public"; relation: "owner" | "org" | "collaborator" | "public" };
type OrgRow = { name: string; role: "owner" | "member" };
type ReviewRow = { owner: string; repo: string; number: number; title: string };

export const Route = createFileRoute("/_authed/")({
  loader: async ({ context: { me } }) => {
    const [{ repos }, { orgs }, { pulls }] = await Promise.all([
      api<{ repos: RepoRow[] }>("/api/repos"),
      me ? api<{ orgs: OrgRow[] }>("/api/me/orgs") : Promise.resolve({ orgs: [] as OrgRow[] }),
      me ? api<{ pulls: ReviewRow[] }>("/api/me/review-requests") : Promise.resolve({ pulls: [] as ReviewRow[] }),
    ]);
    return { repos, orgs, reviews: pulls };
  },
  component: Dashboard,
});

function Dashboard() {
  const { repos, orgs, reviews } = Route.useLoaderData();
  const { me } = Route.useRouteContext();
  const by = (relation: RepoRow["relation"]) => repos.filter((r) => r.relation === relation);
  if (!me)
    return (
      <main className="page stack">
        <div className="row page-head">
          <h1 style={{ margin: 0 }}>Public repositories</h1>
          <span className="spacer" />
          <Link to="/login" className="button primary small">
            Sign in
          </Link>
        </div>
        <RepoSection title="Public repositories" repos={by("public")} empty="Nothing public yet." />
      </main>
    );
  return (
    <main className="page stack">
      <div className="row page-head">
        <h1 style={{ margin: 0 }}>Welcome, {me.username}</h1>
        <span className="spacer" />
        <Link to="/organizations/new" className="button small">
          <Building2 size={16} aria-hidden /> New organization
        </Link>
      </div>
      {reviews.length > 0 && (
        <section className="card" aria-labelledby="waiting-review">
          <header>
            <h2 id="waiting-review" style={{ margin: 0 }}>
              Waiting for your review
            </h2>
          </header>
          <motion.ul className="list" {...staggered}>
            {reviews.map((p, i) => (
              <motion.li key={`${p.owner}/${p.repo}#${p.number}`} variants={rise} custom={i}>
                <Link to="/$owner/$repo/pull/$number" params={{ owner: p.owner, repo: p.repo, number: String(p.number) }}>
                  {p.title}
                </Link>
                <span className="muted">
                  {p.owner}/{p.repo}#{p.number}
                </span>
              </motion.li>
            ))}
          </motion.ul>
        </section>
      )}
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
        <motion.ul className="list" {...staggered}>
          {repos.map((r, i) => (
            <motion.li key={`${r.owner}/${r.name}`} className="repo-row" variants={rise} custom={i}>
              <div className="repo-row-main">
                <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="repo-link">
                  {r.visibility === "public" ? <Globe size={16} aria-hidden className="muted" /> : <BookLock size={16} aria-hidden className="muted" />}
                  {r.owner}/{r.name}
                </Link>
                {r.description && <div className="muted">{r.description}</div>}
              </div>
              <span className="spacer" />
              <span className="pill">{r.visibility === "public" ? "Public" : "Private"}</span>
              <ChevronRight size={16} aria-hidden className="row-chevron" />
            </motion.li>
          ))}
        </motion.ul>
      )}
    </section>
  );
}
