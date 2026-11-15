import { createFileRoute } from "@tanstack/react-router";
import { ActivityStrip, CommitSparkline, Contributors, LanguageBar, RecentCommits, loadActivity, loadLanguages, loadRecentCommits } from "../components/activity";
import { QuickSetup, TreeView, loadTree } from "../components/code-browser";
import { DeploymentsSide, type EnvironmentInfo } from "../components/environments";
import type { Release } from "../components/releases";
import { api, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/")({
  loader: async ({ context: { info } }) => {
    if (info.repo.empty) return null;
    const [tree, activity, { releases }, languages, commits, { environments }] = await Promise.all([
      loadTree(info, info.repo.defaultBranch, ""),
      loadActivity(info),
      api<{ releases: Release[] }>(`${repoApi(info.repo.owner, info.repo.name)}/releases`),
      loadLanguages(info),
      loadRecentCommits(info),
      api<{ environments: EnvironmentInfo[] }>(`${repoApi(info.repo.owner, info.repo.name)}/environments`),
    ]);
    return { tree, activity, releases, languages, commits, environments };
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
          <DeploymentsSide owner={info.repo.owner} repo={info.repo.name} environments={data.environments} />
          <LanguageBar languages={data.languages} />
          <CommitSparkline activity={data.activity} />
          <RecentCommits info={info} commits={data.commits} />
          <Contributors activity={data.activity} />
        </>
      }
    />
  );
}
