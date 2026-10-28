import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { BranchProtection, type BranchRule } from "../components/branch-protection";
import { CiSecrets, type CiSecret } from "../components/ci-secrets";
import { DeployKeys, type DeployKey } from "../components/deploy-keys";
import { Environments, type EnvironmentInfo } from "../components/environments";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { api, del, patch, put, repoApi } from "../lib/api";

type Collaborator = { username: string; role: "read" | "write" };

export const Route = createFileRoute("/_authed/$owner/$repo/settings")({
  beforeLoad: ({ context, params }) => {
    if (context.info.role !== "owner") throw redirect({ to: "/$owner/$repo", params });
  },
  loader: async ({ context: { info } }) => {
    const base = repoApi(info.repo.owner, info.repo.name);
    const [collabs, users, deploy, protection, secrets, envs] = await Promise.all([
      api<{ collaborators: Collaborator[] }>(`${base}/collaborators`),
      api<{ users: { username: string; isOrg: boolean }[] }>("/api/users"),
      api<{ keys: DeployKey[] }>(`${base}/deploy-keys`),
      api<{ rules: BranchRule[] }>(`${base}/branch-protection`),
      api<{ secrets: CiSecret[] }>(`${base}/ci/secrets`),
      api<{ environments: EnvironmentInfo[] }>(`${base}/environments`),
    ]);
    return {
      collaborators: collabs.collaborators,
      users: users.users.filter((u) => !u.isOrg).map((u) => u.username),
      deployKeys: deploy.keys,
      branchRules: protection.rules,
      secrets: secrets.secrets,
      environments: envs.environments,
    };
  },
  component: RepoSettings,
});

