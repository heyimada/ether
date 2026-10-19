import { createFileRoute, redirect } from "@tanstack/react-router";
import { Conversation, IssueHeader } from "../components/conversation";
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
    <div style={{ maxWidth: 900 }}>
      <IssueHeader issue={issue} />
      <Conversation info={info} issue={issue} comments={comments} me={me?.username ?? null} />
    </div>
  );
}
