import { Link, createFileRoute } from "@tanstack/react-router";
import { WikiContent, WikiSidebar, type WikiPage } from "../components/wiki";
import { api, repoApi, timeAgo, type Commit } from "../lib/api";

type Page = { slug: string; title: string; content: string; lastEdit: Commit | null; revisions: number; pages: WikiPage[] };

export const Route = createFileRoute("/_authed/$owner/$repo/wiki/$slug/")({
  loader: ({ context: { info }, params }) => api<Page>(`${repoApi(info.repo.owner, info.repo.name)}/wiki/${encodeURIComponent(params.slug)}`),
  component: WikiPageView,
});

function WikiPageView() {
  const { info } = Route.useRouteContext();
  const page = Route.useLoaderData();
  const params = { owner: info.repo.owner, repo: info.repo.name, slug: page.slug };
  return (
    <div className="grid grid-cols-[1fr_260px] gap-6 max-lg:grid-cols-[1fr]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="m-0">{page.title}</h2>
          <span className="flex-1" />
          {info.role !== "read" && (
            <Link to="/$owner/$repo/wiki/$slug/edit" params={params} className="button small">
              Edit page
            </Link>
          )}
        </div>
        <p className="text-muted m-0">
          {page.lastEdit && (
            <>
              {page.lastEdit.author} edited this {timeAgo(page.lastEdit.date)} ·{" "}
            </>
          )}
          <Link to="/$owner/$repo/wiki/$slug/history" params={params}>
            {page.revisions} {page.revisions === 1 ? "revision" : "revisions"}
          </Link>
        </p>
        <section className="card">
          <WikiContent info={info} source={page.content} pages={page.pages} title={page.title} />
        </section>
      </div>
      <WikiSidebar info={info} pages={page.pages} current={page.slug} />
    </div>
  );
}
