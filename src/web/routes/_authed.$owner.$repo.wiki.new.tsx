import { createFileRoute, redirect } from "@tanstack/react-router";
import { WikiEditor } from "../components/wiki";

export const Route = createFileRoute("/_authed/$owner/$repo/wiki/new")({
  validateSearch: (s: Record<string, unknown>): { title?: string } => ({ title: typeof s.title === "string" ? s.title : undefined }),
  beforeLoad: ({ context, params }) => {
    if (context.info.role === "read") throw redirect({ to: "/$owner/$repo/wiki", params });
  },
  component: NewPage,
});

function NewPage() {
  const { info } = Route.useRouteContext();
  const { title } = Route.useSearch();
  return (
    <div className="stack-md" style={{ maxWidth: 900 }}>
      <h2 style={{ margin: 0 }}>New wiki page</h2>
      <WikiEditor info={info} initial={{ title: title ?? "", content: "" }} />
    </div>
  );
}
