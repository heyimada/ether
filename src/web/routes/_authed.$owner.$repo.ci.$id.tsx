import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { CiBadge, ciDone, type CiStatus } from "../components/ci";
import { ErrorNote, useAction } from "../components/ui";
import { api, post, repoApi, shortSha, timeAgo } from "../lib/api";

type Job = { id: number; name: string; status: CiStatus; log: string; steps: { name: string }[]; startedAt: string | null; finishedAt: string | null };
type RunDetail = { run: { id: number; sha: string; ref: string; status: CiStatus; message: string; subject: string; createdAt: string }; jobs: Job[] };

export const Route = createFileRoute("/_authed/$owner/$repo/ci/$id")({
  loader: ({ context: { info }, params }) => api<RunDetail>(`${repoApi(info.repo.owner, info.repo.name)}/ci/runs/${params.id}`),
  component: RunPage,
});

const duration = (a: string | null, b: string | null) => (a && b ? `${((new Date(b).getTime() - new Date(a).getTime()) / 1000).toFixed(1)}s` : "");

function RunPage() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { run, jobs } = Route.useLoaderData();
  const base = `${repoApi(info.repo.owner, info.repo.name)}/ci/runs/${run.id}`;
  const params = { owner: info.repo.owner, repo: info.repo.name };
  useEffect(() => {
    if (ciDone(run.status)) return;
    const t = setInterval(() => router.invalidate(), 1500);
    return () => clearInterval(t);
  }, [run.status, router]);
  const act = useAction(async (what: "rerun" | "cancel") => {
    const res = await post<{ run?: { id: number } }>(`${base}/${what}`);
    if (res.run) await router.navigate({ to: "/$owner/$repo/ci/$id", params: { ...params, id: String(res.run.id) } });
    else await router.invalidate();
  });

  return (
    <div className="stack-md" style={{ maxWidth: 1000 }}>
      <div className="row">
        <Link to="/$owner/$repo/ci" params={params}>
          ← All runs
        </Link>
        <span className="spacer" />
        {info.role !== "read" &&
          (ciDone(run.status) ? (
            <button className="small" onClick={() => act.run("rerun")} disabled={act.pending}>
              Re-run
            </button>
          ) : (
            <button className="danger small" onClick={() => act.run("cancel")} disabled={act.pending}>
              Cancel run
            </button>
          ))}
      </div>
      <ErrorNote error={act.error} />
      <div className="row">
        <h2 style={{ margin: 0 }}>{run.subject || shortSha(run.sha)}</h2>
        <CiBadge status={run.status} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Run #{run.id} on <code>{run.ref}</code> at{" "}
        <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: run.sha }}>
          <code>{shortSha(run.sha)}</code>
        </Link>{" "}
        · {timeAgo(run.createdAt)}
      </p>
      {run.message && <p className="error">{run.message}</p>}
      {jobs.map((j) => (
        <section key={j.id} className="card" aria-labelledby={`job-${j.id}`}>
          <header>
            <h3 id={`job-${j.id}`} style={{ margin: 0 }}>
              <span className="sr-only">Job </span>
              {j.name}
            </h3>
            <CiBadge status={j.status} />
            <span className="spacer" />
            <span className="muted num">{duration(j.startedAt, j.finishedAt)}</span>
          </header>
          <pre className="ci-log" role="log" aria-label={`${j.name} log`}>
            {j.log || (j.status === "queued" ? "Waiting for a runner…" : "")}
          </pre>
        </section>
      ))}
    </div>
  );
}
