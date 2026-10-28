import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ReleaseCard, type Release } from "../components/releases";
import { ErrorNote, useAction } from "../components/ui";
import { api, del, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/releases/tag/$tag")({
  loader: ({ context: { info }, params }) => api<{ release: Release }>(`${repoApi(info.repo.owner, info.repo.name)}/releases/${encodeURIComponent(params.tag)}`),
  component: ReleasePage,
});

function ReleasePage() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { release } = Route.useLoaderData();
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const [confirm, setConfirm] = useState(false);
  const remove = useAction(async () => {
    await del(`${repoApi(info.repo.owner, info.repo.name)}/releases/${encodeURIComponent(release.tag)}`);
    await router.navigate({ to: "/$owner/$repo/releases", params });
  });
  return (
    <div className="stack-md max-w-[900px]">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/$owner/$repo/releases" params={params}>
          ← All releases
        </Link>
        <span className="flex-1" />
        {info.role !== "read" &&
          (confirm ? (
            <>
              <span className="text-muted">Delete this release? The tag stays.</span>
              <button className="danger small" onClick={() => remove.run()}>
                Delete
              </button>
              <button className="small" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="danger small" onClick={() => setConfirm(true)}>
              Delete release
            </button>
          ))}
      </div>
      <ErrorNote error={remove.error} />
      <ReleaseCard info={info} release={release} headingLevel={1} />
    </div>
  );
}
