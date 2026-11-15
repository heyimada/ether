import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { del, post, put } from "../lib/api";
import { Avatar, ErrorNote, Field, onSubmit, ROW, useAction } from "./ui";

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
        <h2 className="m-0">Teams</h2>
        <span className="text-muted tabular-nums">{teams.length}</span>
      </header>
      <div className="body stack-md">
        <p className="text-muted m-0">
          Teams give a group of members a role on chosen repositories, on top of the base permission.
        </p>
        {teams.map((t) => (
          <TeamCard key={t.name} org={org} team={t} repos={repos} />
        ))}
        <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit(create.run)}>
          <ErrorNote error={create.error} />
          <Field id="team-name" label="Team name">
            <input id="team-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={39} pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,38}" />
          </Field>
          <button className="mb-4" disabled={create.pending}>
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
    <section className="stack-sm rounded-md border border-border bg-surface-2 p-3 shadow-[var(--highlight)]" aria-labelledby={titleId}>
      <div className={ROW}>
        <h3 className="m-0" id={titleId}>
          <span className="sr-only">Team </span>
          {team.name}
        </h3>
        <span className="flex-1" />
        {confirmDelete ? (
          <>
            <span className="text-muted">Delete this team?</span>
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
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-4 max-sm:grid-cols-[minmax(0,1fr)]">
        <div className="stack-sm">
          <strong>Members</strong>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Team members">
            {team.members.length === 0 && <li className="text-muted">No members yet.</li>}
            {team.members.map((m) => (
              <li key={m} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 pr-1 pl-1.5 text-sm">
                <Avatar name={m} size={18} />
                {m}
                <button className="ghost small" aria-label={`Remove ${m} from ${team.name}`} onClick={() => act.run(() => del(`${base}/members/${encodeURIComponent(m)}`))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form
            className={ROW}
            onSubmit={onSubmit(() =>
              act.run(async () => {
                await put(`${base}/members/${encodeURIComponent(member.trim())}`, {});
                setMember("");
              }),
            )}
          >
            <input className="flex-1 min-w-0" aria-label="Add member" placeholder="Username" value={member} onChange={(e) => setMember(e.target.value)} required />
            <button className="small">Add to team</button>
          </form>
        </div>
        <div className="stack-sm">
          <strong>Repositories</strong>
          <ul className="list" aria-label="Team repositories">
            {team.repos.length === 0 && <li className="text-muted">No repositories yet.</li>}
            {team.repos.map((r) => (
              <li className="py-1.5 px-0" key={r.name}>
                <span className="font-mono">{r.name}</span>
                <span className="pill">{r.role}</span>
                <span className="flex-1" />
                <button className="ghost small" aria-label={`Remove ${r.name} from ${team.name}`} onClick={() => act.run(() => del(`${base}/repos/${encodeURIComponent(r.name)}`))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {available.length > 0 && (
            <form className={ROW} onSubmit={onSubmit(() => act.run(() => put(`${base}/repos/${encodeURIComponent(chosen)}`, { role })))}>
              <select className="flex-1 min-w-0" aria-label="Repository" value={chosen} onChange={(e) => setRepo(e.target.value)}>
                {available.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select className="w-auto" aria-label="Team role" value={role} onChange={(e) => setRole(e.target.value as "read" | "write")}>
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
