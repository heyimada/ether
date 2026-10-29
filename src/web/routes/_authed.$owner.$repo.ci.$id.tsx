import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { CiBadge, ciDone, EVENT_LABEL, type CiEvent, type CiStatus } from "../components/ci";
import { ErrorNote, ROW, useAction } from "../components/ui";
import { api, post, repoApi, shortSha, timeAgo } from "../lib/api";

type JobDeployment = {
  environment: string;
  url: string | null;
  status: string;
  reviewers: string[];
  reviewedBy: string | null;
  notBefore: string | null;
  canReview: boolean;
};
type Job = { id: number; name: string; status: CiStatus; log: string; steps: { name: string }[]; startedAt: string | null; finishedAt: string | null; deployment: JobDeployment | null };
type RunDetail = {
  run: {
    id: number;
    sha: string;
    ref: string;
    refType: "branch" | "tag";
    workflowName: string;
    workflowPath: string;
    event: CiEvent;
    pullNumber: number | null;
    inputs: string;
    status: CiStatus;
    message: string;
    subject: string;
    createdAt: string;
  };
  jobs: Job[];
};

export const Route = createFileRoute("/_authed/$owner/$repo/ci/$id")({
  loader: ({ context: { info }, params }) => api<RunDetail>(`${repoApi(info.repo.owner, info.repo.name)}/ci/runs/${params.id}`),
  component: RunPage,
});

// A job's outcome colours its left edge. A running job keeps its class for the shimmer on its header (see styles.css).
const JOB_EDGE: Record<CiStatus, string> = {
  queued: "border-l-border",
  waiting: "border-l-border",
  running: "job-running border-l-accent",
  success: "border-l-open",
  failure: "border-l-danger",
  error: "border-l-danger",
  cancelled: "border-l-border",
  skipped: "border-l-border",
};

const duration = (a: string | null, b: string | null) => (a && b ? `${((new Date(b).getTime() - new Date(a).getTime()) / 1000).toFixed(1)}s` : "");

function RunPage() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { run, jobs } = Route.useLoaderData();
  const base = `${repoApi(info.repo.owner, info.repo.name)}/ci/runs/${run.id}`;
  const params = { owner: info.repo.owner, repo: info.repo.name };
  useEffect(() => {
    if (ciDone(run.status)) return;
    // A deployment can wait for a reviewer for hours, so check less often meanwhile.
    const t = setInterval(() => router.invalidate(), run.status === "waiting" ? 5000 : 1500);
    return () => clearInterval(t);
  }, [run.status, router]);
  const act = useAction(async (what: "rerun" | "cancel") => {
    const res = await post<{ run?: { id: number } }>(`${base}/${what}`);
    if (res.run) await router.navigate({ to: "/$owner/$repo/ci/$id", params: { ...params, id: String(res.run.id) } });
    else await router.invalidate();
  });

  return (
    <div className="stack-md max-w-[1000px]">
      <div className={ROW}>
        <Link to="/$owner/$repo/ci" params={params}>
          ← All runs
        </Link>
        <span className="flex-1" />
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
      <div className={ROW}>
        <h2 className="m-0">{run.subject || shortSha(run.sha)}</h2>
        <CiBadge status={run.status} />
      </div>
      <p className="text-muted m-0">
        <Link to="/$owner/$repo/ci" params={params} search={{ workflow: run.workflowPath }}>
          {run.workflowName}
        </Link>{" "}
        #{run.id} · {EVENT_LABEL[run.event]}
        {run.pullNumber !== null && (
          <>
            {" of "}
            <Link to="/$owner/$repo/pull/$number" params={{ ...params, number: String(run.pullNumber) }}>
              #{run.pullNumber}
            </Link>
          </>
        )}{" "}
        on {run.refType === "tag" ? "tag " : ""}
        <code>{run.ref}</code> at{" "}
        <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: run.sha }}>
          <code>{shortSha(run.sha)}</code>
        </Link>{" "}
        · {timeAgo(run.createdAt)}
      </p>
      {run.message && <p className="error">{run.message}</p>}
      <RunInputs inputs={JSON.parse(run.inputs) as Record<string, string>} />
      {jobs.map((j) => (
        <section key={j.id} className={`card border-l-3 ${JOB_EDGE[j.status]}`} aria-labelledby={`job-${j.id}`}>
          <header>
            <h3 className="m-0" id={`job-${j.id}`}>
              <span className="sr-only">Job </span>
              {j.name}
            </h3>
            <CiBadge status={j.status} />
            <span className="flex-1" />
            <span className="text-muted tabular-nums">{duration(j.startedAt, j.finishedAt)}</span>
          </header>
          {j.deployment && <DeploymentNote job={j} deployment={j.deployment} base={repoApi(info.repo.owner, info.repo.name)} />}
          <LiveLog live={j.status === "running"} label={`${j.name} log`}>
            {j.log || (j.status === "queued" ? "Waiting for a runner…" : "")}
          </LiveLog>
        </section>
      ))}
    </div>
  );
}

// What a manual run was started with.
function RunInputs({ inputs }: { inputs: Record<string, string> }) {
  const entries = Object.entries(inputs);
  if (!entries.length) return null;
  return (
    <dl className="card body m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" aria-label="Inputs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-muted">{k}</dt>
          <dd className="m-0 font-mono wrap-anywhere">{v || <span className="text-muted">(empty)</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

// Where a deploy job goes and what it waits for; reviewers approve or reject it here.
function DeploymentNote({ job, deployment: d, base }: { job: Job; deployment: JobDeployment; base: string }) {
  const router = useRouter();
  const review = useAction(async (approve: boolean) => {
    await post(`${base}/ci/jobs/${job.id}/review`, { approve });
    await router.invalidate();
  });
  const waiting = job.status === "waiting";
  return (
    <div className="body stack-sm border-b border-border" aria-label={`Deployment of ${job.name}`} role="group">
      <p className="m-0">
        Deploys to <strong className="font-mono">{d.environment}</strong>
        {d.url && (
          <>
            {" · "}
            <a href={d.url} target="_blank" rel="noreferrer noopener">
              {d.url}
            </a>
          </>
        )}
        {d.reviewedBy && <span className="text-muted"> · {d.status === "rejected" ? "rejected" : "approved"} by {d.reviewedBy}</span>}
      </p>
      {waiting && d.notBefore && <p className="text-muted m-0">Waiting until {new Date(d.notBefore).toLocaleString()} before it starts.</p>}
      {waiting && !d.notBefore && (
        <p className="text-muted m-0">
          Waiting for {d.reviewers.length === 1 ? d.reviewers[0] : `one of ${d.reviewers.join(", ")}`} to approve.
        </p>
      )}
      {d.canReview && (
        <div className={ROW}>
          <ErrorNote error={review.error} />
          <button className="primary small" onClick={() => review.run(true)} disabled={review.pending}>
            Approve and deploy
          </button>
          <button className="danger small" onClick={() => review.run(false)} disabled={review.pending}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

// A job's output. While the job runs it shows a caret and follows new lines, unless the
// reader has scrolled up to look at something.
function LiveLog({ live, label, children }: { live: boolean; label: string; children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && live && pinned.current) el.scrollTop = el.scrollHeight;
  }, [children, live]);
  return (
    <pre
      ref={ref}
      className="ci-log"
      data-live={live || undefined}
      role="log"
      aria-label={label}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {children}
    </pre>
  );
}
