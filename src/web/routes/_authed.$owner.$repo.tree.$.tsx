import { createFileRoute } from "@tanstack/react-router";
import { TreeView, loadTree } from "../components/code-browser";
import { splitRefPath } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/tree/$")({
  loader: async ({ context: { info }, params }) => {
    const { ref, path } = splitRefPath(params._splat ?? info.repo.defaultBranch, info);
    return { ref, data: await loadTree(info, ref, path) };
  },
  component: Tree,
});

function Tree() {
  const { info } = Route.useRouteContext();
  const { ref, data } = Route.useLoaderData();
  return <TreeView info={info} gitRef={ref} data={data} />;
}
