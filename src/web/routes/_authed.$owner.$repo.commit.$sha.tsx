import { Link, createFileRoute } from "@tanstack/react-router";
import { DiffView } from "../components/content";
import { api, repoApi, shortSha, timeAgo, type Commit } from "../lib/api";

const SETUP = "overflow-x-auto rounded-sm border border-border bg-surface-2 p-3";

export const Route = createFileRoute("/_authed/$owner/$repo/commit/$sha")({
  loader: ({ context: { info }, params }) =>
    api<{ commit: Commit; diff: string; truncated: boolean }>(`${repoApi(info.repo.owner, info.repo.name)}/commit/${params.sha}`),
  component: CommitPage,
});

function CommitPage() {
  const { info } = Route.useRouteContext();
  const { commit, diff, truncated } = Route.useLoaderData();
  const params = { owner: info.repo.owner, repo: info.repo.name };
  return (
    <div>
      <section className="card mb-6">
        <div className="body">
          <h2>{commit.subject}</h2>
          {commit.body && <pre className={SETUP}>{commit.body}</pre>}
          <div className="flex flex-wrap items-center gap-3 text-muted">
            <strong>{commit.author}</strong> committed {timeAgo(commit.date)}
            <span className="flex-1" />
            {commit.parents.map((p) => (
              <span key={p}>
                parent{" "}
                <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: p }}>
                  <code>{shortSha(p)}</code>
                </Link>
              </span>
            ))}
            <span>
              commit <code>{shortSha(commit.sha)}</code>
            </span>
            <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: commit.sha }} className="button">
              Browse files
            </Link>
          </div>
        </div>
      </section>
      <DiffView diff={diff} truncated={truncated} />
    </div>
  );
}
