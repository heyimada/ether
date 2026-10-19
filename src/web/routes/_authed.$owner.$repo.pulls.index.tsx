import { createFileRoute } from "@tanstack/react-router";
import { IssueList } from "../components/conversation";
import { api, repoApi, type Issue } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/pulls/")({
  validateSearch: (s: Record<string, unknown>): { state?: "open" | "closed" } => ({ state: s.state === "closed" ? "closed" : undefined }),
  loaderDeps: ({ search }) => search,
  loader: ({ context: { info }, deps }) =>
    api<{ items: Issue[]; open: number; closed: number }>(`${repoApi(info.repo.owner, info.repo.name)}/pulls?state=${deps.state ?? "open"}`),
  component: Pulls,
});

function Pulls() {
  const { info } = Route.useRouteContext();
  const { state } = Route.useSearch();
  return <IssueList info={info} kind="pulls" data={Route.useLoaderData()} state={state ?? "open"} />;
}
