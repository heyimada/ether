import { createFileRoute } from "@tanstack/react-router";
import { IssueList } from "../components/conversation";
import { api, repoApi, type Issue } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/issues/")({
  validateSearch: (s: Record<string, unknown>): { state?: "open" | "closed"; label?: string; assignee?: string } => ({
    state: s.state === "closed" ? "closed" : undefined,
    label: typeof s.label === "string" ? s.label : undefined,
    assignee: typeof s.assignee === "string" ? s.assignee : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context: { info }, deps }) => {
    const q = new URLSearchParams({ state: deps.state ?? "open" });
    if (deps.label) q.set("label", deps.label);
    if (deps.assignee) q.set("assignee", deps.assignee);
    return api<{ items: Issue[]; open: number; closed: number }>(`${repoApi(info.repo.owner, info.repo.name)}/issues?${q}`);
  },
  component: Issues,
});

function Issues() {
  const { info } = Route.useRouteContext();
  const { state, label, assignee } = Route.useSearch();
  return <IssueList info={info} kind="issues" data={Route.useLoaderData()} state={state ?? "open"} filter={{ label, assignee }} />;
}
