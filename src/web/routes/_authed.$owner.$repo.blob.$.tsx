import { createFileRoute } from "@tanstack/react-router";
import { BlobView, type BlobData } from "../components/code-browser";
import { api, repoApi, splitRefPath } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/blob/$")({
  loader: async ({ context: { info }, params }) => {
    const { ref, path } = splitRefPath(params._splat ?? "", info);
    const data = await api<BlobData>(`${repoApi(info.repo.owner, info.repo.name)}/blob?${new URLSearchParams({ ref, path })}`);
    return { ref, data };
  },
  component: Blob,
});

function Blob() {
  const { info } = Route.useRouteContext();
  const { ref, data } = Route.useLoaderData();
  return <BlobView info={info} gitRef={ref} data={data} />;
}
