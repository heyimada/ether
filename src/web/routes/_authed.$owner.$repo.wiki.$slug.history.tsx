import { Link, createFileRoute } from "@tanstack/react-router";
import { api, repoApi, shortSha, timeAgo, type Commit } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/wiki/$slug/history")({
  loader: ({ context: { info }, params }) =>
    api<{ slug: string; title: string; revisions: Commit[] }>(`${repoApi(info.repo.owner, info.repo.name)}/wiki/${encodeURIComponent(params.slug)}/history`),
  component: History,
});

function History() {
  const { info } = Route.useRouteContext();
  const data = Route.useLoaderData();
  return (
    <div className="stack-md" style={{ maxWidth: 900 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>History of {data.title}</h2>
        <span className="spacer" />
        <Link to="/$owner/$repo/wiki/$slug" params={{ owner: info.repo.owner, repo: info.repo.name, slug: data.slug }}>
          Back to the page
        </Link>
      </div>
      <ul className="card list" aria-label="Revisions">
        {data.revisions.map((c) => (
          <li key={c.sha}>
            <div>
              <strong>{c.subject}</strong>
              <div className="muted">
                {c.author} · {timeAgo(c.date)}
              </div>
            </div>
            <span className="spacer" />
            <code className="muted">{shortSha(c.sha)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