function RepoSettings() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { collaborators, users, deployKeys, branchRules, secrets, environments } = Route.useLoaderData();
  const base = repoApi(info.repo.owner, info.repo.name);
  const [description, setDescription] = useState(info.repo.description);
  const [defaultBranch, setDefaultBranch] = useState(info.repo.defaultBranch);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"read" | "write">("write");
  const [confirm, setConfirm] = useState("");
  const [confirmVisibility, setConfirmVisibility] = useState(false);
  const [requireApproval, setRequireApproval] = useState(info.repo.requireApproval);
  const { instance, me } = Route.useRouteContext();
  const [ci, setCi] = useState({ enabled: info.repo.ciEnabled, required: info.repo.requireChecks });
  const ciToggle = useAction(async (change: { ciEnabled?: boolean; requireChecks?: boolean }) => {
    setCi({ enabled: change.ciEnabled ?? ci.enabled, required: change.requireChecks ?? ci.required });
    await patch(base, change);
    await router.invalidate();
  });
  const protect = useAction(async (on: boolean) => {
    setRequireApproval(on);
    await patch(base, { requireApproval: on });
    await router.invalidate();
  });
  const next = info.repo.visibility === "public" ? "private" : "public";
  const changeVisibility = useAction(async () => {
    await patch(base, { visibility: next });
    setConfirmVisibility(false);
    await router.invalidate();
  });

  const save = useAction(async () => {
    await patch(base, { description, ...(info.branches.length ? { defaultBranch } : {}) });
    await router.invalidate();
  });
  const add = useAction(async () => {
    await put(`${base}/collaborators/${encodeURIComponent(username)}`, { role });
    setUsername("");
    await router.invalidate();
  });
  const remove = useAction(async (name: string) => {
    await del(`${base}/collaborators/${encodeURIComponent(name)}`);
    await router.invalidate();
  });
  const destroy = useAction(async () => {
    await del(base);
    await router.navigate({ to: "/" });
  });

  const candidates = users.filter((u) => u !== info.repo.owner && !collaborators.some((c) => c.username === u));

  return (
    <div style={{ maxWidth: 760 }} className="timeline">
      <form className="card body" onSubmit={onSubmit(save.run)}>
        <h2>General</h2>
        <ErrorNote error={save.error} />
        <Field id="description" label="Description">
          <input id="description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        {info.branches.length > 0 && (
          <Field id="default-branch" label="Default branch">
            <select id="default-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)}>
              {info.branches.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </Field>
        )}
        <button className="primary" disabled={save.pending}>
          Save
        </button>
      </form>

      <section className="card body stack-sm">
        <h2 style={{ margin: 0 }}>CI</h2>
        <ErrorNote error={ciToggle.error} />
        <label className="radio">
          <input type="checkbox" checked={ci.enabled} onChange={(e) => ciToggle.run({ ciEnabled: e.target.checked })} disabled={ciToggle.pending || (!instance.ciEnabled && !ci.enabled)} />
          Run <code>.ether/ci.yml</code> on every push
        </label>
        {!instance.ciEnabled && <span className="hint" style={{ margin: 0 }}>An admin has to allow CI on this server first.</span>}
        <label className="radio">
          <input type="checkbox" checked={ci.required} onChange={(e) => ciToggle.run({ requireChecks: e.target.checked })} disabled={ciToggle.pending} />
          Require passing checks before merging
        </label>
      </section>

      <CiSecrets base={base} secrets={secrets} isolation={instance.ciIsolation} />

      <Environments
        base={base}
        environments={environments}
        // People who can review deployments need write access; the server checks it again.
        candidates={[...(me ? [me.username] : []), ...(users.includes(info.repo.owner) ? [info.repo.owner] : []), ...collaborators.filter((c) => c.role === "write").map((c) => c.username)]}
        isolation={instance.ciIsolation}
      />

      <section className="card body stack-sm">
        <h2 style={{ margin: 0 }}>Pull requests</h2>
        <ErrorNote error={protect.error} />
        <label className="radio">
          <input type="checkbox" checked={requireApproval} onChange={(e) => protect.run(e.target.checked)} disabled={protect.pending} />
          Require an approving review before merging
        </label>
        <span className="hint" style={{ margin: 0 }}>
          Someone with write access other than the author has to approve, and nobody may have outstanding requested changes.
        </span>
      </section>

      <BranchProtection base={base} rules={branchRules} defaultBranch={info.repo.defaultBranch} />

      <section className="card body stack-sm">
        <h2 style={{ margin: 0 }}>Visibility</h2>
        <ErrorNote error={changeVisibility.error} />
        <p className="muted" style={{ margin: 0 }}>
          {info.repo.visibility === "public"
            ? "This repository is public: everyone with an account on this server can see and clone it."
            : "This repository is private: only its owner, organization members and collaborators can see it."}
        </p>
        {confirmVisibility ? (
          <div className="notice stack-sm" role="alertdialog" aria-label="Confirm visibility change">
            <p style={{ margin: 0 }}>
              {next === "public"
                ? "Everyone with an account will be able to read the code, issues and pull requests. Continue?"
                : "People who aren't collaborators or members will lose access. Continue?"}
            </p>
            <div className="row">
              <button className="primary" onClick={() => changeVisibility.run()} disabled={changeVisibility.pending}>
                Make {next}
              </button>
              <button onClick={() => setConfirmVisibility(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div>
            <button onClick={() => setConfirmVisibility(true)}>Change to {next}</button>
          </div>
        )}
      </section>

      <section className="card">
        <header>
          <h2 style={{ margin: 0 }}>Collaborators</h2>
        </header>
        <ErrorNote error={remove.error} />
        {collaborators.length === 0 ? (
          <p className="empty">Only you can see this repository.</p>
        ) : (
          <ul className="list">
            {collaborators.map((c) => (
              <li key={c.username}>
                <strong>{c.username}</strong>
                <span className="badge">{c.role}</span>
                <span className="spacer" />
                <button className="danger small" onClick={() => remove.run(c.username)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="body row" onSubmit={onSubmit(add.run)} style={{ borderTop: "1px solid var(--border)", alignItems: "end" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="collab-user">Add a person</label>
            <select id="collab-user" value={username} onChange={(e) => setUsername(e.target.value)} required>
              <option value="" disabled>
                Choose a user
              </option>
              {candidates.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="collab-role">Role</label>
            <select id="collab-role" value={role} onChange={(e) => setRole(e.target.value as "read" | "write")}>
              <option value="write">Write</option>
              <option value="read">Read</option>
            </select>
          </div>
          <button className="primary" disabled={add.pending || !username}>
            Add collaborator
          </button>
          <ErrorNote error={add.error} />
        </form>
      </section>

      <DeployKeys base={base} keys={deployKeys} sshBase={instance.sshBase} />

      <form className="card body" onSubmit={onSubmit(destroy.run)} style={{ borderColor: "var(--del-fg)" }}>
        <h2>Delete this repository</h2>
        <p className="muted">This permanently deletes the repository, its issues and pull requests. It cannot be undone.</p>
        <ErrorNote error={destroy.error} />
        <Field id="confirm" label={`Type ${info.repo.name} to confirm`}>
          <input id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <button className="danger" disabled={confirm !== info.repo.name || destroy.pending}>
          Delete repository
        </button>
      </form>
    </div>
  );
}
