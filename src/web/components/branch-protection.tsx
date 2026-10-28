import { useRouter } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { del, post } from "../lib/api";
import { ErrorNote, Field, onSubmit, useAction } from "./ui";

export type BranchRule = { id: number; pattern: string; requirePullRequest: boolean; allowForcePush: boolean; allowDeletion: boolean };

// What a rule does, in words, for the list.
const summary = (r: BranchRule) =>
  [r.requirePullRequest ? "pull requests only" : "direct pushes allowed", r.allowForcePush ? "force pushes allowed" : "no force pushes", r.allowDeletion ? "can be deleted" : "can't be deleted"].join(" · ");

export function BranchProtection({ base, rules, defaultBranch }: { base: string; rules: BranchRule[]; defaultBranch: string }) {
  const router = useRouter();
  const [pattern, setPattern] = useState(rules.some((r) => r.pattern === defaultBranch) ? "" : defaultBranch);
  const [requirePullRequest, setRequirePullRequest] = useState(true);
  const [allowForcePush, setAllowForcePush] = useState(false);
  const [allowDeletion, setAllowDeletion] = useState(false);
  const add = useAction(async () => {
    await post(`${base}/branch-protection`, { pattern, requirePullRequest, allowForcePush, allowDeletion });
    setPattern("");
    await router.invalidate();
  });
  const remove = useAction(async (id: number) => {
    await del(`${base}/branch-protection/${id}`);
    await router.invalidate();
  });
  return (
    <section className="card">
      <header>
        <h2 style={{ margin: 0 }}>Protected branches</h2>
      </header>
      <div className="body stack-md">
        <p className="muted" style={{ margin: 0 }}>
          Rules apply to every push over HTTPS and SSH, including yours and deploy keys'. Merging a pull request in Ether is always allowed.
        </p>
        <ErrorNote error={remove.error} />
        {rules.length > 0 && (
          <ul className="list card" aria-label="Protected branches">
            {rules.map((r) => (
              <li key={r.id}>
                <ShieldCheck size={18} aria-hidden className="muted" />
                <div style={{ minWidth: 0 }}>
                  <strong className="mono">{r.pattern}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {summary(r)}
                  </div>
                </div>
                <span className="spacer" />
                <button className="danger small" aria-label={`Remove rule ${r.pattern}`} onClick={() => remove.run(r.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="stack-sm" onSubmit={onSubmit(add.run)}>
          <ErrorNote error={add.error} />
          <Field id="protect-pattern" label="Branch name or pattern" hint="For example main, release/* or hotfix/**. * stays within one path segment, ** spans several.">
            <input id="protect-pattern" className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} required maxLength={200} />
          </Field>
          <label className="radio">
            <input type="checkbox" checked={requirePullRequest} onChange={(e) => setRequirePullRequest(e.target.checked)} />
            Require a pull request: no direct pushes
          </label>
          <label className="radio">
            <input type="checkbox" checked={allowForcePush} onChange={(e) => setAllowForcePush(e.target.checked)} />
            Allow force pushes
          </label>
          <label className="radio">
            <input type="checkbox" checked={allowDeletion} onChange={(e) => setAllowDeletion(e.target.checked)} />
            Allow deleting matching branches
          </label>
          <div>
            <button disabled={add.pending}>Protect branch</button>
          </div>
        </form>
      </div>
    </section>
  );
}
