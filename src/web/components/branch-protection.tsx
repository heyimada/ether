import { useRouter } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { del, patch, post } from "../lib/api";
import { ErrorNote, Field, onSubmit, ROW, useAction } from "./ui";

export type BranchRule = { id: number; pattern: string; requirePullRequest: boolean; allowForcePush: boolean; allowDeletion: boolean };
type Settings = Pick<BranchRule, "requirePullRequest" | "allowForcePush" | "allowDeletion">;

// What a rule does, in words, for the list.
const summary = (r: Settings) =>
  [r.requirePullRequest ? "pull requests only" : "direct pushes allowed", r.allowForcePush ? "force pushes allowed" : "no force pushes", r.allowDeletion ? "can be deleted" : "can't be deleted"].join(" · ");

// The three settings, shared by the form that adds a rule and the one that edits it.
function RuleOptions({ value, onChange }: { value: Settings; onChange: (v: Settings) => void }) {
  return (
    <>
      <label className="radio">
        <input type="checkbox" checked={value.requirePullRequest} onChange={(e) => onChange({ ...value, requirePullRequest: e.target.checked })} />
        Require a pull request: no direct pushes
      </label>
      <span className="hint m-0">
        Anyone with write access can still merge their own pull request, unless approving reviews are required under Pull requests.
      </span>
      <label className="radio">
        <input type="checkbox" checked={value.allowForcePush} onChange={(e) => onChange({ ...value, allowForcePush: e.target.checked })} />
        Allow force pushes
      </label>
      <label className="radio">
        <input type="checkbox" checked={value.allowDeletion} onChange={(e) => onChange({ ...value, allowDeletion: e.target.checked })} />
        Allow deleting matching branches
      </label>
      {value.allowDeletion && (
        <span className="hint m-0">
          {value.requirePullRequest
            ? "A deleted branch can't be pushed again, since that would skip pull requests."
            : "Deleting a branch and pushing it again replaces its history, so this also allows rewriting it."}
        </span>
      )}
    </>
  );
}

function RuleRow({ base, rule }: { base: string; rule: BranchRule }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "remove">("view");
  const [value, setValue] = useState<Settings>(rule);
  const save = useAction(async () => {
    await patch(`${base}/branch-protection/${rule.id}`, value);
    setMode("view");
    await router.invalidate();
  });
  const remove = useAction(async () => {
    await del(`${base}/branch-protection/${rule.id}`);
    await router.invalidate();
  });
  return (
    <li className="flex-wrap" aria-label={`Rule ${rule.pattern}`}>
      <ShieldCheck size={18} aria-hidden className="text-muted" />
      <div className="min-w-0">
        <strong className="font-mono">{rule.pattern}</strong>
        <div className="text-muted text-xs">
          {summary(rule)}
        </div>
      </div>
      <span className="flex-1" />
      {mode === "view" && (
        <div className={ROW}>
          <button className="small" aria-label={`Edit rule ${rule.pattern}`} onClick={() => (setValue(rule), setMode("edit"))}>
            Edit
          </button>
          <button className="danger small" aria-label={`Remove rule ${rule.pattern}`} onClick={() => setMode("remove")}>
            Remove
          </button>
        </div>
      )}
      {mode === "edit" && (
        <form className="stack-sm basis-full" onSubmit={onSubmit(save.run)}>
          <ErrorNote error={save.error} />
          <RuleOptions value={value} onChange={setValue} />
          <div className={ROW}>
            <button className="primary" disabled={save.pending}>
              Save rule
            </button>
            <button type="button" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === "remove" && (
        <div className="notice stack-sm basis-full" role="alertdialog" aria-label={`Confirm removing rule ${rule.pattern}`}>
          <ErrorNote error={remove.error} />
          <p className="m-0">
            Remove protection from <code>{rule.pattern}</code>? Pushes to matching branches will no longer be checked.
          </p>
          <div className={ROW}>
            <button className="danger" onClick={() => remove.run()} disabled={remove.pending}>
              Remove protection
            </button>
            <button onClick={() => setMode("view")}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

export function BranchProtection({ base, rules, defaultBranch }: { base: string; rules: BranchRule[]; defaultBranch: string }) {
  const router = useRouter();
  const [pattern, setPattern] = useState(rules.some((r) => r.pattern === defaultBranch) ? "" : defaultBranch);
  const [value, setValue] = useState<Settings>({ requirePullRequest: true, allowForcePush: false, allowDeletion: false });
  const add = useAction(async () => {
    await post(`${base}/branch-protection`, { pattern, ...value });
    setPattern("");
    await router.invalidate();
  });
  return (
    <section className="card">
      <header>
        <h2 className="m-0">Protected branches</h2>
      </header>
      <div className="body stack-md">
        <p className="text-muted m-0">
          Rules apply to every push over HTTPS and SSH, including yours and deploy keys'. Merging a pull request in Ether is always allowed. In a repository with
          rules, branch names that differ from an existing branch only in case are refused.
        </p>
        {rules.length > 0 && (
          <ul className="list card" aria-label="Protected branches">
            {rules.map((r) => (
              <RuleRow key={r.id} base={base} rule={r} />
            ))}
          </ul>
        )}
        <form className="stack-sm" onSubmit={onSubmit(add.run)}>
          <ErrorNote error={add.error} />
          <Field id="protect-pattern" label="Branch name or pattern" hint="For example main, release/* or hotfix/**. * stays within one path segment, ** spans several.">
            <input id="protect-pattern" className="font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} required maxLength={200} />
          </Field>
          <RuleOptions value={value} onChange={setValue} />
          <div>
            <button disabled={add.pending}>Protect branch</button>
          </div>
        </form>
      </div>
    </section>
  );
}
