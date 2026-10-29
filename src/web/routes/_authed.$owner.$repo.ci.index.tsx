import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useEffect } from "react";
import { CiBadge, ciDone, type CiStatus } from "../components/ci";
import { api, repoApi, shortSha, timeAgo } from "../lib/api";
import { rise, staggered } from "../lib/motion";

type Run = { id: number; sha: string; ref: string; status: CiStatus; message: string; subject: string; createdAt: string; jobs: { name: string; status: CiStatus }[] };

export const Route = createFileRoute("/_authed/$owner/$repo/ci/")({
  loader: ({ context: { info } }) => api<{ enabled: boolean; runs: Run[] }>(`${repoApi(info.repo.owner, info.repo.name)}/ci/runs`),
  component: Runs,
});

function Runs() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { enabled, runs } = Route.useLoaderData();
  const params = { owner: info.repo.owner, repo: info.repo.name };
  // Keep the list live while anything is still running.
  const active = runs.some((r) => !ciDone(r.status));
  // Runs that only wait for a deployment review can stay that way for hours, so check those less often.
  const busy = runs.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.invalidate(), busy ? 2000 : 10_000);
    return () => clearInterval(t);
  }, [active, busy, router]);

  return (
    <div className="stack-md max-w-[900px]">
      <h2 className="m-0">CI runs</h2>
      {!enabled && (
        <p className="notice m-0">
          CI is off for this repository.{" "}
          {info.role === "owner" ? (
            <>
              Turn it on in <Link to="/$owner/$repo/settings" params={params}>Settings</Link>, then push a <code>.ether/ci.yml</code>.
            </>
          ) : (
            "An owner can turn it on in the repository settings."
          )}
        </p>
      )}
      {runs.length === 0 ? (
        <p className="empty card">No runs yet.</p>
      ) : (
        <motion.ul className="card list" aria-label="CI runs" {...staggered}>
          {runs.map((r, i) => (
            <motion.li key={r.id} variants={rise} custom={i}>
              <CiBadge status={r.status} />
              <div className="min-w-0">
                <Link className="font-semibold" to="/$owner/$repo/ci/$id" params={{ ...params, id: String(r.id) }}>
                  {r.subject || shortSha(r.sha)}
                </Link>
                <div className="text-muted">
                  #{r.id} · <code>{r.ref}</code> · <code>{shortSha(r.sha)}</code> · {timeAgo(r.createdAt)}
                  {r.message && ` · ${r.message}`}
                </div>
              </div>
              <span className="flex-1" />
              <span className="text-muted tabular-nums">{r.jobs.filter((j) => j.status === "success").length}/{r.jobs.length} jobs passed</span>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}
