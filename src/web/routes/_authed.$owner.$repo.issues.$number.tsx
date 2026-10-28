import { createFileRoute, redirect } from "@tanstack/react-router";
import { Conversation, IssueHeader } from "../components/conversation";
import { IssueSidebar } from "../components/labels";
import { api, repoApi, type Comment, type Issue } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/issues/$number")({
  loader: async ({ context: { info }, params }) => {
    const data = await api<{ issue: Issue; comments: Comment[] }>(`${repoApi(info.repo.owner, info.repo.name)}/issues/${params.number}`);
    if (data.issue.isPull) throw redirect({ to: "/$owner/$repo/pull/$number", params });
    return data;
  },
  component: IssuePage,
});

function IssuePage() {
  const { info, me } = Route.useRouteContext();
  const { issue, comments } = Route.useLoaderData();
  return (
    <div>
      <IssueHeader issue={issue} />
      <div className="grid grid-cols-[minmax(0,1fr)_240px] items-start gap-6 max-lg:grid-cols-[minmax(0,1fr)]">
        <Conversation info={info} issue={issue} comments={comments} me={me?.username ?? null} />
        <IssueSidebar info={info} issue={issue} />
      </div>
    </div>
  );
}
