import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { CiBadge, ciDone, EVENT_LABEL, type CiEvent, type CiStatus } from "../components/ci";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { api, post, repoApi, shortSha, timeAgo } from "../lib/api";
import { rise, staggered } from "../lib/motion";

type Run = {
  id: number;
  sha: string;
  ref: string;
  refType: "branch" | "tag";
  workflowName: string;
  workflowPath: string;
  event: CiEvent;
  pullNumber: number | null;
  status: CiStatus;
  message: string;
  subject: string;
  createdAt: string;
  jobs: { name: string; status: CiStatus }[];
};
type Input = { name: string; description: string; type: "string" | "boolean" | "choice" | "number"; required: boolean; default: string | null; options: string[] };
type Workflow = { path: string; name: string; events: CiEvent[]; inputs: Input[] | null; error: string | null };

export const Route = createFileRoute("/_authed/$owner/$repo/ci/")({
  validateSearch: (s: Record<string, unknown>): { workflow?: string } => ({ workflow: typeof s.workflow === "string" && s.workflow ? s.workflow : undefined }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { info }, deps }) => {
    const base = `${repoApi(info.repo.owner, info.repo.name)}/ci`;
    const [runs, workflows] = await Promise.all([
      api<{ enabled: boolean; runs: Run[] }>(`${base}/runs${deps.workflow ? `?workflow=${encodeURIComponent(deps.workflow)}` : ""}`),
      api<{ branch: string | null; workflows: Workflow[] }>(`${base}/workflows`),
    ]);
    return { ...runs, ...workflows };
  },
  component: Runs,
});

function Runs() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { workflow: selected } = Route.useSearch();
  const { enabled, runs, workflows } = Route.useLoaderData();
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
  const current = workflows.find((w) => w.path === selected);
  const title = current?.name ?? runs[0]?.workflowName ?? selected;

  return (
    <div className="grid max-w-[1100px] gap-5 md:grid-cols-[220px_1fr]">
      <nav aria-label="Workflows" className="stack-sm">
        <h2 className="m-0 text-base">Workflows</h2>
        <ul className="m-0 p-0 list-none stack-sm">
          <li>
            <Link to="/$owner/$repo/ci" params={params} search={{}} className={!selected ? "font-semibold" : ""} aria-current={!selected ? "page" : undefined}>
              All workflows
            </Link>
          </li>
          {workflows.map((w) => (
            <li key={w.path} className="min-w-0">
              <Link
                to="/$owner/$repo/ci"
                params={params}
                search={{ workflow: w.path }}
                className={`wrap-anywhere ${selected === w.path ? "font-semibold" : ""}`}
                aria-current={selected === w.path ? "page" : undefined}
              >
                {w.name}
              </Link>
              {w.error && <span className="text-danger text-xs"> · invalid</span>}
            </li>
          ))}
        </ul>
      </nav>
      <div className="stack-md min-w-0">
        <h2 className="m-0">{selected ? title : "CI runs"}</h2>
        {!enabled && (
          <p className="notice m-0">
            CI is off for this repository.{" "}
            {info.role === "owner" ? (
              <>
                Turn it on in <Link to="/$owner/$repo/settings" params={params}>Settings</Link>, then push a workflow to <code>.ether/workflows/</code>.
              </>
            ) : (
              "An owner can turn it on in the repository settings."
            )}
          </p>
        )}
        {current && (
          <p className="text-muted m-0">
            <code>{current.path}</code>
            {current.events.length > 0 && ` · runs on ${current.events.map((e) => EVENT_LABEL[e]).join(", ")}`}
          </p>
        )}
        {current?.error && <p className="error m-0">{current.error}</p>}
        {current?.inputs && enabled && info.role !== "read" && <RunWorkflow key={current.path} workflow={current} />}
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
                    {!selected && `${r.workflowName} `}#{r.id} · {EVENT_LABEL[r.event]}
                    {r.pullNumber !== null && ` #${r.pullNumber}`} · <code>{r.ref}</code> · <code>{shortSha(r.sha)}</code> · {timeAgo(r.createdAt)}
                    {r.message && ` · ${r.message}`}
                  </div>
                </div>
                <span className="flex-1" />
                <span className="text-muted tabular-nums">
                  {r.jobs.filter((j) => j.status === "success").length}/{r.jobs.length} jobs passed
                </span>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </div>
    </div>
  );
}

// Starts a workflow that has workflow_dispatch, on a branch, with its inputs.
function RunWorkflow({ workflow }: { workflow: Workflow }) {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const inputs = workflow.inputs ?? [];
  const [ref, setRef] = useState(info.repo.defaultBranch);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map((i) => [i.name, i.default ?? (i.type === "boolean" ? "false" : i.type === "choice" ? i.options[0] : "")])));
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  const start = useAction(async () => {
    const res = await post<{ run: { id: number } }>(`${repoApi(info.repo.owner, info.repo.name)}/ci/workflows/dispatch`, { workflow: workflow.path, ref, inputs: values });
    await router.navigate({ to: "/$owner/$repo/ci/$id", params: { ...params, id: String(res.run.id) } });
  });
  return (
    <details className="card">
      <summary className="body cursor-pointer font-semibold">Run workflow</summary>
      <form className="body stack-sm border-t border-border" onSubmit={onSubmit(start.run)} aria-label={`Run ${workflow.name}`}>
        <ErrorNote error={start.error} />
        <Field id="dispatch-ref" label="Branch" hint="The workflow runs as it is on this branch.">
          <select id="dispatch-ref" value={ref} onChange={(e) => setRef(e.target.value)}>
            {info.branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </Field>
        {inputs.map((i) => {
          const id = `dispatch-input-${i.name}`;
          const label = `${i.name}${i.required ? " (required)" : ""}`;
          if (i.type === "boolean")
            return (
              <label key={i.name} className="radio">
                <input type="checkbox" checked={values[i.name] === "true"} onChange={(e) => set(i.name, String(e.target.checked))} />
                {i.description || i.name}
              </label>
            );
          return (
            <Field key={i.name} id={id} label={label} hint={i.description || undefined}>
              {i.type === "choice" ? (
                <select id={id} value={values[i.name]} onChange={(e) => set(i.name, e.target.value)}>
                  {i.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input id={id} type={i.type === "number" ? "number" : "text"} step="any" value={values[i.name]} onChange={(e) => set(i.name, e.target.value)} required={i.required} />
              )}
            </Field>
          );
        })}
        <div>
          <button className="primary" disabled={start.pending}>
            Run workflow
          </button>
        </div>
      </form>
    </details>
  );
}
