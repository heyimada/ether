import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { del, post, put } from "../lib/api";
import { Avatar, ErrorNote, Field, onSubmit, useAction } from "./ui";

export type Team = { name: string; description: string; members: string[]; repos: { name: string; role: "read" | "write" }[] };

export function Teams({ org, teams, repos }: { org: string; teams: Team[]; repos: string[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const create = useAction(async () => {
    await post(`/api/orgs/${encodeURIComponent(org)}/teams`, { name });
    setName("");
    await router.invalidate();
  });
  return (
    <section className="card">
      <header>
        <h2 style={{ margin: 0 }}>Teams</h2>
        <span className="muted num">{teams.length}</span>
      </header>
      <div className="body stack-md">
        <p className="muted" style={{ margin: 0 }}>
          Teams give a group of members a role on chosen repositories, on top of the base permission.
        </p>
        {teams.map((t) => (
          <TeamCard key={t.name} org={org} team={t} repos={repos} />
        ))}
        <form className="row" onSubmit={onSubmit(create.run)} style={{ alignItems: "end" }}>
          <ErrorNote error={create.error} />
          <Field id="team-name" label="Team name">
            <input id="team-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={39} pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,38}" />
          </Field>
          <button disabled={create.pending} style={{ marginBottom: 16 }}>
            Create team
          </button>
        </form>
      </div>
    </section>
  );
}

function TeamCard({ org, team, repos }: { org: string; team: Team; repos: string[] }) {
  const router = useRouter();
  const base = `/api/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.name)}`;
  const [member, setMember] = useState("");
  const available = repos.filter((r) => !team.repos.some((x) => x.name === r));
  const [repo, setRepo] = useState("");
  const [role, setRole] = useState<"read" | "write">("write");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await router.invalidate();
  });
  const chosen = available.includes(repo) ? repo : (available[0] ?? "");
  const titleId = `team-${team.name}-title`;
  return (
    <section className="team-card stack-sm" aria-labelledby={titleId}>
      <div className="row">
        <h3 id={titleId} style={{ margin: 0 }}>
          <span className="sr-only">Team </span>
          {team.name}
        </h3>
        <span className="spacer" />
        {confirmDelete ? (
          <>
            <span className="muted">Delete this team?</span>
            <button className="danger small" onClick={() => act.run(() => del(base))}>
              Delete
            </button>
            <button className="small" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="danger small" onClick={() => setConfirmDelete(true)}>
            Delete team
          </button>
        )}
      </div>
      <ErrorNote error={act.error} />
      <div className="team-grid">
        <div className="stack-sm">
          <strong>Members</strong>
          <ul className="chips" aria-label="Team members">
            {team.members.length === 0 && <li className="muted">No members yet.</li>}
            {team.members.map((m) => (
              <li key={m} className="chip">
                <Avatar name={m} size={18} />
                {m}
                <button className="ghost small" aria-label={`Remove ${m} from ${team.name}`} onClick={() => act.run(() => del(`${base}/members/${encodeURIComponent(m)}`))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form
            className="row"
            onSubmit={onSubmit(() =>
              act.run(async () => {
                await put(`${base}/members/${encodeURIComponent(member.trim())}`, {});
                setMember("");
              }),
            )}
          >
            <input aria-label="Add member" placeholder="Username" value={member} onChange={(e) => setMember(e.target.value)} required style={{ flex: 1, minWidth: 0 }} />
            <button className="small">Add to team</button>
          </form>
        </div>
        <div className="stack-sm">
          <strong>Repositories</strong>
          <ul className="list" aria-label="Team repositories">
            {team.repos.length === 0 && <li className="muted">No repositories yet.</li>}
            {team.repos.map((r) => (
              <li key={r.name} style={{ padding: "6px 0" }}>
                <span className="mono">{r.name}</span>
                <span className="pill">{r.role}</span>
                <span className="spacer" />
                <button className="ghost small" aria-label={`Remove ${r.name} from ${team.name}`} onClick={() => act.run(() => del(`${base}/repos/${encodeURIComponent(r.name)}`))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {available.length > 0 && (
            <form className="row" onSubmit={onSubmit(() => act.run(() => put(`${base}/repos/${encodeURIComponent(chosen)}`, { role })))}>
              <select aria-label="Repository" value={chosen} onChange={(e) => setRepo(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                {available.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select aria-label="Team role" value={role} onChange={(e) => setRole(e.target.value as "read" | "write")} style={{ width: "auto" }}>
                <option value="read">Read</option>
                <option value="write">Write</option>
              </select>
              <button className="small">Grant access</button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
