import { Link, useRouter } from "@tanstack/react-router";
import { Rocket } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api, del, put, shortSha, timeAgo } from "../lib/api";
import { CiBadge, type CiStatus } from "./ci";
import { CiSecrets, type CiSecret } from "./ci-secrets";
import { ErrorNote, Field, onSubmit, useAction } from "./ui";

export type DeploymentRow = { id: number; runId: number; sha: string; ref: string; status: string; url: string | null; actor: string | null; createdAt: string };
export type EnvironmentInfo = { name: string; branches: string[]; waitMinutes: number; reviewers: string[]; latest: DeploymentRow | null; active: DeploymentRow | null };

// What an environment's rules amount to, in words.
export function rulesSummary(e: Pick<EnvironmentInfo, "branches" | "reviewers" | "waitMinutes">) {
  return [
    e.branches.length ? `only ${e.branches.join(", ")}` : "any branch",
    e.reviewers.length ? `approval by ${e.reviewers.join(" or ")}` : "no approval",
    e.waitMinutes ? `waits ${e.waitMinutes} min` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function EnvironmentEditor({ base, env, candidates, isolation }: { base: string; env: EnvironmentInfo; candidates: string[]; isolation: "container" | "host" }) {
  const router = useRouter();
  const uid = useId();
  const endpoint = `${base}/environments/${encodeURIComponent(env.name)}`;
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState(env.branches.join(", "));
  const [reviewers, setReviewers] = useState(env.reviewers);
  const [wait, setWait] = useState(String(env.waitMinutes));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [secrets, setSecrets] = useState<CiSecret[] | null>(null);
  useEffect(() => {
    if (open) void api<{ secrets: CiSecret[] }>(`${endpoint}/secrets`).then((r) => setSecrets(r.secrets));
  }, [open, endpoint]);
  const save = useAction(async () => {
    await put(endpoint, {
      branches: branches.split(",").map((b) => b.trim()).filter(Boolean),
      reviewers,
      waitMinutes: Number(wait || 0),
    });
    await router.invalidate();
  });
  const remove = useAction(async () => {
    await del(endpoint);
    await router.invalidate();
  });
  const people = [...new Set([...candidates, ...env.reviewers])].sort();

  return (
    <li style={{ flexWrap: "wrap" }} aria-label={`Environment ${env.name}`}>
      <Rocket size={18} aria-hidden className="muted" />
      <div style={{ minWidth: 0 }}>
        <strong className="mono">{env.name}</strong>
        <div className="muted" style={{ fontSize: 12 }}>
          {rulesSummary(env)}
        </div>
      </div>
      <span className="spacer" />
      <button className="small" aria-expanded={open} aria-label={`Edit environment ${env.name}`} onClick={() => setOpen(!open)}>
        {open ? "Close" : "Edit"}
      </button>
      {open && (
        <div className="stack-md" style={{ flexBasis: "100%" }}>
          <form className="stack-sm" onSubmit={onSubmit(save.run)}>
            <ErrorNote error={save.error} />
            <Field id={`${uid}-branches`} label="Branches that may deploy" hint="Comma-separated names or patterns such as main or release/*. Empty means any branch.">
              <input id={`${uid}-branches`} className="mono" value={branches} onChange={(e) => setBranches(e.target.value)} />
            </Field>
            <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>Required reviewers</legend>
              <span className="hint" style={{ margin: 0 }}>
                Each deployment waits until one of them approves it on the CI run. Up to 6 people with write access.
              </span>
              {people.map((p) => (
                <label key={p} className="radio">
                  <input type="checkbox" checked={reviewers.includes(p)} onChange={(e) => setReviewers(e.target.checked ? [...reviewers, p] : reviewers.filter((r) => r !== p))} />
                  {p}
                </label>
              ))}
            </fieldset>
            <Field id={`${uid}-wait`} label="Wait timer (minutes)" hint="How long a deployment waits before it starts, after any approval. 0 for none.">
              <input id={`${uid}-wait`} type="number" min={0} max={43200} value={wait} onChange={(e) => setWait(e.target.value)} style={{ maxWidth: 140 }} />
            </Field>
            <div className="row">
              <button className="primary" disabled={save.pending}>
                Save environment
              </button>
            </div>
          </form>
          {secrets && (
            <CiSecrets
              base={base}
              endpoint={`${endpoint}/secrets`}
              title={`${env.name} secrets`}
              secrets={secrets}
              isolation={isolation}
              intro={
                <p className="muted" style={{ margin: 0 }}>
                  Only jobs that deploy to {env.name} get these, and they replace a repository secret of the same name.
                </p>
              }
            />
          )}
          {confirmDelete ? (
            <div className="notice stack-sm" role="alertdialog" aria-label={`Confirm deleting environment ${env.name}`}>
              <ErrorNote error={remove.error} />
              <p style={{ margin: 0 }}>
                Delete <code>{env.name}</code> with its rules, secrets and deployment history? A job that names it again starts a new one without rules.
              </p>
              <div className="row">
                <button className="danger" onClick={() => remove.run()} disabled={remove.pending}>
                  Delete environment
                </button>
                <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <button className="danger small" onClick={() => setConfirmDelete(true)}>
                Delete environment
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function Environments({ base, environments, candidates, isolation }: { base: string; environments: EnvironmentInfo[]; candidates: string[]; isolation: "container" | "host" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const add = useAction(async () => {
    await put(`${base}/environments/${encodeURIComponent(name)}`, {});
    setName("");
    await router.invalidate();
  });
  return (
    <section className="card">
      <header>
        <h2 style={{ margin: 0 }}>Environments</h2>
      </header>
      <div className="body stack-md">
        <p className="muted" style={{ margin: 0 }}>
          A job with <code>environment: production</code> in <code>.ether/ci.yml</code> deploys there. Environments are created the first time a job names
          one; here you can limit which branches may deploy, require an approval, add a wait and give them their own secrets.
        </p>
        {environments.length > 0 && (
          <ul className="list card" aria-label="Environments">
            {environments.map((e) => (
              <EnvironmentEditor key={e.name} base={base} env={e} candidates={candidates} isolation={isolation} />
            ))}
          </ul>
        )}
        <form className="row" onSubmit={onSubmit(add.run)} style={{ alignItems: "end" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="new-environment">New environment</label>
            <input id="new-environment" className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="production" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" />
          </div>
          <button disabled={add.pending}>Add environment</button>
        </form>
        <ErrorNote error={add.error} />
      </div>
    </section>
  );
}

const AS_CI: Record<string, CiStatus> = { queued: "queued", waiting: "waiting", in_progress: "running", success: "success", failure: "failure", cancelled: "cancelled", rejected: "failure" };

// The repository home's side panel: per environment, how the latest deployment went and what runs there now.
export function DeploymentsSide({ owner, repo, environments }: { owner: string; repo: string; environments: EnvironmentInfo[] }) {
  if (!environments.length) return null;
  const params = { owner, repo };
  return (
    <section className="side-section" aria-labelledby="side-deployments">
      <h3 id="side-deployments">
        Deployments <span className="count">{environments.length}</span>
      </h3>
      <ul className="side-text stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Environments">
        {environments.map((e) => (
          <li key={e.name} aria-label={`Environment ${e.name}`}>
            <div className="row" style={{ gap: 6 }}>
              <strong className="mono">{e.name}</strong>
              {e.latest && <CiBadge status={AS_CI[e.latest.status] ?? "queued"} />}
            </div>
            {e.active ? (
              <div className="muted" style={{ fontSize: 12 }}>
                <Link to="/$owner/$repo/ci/$id" params={{ ...params, id: String(e.active.runId) }} className="mono">
                  {shortSha(e.active.sha)}
                </Link>{" "}
                from <code>{e.active.ref}</code> · {timeAgo(e.active.createdAt)}
                {e.active.url && (
                  <>
                    {" · "}
                    <a href={e.active.url} target="_blank" rel="noreferrer noopener">
                      open
                    </a>
                  </>
                )}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12 }}>
                Nothing deployed yet.
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

