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
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.invalidate(), 2000);
    return () => clearInterval(t);
  }, [active, router]);

  return (
    <div className="stack-md" style={{ maxWidth: 900 }}>
      <h2 style={{ margin: 0 }}>CI runs</h2>
      {!enabled && (
        <p className="notice" style={{ margin: 0 }}>
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
              <div style={{ minWidth: 0 }}>
                <Link to="/$owner/$repo/ci/$id" params={{ ...params, id: String(r.id) }} style={{ fontWeight: 600 }}>
                  {r.subject || shortSha(r.sha)}
                </Link>
                <div className="muted">
                  #{r.id} · <code>{r.ref}</code> · <code>{shortSha(r.sha)}</code> · {timeAgo(r.createdAt)}
                  {r.message && ` · ${r.message}`}
                </div>
              </div>
              <span className="spacer" />
              <span className="muted num">{r.jobs.filter((j) => j.status === "success").length}/{r.jobs.length} jobs passed</span>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}
