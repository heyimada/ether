import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { api, repoApi, type Issue, type RepoInfo } from "../lib/api";

type Counts = { open: number; items: Issue[] };

export const Route = createFileRoute("/_authed/$owner/$repo")({
  beforeLoad: async ({ params }) => {
    const base = repoApi(params.owner, params.repo);
    const [info, issues, pulls] = await Promise.all([
      api<RepoInfo>(base),
      api<Counts>(`${base}/issues`),
      api<Counts>(`${base}/pulls`),
    ]);
    return { info, counts: { issues: issues.open, pulls: pulls.open }, latest: { issue: issues.items[0] ?? null, pull: pulls.items[0] ?? null } };
  },
  component: RepoLayout,
});

function RepoLayout() {
  const { info, counts } = Route.useRouteContext();
  const { owner, repo } = Route.useParams();
  const params = { owner, repo };
  return (
    <main className="page">
      <div className="repo-head">
        <span className="badge">{info.repo.visibility === "public" ? "Public" : "Private"}</span>
        <span>
          <Link to="/$owner" params={{ owner: info.repo.owner }} className="muted">
            {info.repo.owner}
          </Link>
          <span className="muted"> / </span>
          <Link to="/$owner/$repo" params={params}>
            {info.repo.name}
          </Link>
        </span>
      </div>
      {info.repo.description && <p className="muted" style={{ margin: 0 }}>{info.repo.description}</p>}
      <nav className="tabs" aria-label="Repository">
        <Link to="/$owner/$repo" params={params} activeOptions={{ exact: true }}>
          Code
        </Link>
        <Link to="/$owner/$repo/issues" params={params}>
          Issues<span className="count">{counts.issues}</span>
        </Link>
        <Link to="/$owner/$repo/pulls" params={params}>
          Pull requests<span className="count">{counts.pulls}</span>
        </Link>
        {info.role === "owner" && (
          <Link to="/$owner/$repo/settings" params={params}>
            Settings
          </Link>
        )}
      </nav>
      <Outlet />
    </main>
  );
}
