import { createFileRoute } from "@tanstack/react-router";
import { ActivityStrip, CommitSparkline, Contributors, loadActivity } from "../components/activity";
import { QuickSetup, TreeView, loadTree } from "../components/code-browser";
import type { Release } from "../components/releases";
import { api, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/")({
  loader: async ({ context: { info } }) => {
    if (info.repo.empty) return null;
    const [tree, activity, { releases }] = await Promise.all([
      loadTree(info, info.repo.defaultBranch, ""),
      loadActivity(info),
      api<{ releases: Release[] }>(`${repoApi(info.repo.owner, info.repo.name)}/releases`),
    ]);
    return { tree, activity, releases };
  },
  component: RepoHome,
});

function RepoHome() {
  const { info, counts, latest } = Route.useRouteContext();
  const data = Route.useLoaderData();
  if (!data) return <QuickSetup info={info} />;
  return (
    <TreeView
      info={info}
      gitRef={info.repo.defaultBranch}
      data={data.tree}
      releases={data.releases}
      top={<ActivityStrip info={info} open={counts} latest={latest} activity={data.activity} />}
      side={
        <>
          <CommitSparkline activity={data.activity} />
          <Contributors activity={data.activity} />
        </>
      }
    />
  );
}
