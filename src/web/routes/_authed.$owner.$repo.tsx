import { Link, Outlet, createFileRoute, redirect, useRouteContext, useRouter } from "@tanstack/react-router";
import { Star as StarIcon } from "lucide-react";
import { useAction } from "../components/ui";
import { ApiError, api, del, put, repoApi, type Issue, type RepoInfo } from "../lib/api";

type Counts = { open: number; items: Issue[] };

export const Route = createFileRoute("/_authed/$owner/$repo")({
  beforeLoad: async ({ params, location }) => {
    const base = repoApi(params.owner, params.repo);
    const [info, issues, pulls] = await Promise.all([
      api<RepoInfo>(base),
      api<Counts>(`${base}/issues`),
      api<Counts>(`${base}/pulls`),
    ]).catch((e) => {
      // A visitor asking for something only accounts can see.
      if (e instanceof ApiError && e.status === 401) throw redirect({ to: "/login", search: { next: location.href } });
      throw e;
    });
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
        <span className="spacer" />
        <StarButton info={info} />
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

function StarButton({ info }: { info: RepoInfo }) {
  const router = useRouter();
  const { me } = useRouteContext({ from: "/_authed" });
  const toggle = useAction(async () => {
    const url = `${repoApi(info.repo.owner, info.repo.name)}/star`;
    await (info.starred ? del(url) : put(url, {}));
    await router.invalidate();
  });
  if (!me)
    return (
      <span className="pill" title="Stars">
        <StarIcon size={14} aria-hidden /> {info.stars}
      </span>
    );
  return (
    <button className="star-button" onClick={() => toggle.run()} disabled={toggle.pending} aria-pressed={info.starred}>
      <StarIcon size={16} aria-hidden fill={info.starred ? "currentColor" : "none"} className={info.starred ? "starred" : ""} />
      {info.starred ? "Unstar" : "Star"}
      <span className="count">{info.stars}</span>
    </button>
  );
}
