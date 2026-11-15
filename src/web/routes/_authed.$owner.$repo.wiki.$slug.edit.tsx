import { createFileRoute, redirect } from "@tanstack/react-router";
import { WikiEditor } from "../components/wiki";
import { api, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/wiki/$slug/edit")({
  beforeLoad: ({ context, params }) => {
    if (context.info.role === "read") throw redirect({ to: "/$owner/$repo/wiki/$slug", params });
  },
  loader: ({ context: { info }, params }) =>
    api<{ slug: string; title: string; content: string }>(`${repoApi(info.repo.owner, info.repo.name)}/wiki/${encodeURIComponent(params.slug)}`),
  component: EditPage,
});

function EditPage() {
  const { info } = Route.useRouteContext();
  const page = Route.useLoaderData();
  return (
    <div className="stack-md max-w-[900px]">
      <h2 className="m-0">Editing {page.title}</h2>
      <WikiEditor info={info} slug={page.slug} initial={{ title: page.title, content: page.content }} />
    </div>
  );
}
