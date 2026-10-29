import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import type { WikiPage } from "../components/wiki";
import { api, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/wiki/")({
  loader: async ({ context: { info }, params }) => {
    const { pages } = await api<{ pages: WikiPage[] }>(`${repoApi(info.repo.owner, info.repo.name)}/wiki`);
    const start = pages.find((p) => p.slug === "Home") ?? pages[0];
    if (start) throw redirect({ to: "/$owner/$repo/wiki/$slug", params: { ...params, slug: start.slug } });
    return null;
  },
  component: EmptyWiki,
});

function EmptyWiki() {
  const { info } = Route.useRouteContext();
  return (
    <section className="card empty stack-sm items-center">
      <strong>This wiki has no pages yet.</strong>
      <span className="text-muted">Wikis hold longer documentation: guides, decisions, how-tos.</span>
      {info.role !== "read" && (
        <Link to="/$owner/$repo/wiki/new" params={{ owner: info.repo.owner, repo: info.repo.name }} search={{ title: "Home" }} className="button primary">
          Create the first page
        </Link>
      )}
    </section>
  );
}
