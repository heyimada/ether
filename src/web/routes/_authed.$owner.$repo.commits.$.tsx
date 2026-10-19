import { Link, createFileRoute } from "@tanstack/react-router";
import { RefPicker } from "../components/code-browser";
import { api, repoApi, shortSha, splitRefPath, timeAgo, type Commit } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/commits/$")({
  validateSearch: (s: Record<string, unknown>): { path?: string; page?: number } => ({
    path: typeof s.path === "string" ? s.path : undefined,
    page: typeof s.page === "number" ? s.page : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { info }, params, deps }) => {
    const ref = splitRefPath(params._splat || info.repo.defaultBranch, info).ref;
    const q = new URLSearchParams({ ref, path: deps.path ?? "", page: String(deps.page ?? 0) });
    const res = await api<{ commits: Commit[]; hasMore: boolean }>(`${repoApi(info.repo.owner, info.repo.name)}/commits?${q}`);
    return { ref, ...res };
  },
  component: Commits,
});

function Commits() {
  const { info } = Route.useRouteContext();
  const { ref, commits, hasMore } = Route.useLoaderData();
  const { path, page = 0 } = Route.useSearch();
  const params = { owner: info.repo.owner, repo: info.repo.name };
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <RefPicker info={info} current={ref} kind="commits" />
        <h2 style={{ margin: 0 }}>Commits{path ? ` to ${path}` : ""}</h2>
      </div>
      <section className="card">
        {commits.length === 0 ? (
          <p className="empty">No commits.</p>
        ) : (
          <ul className="list">
            {commits.map((c) => (
              <li key={c.sha}>
                <div>
                  <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: c.sha }}>
                    {c.subject}
                  </Link>
                  <div className="muted">
                    {c.author} committed {timeAgo(c.date)}
                  </div>
                </div>
                <span className="spacer" />
                <code className="muted">{shortSha(c.sha)}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="row" style={{ marginTop: 12 }}>
        {page > 0 && (
          <Link to="." search={{ path, page: page - 1 }} className="button">
            Newer
          </Link>
        )}
        {hasMore && (
          <Link to="." search={{ path, page: page + 1 }} className="button">
            Older
          </Link>
        )}
      </div>
    </div>
  );
}
