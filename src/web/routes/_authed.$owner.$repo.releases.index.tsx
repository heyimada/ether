import { Link, createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { ReleaseCard, type Release } from "../components/releases";
import { api, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/releases/")({
  loader: ({ context: { info } }) => api<{ releases: Release[] }>(`${repoApi(info.repo.owner, info.repo.name)}/releases`),
  component: Releases,
});

function Releases() {
  const { info } = Route.useRouteContext();
  const { releases } = Route.useLoaderData();
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const latest = releases.find((r) => !r.prerelease)?.tag;
  return (
    <div className="stack-md max-w-[900px]">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0">Releases</h2>
        <span className="flex-1" />
        {info.role !== "read" && (
          <Link to="/$owner/$repo/releases/new" params={params} className="button primary small">
            <Plus size={16} aria-hidden /> Create a release
          </Link>
        )}
      </div>
      {releases.length === 0 ? (
        <p className="empty card">No releases yet.</p>
      ) : (
        releases.map((r) => <ReleaseCard key={r.tag} info={info} release={r} latest={r.tag === latest} />)
      )}
    </div>
  );
}
