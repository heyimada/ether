import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar, ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { Teams, type Team } from "../components/teams";
import { api, del, patch, put } from "../lib/api";

type Member = { username: string; role: "owner" | "member"; displayName: string; avatarVersion: number | null };
type Org = { name: string; basePermission: "read" | "write"; viewerRole: "owner" | "member" | null; members: Member[] };
type OrgProfile = { profile: { displayName: string; bio: string; location: string; website: string } };

export const Route = createFileRoute("/_authed/organizations/$org/settings")({
  loader: async ({ params }) => {
    const base = `/api/orgs/${encodeURIComponent(params.org)}`;
    const [org, prof, teams, repos] = await Promise.all([
      api<Org>(base),
      api<OrgProfile>(`/api/users/${encodeURIComponent(params.org)}/profile`),
      api<{ teams: Team[] }>(`${base}/teams`).catch(() => ({ teams: [] as Team[] })),
      api<{ repos: { owner: string; name: string }[] }>("/api/repos"),
    ]);
    if (org.viewerRole !== "owner") throw redirect({ to: "/$owner", params: { owner: params.org } });
    return { org, profile: prof.profile, teams: teams.teams, repos: repos.repos.filter((r) => r.owner === org.name).map((r) => r.name) };
  },
  component: OrgSettings,
});

const Status = ({ text }: { text: string }) =>
  text ? (
    <span role="status" className="muted">
      {text}
    </span>
  ) : null;

function OrgSettings() {
  const router = useRouter();
  const { org, profile, teams, repos } = Route.useLoaderData();
  const base = `/api/orgs/${encodeURIComponent(org.name)}`;
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"member" | "owner">("member");
  const [form, setForm] = useState({ displayName: profile.displayName, bio: profile.bio, location: profile.location, website: profile.website });
  const [status, setStatus] = useState("");

  const add = useAction(async () => {
    await put(`${base}/members/${encodeURIComponent(username.trim())}`, { role });
    setUsername("");
    await router.invalidate();
  });
  const changeRole = useAction(async (name: string, next: "owner" | "member") => {
    await put(`${base}/members/${encodeURIComponent(name)}`, { role: next });
    await router.invalidate();
  });
  const remove = useAction(async (name: string) => {
    await del(`${base}/members/${encodeURIComponent(name)}`);
    await router.invalidate();
  });
  const setBase = useAction(async (basePermission: "read" | "write") => {
    await patch(base, { basePermission });
    await router.invalidate();
  });
  const saveProfile = useAction(async () => {
    await patch(`${base}/profile`, form);
    setStatus("Organization profile saved");
    await router.invalidate();
  });
  const upload = useAction(async (file: File) => {
    const res = await fetch(`${base}/avatar`, { method: "PUT", body: file, headers: { "Content-Type": file.type }, credentials: "same-origin" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Upload failed");
    setStatus("Avatar updated");
    await router.invalidate();
  });

  return (
    <main className="page stack" style={{ maxWidth: 760 }}>
      <div className="row">
        <Avatar name={org.name} size={40} />
        <h1 style={{ margin: 0 }}>{org.name} settings</h1>
        <span className="spacer" />
        <Link to="/$owner" params={{ owner: org.name }}>
          View organization
        </Link>
      </div>

      <section className="card">
        <header>
          <h2 style={{ margin: 0 }}>Members</h2>
          <span className="muted num">{org.members.length}</span>
        </header>
        <ErrorNote error={changeRole.error ?? remove.error} />
        <ul className="list" aria-label="Members">
          {org.members.map((m) => (
            <li key={m.username}>
              <Avatar name={m.username} size={28} />
              <div style={{ minWidth: 0 }}>
                <Link to="/$owner" params={{ owner: m.username }}>
                  {m.username}
                </Link>
                {m.displayName && <div className="muted">{m.displayName}</div>}
              </div>
              <span className="spacer" />
              <select aria-label={`Role for ${m.username}`} value={m.role} onChange={(e) => changeRole.run(m.username, e.target.value as "owner" | "member")} style={{ width: "auto" }}>
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </select>
              <button className="danger small" onClick={() => remove.run(m.username)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form className="body row add-member" onSubmit={onSubmit(add.run)} style={{ borderTop: "1px solid var(--border)", alignItems: "end" }}>
          <ErrorNote error={add.error} />
          <Field id="member-name" label="Username">
            <input id="member-name" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field id="member-role" label="Role">
            <select id="member-role" value={role} onChange={(e) => setRole(e.target.value as "owner" | "member")}>
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </select>
          </Field>
          <button className="primary" disabled={add.pending} style={{ marginBottom: 16 }}>
            Add member
          </button>
        </form>
      </section>

      <Teams org={org.name} teams={teams} repos={repos} />

      <section className="card body stack-sm">
        <h2 style={{ margin: 0 }}>Base permission</h2>
        <ErrorNote error={setBase.error} />
        <p className="muted" style={{ margin: 0 }}>
          What every member can do in every repository this organization owns. Collaborator roles on a repository can raise it, never lower it.
        </p>
        <fieldset className="theme-choice">
          <legend className="sr-only">Base permission</legend>
          {(["read", "write"] as const).map((p) => (
            <label key={p} className="radio">
              <input type="radio" name="base" checked={org.basePermission === p} onChange={() => setBase.run(p)} disabled={setBase.pending} />
              {p === "read" ? "Read: clone, browse, open issues" : "Write: also push and merge"}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card body stack-md">
        <h2 style={{ margin: 0 }}>Organization profile</h2>
        <ErrorNote error={saveProfile.error ?? upload.error} />
        <div className="avatar-row">
          <Avatar name={org.name} size={72} />
          <label htmlFor="org-avatar" className="button" style={{ margin: 0 }}>
            Upload avatar
          </label>
          <input
            id="org-avatar"
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.run(file);
              e.target.value = "";
            }}
          />
        </div>
        <form className="stack-md" onSubmit={onSubmit(saveProfile.run)}>
          <Field id="o-display" label="Display name">
            <input id="o-display" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} maxLength={64} />
          </Field>
          <Field id="o-bio" label="Description">
            <textarea id="o-bio" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} maxLength={200} style={{ minHeight: 72 }} />
          </Field>
          <div className="form-grid">
            <Field id="o-location" label="Location">
              <input id="o-location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} maxLength={64} />
            </Field>
            <Field id="o-website" label="Website">
              <input id="o-website" type="url" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" />
            </Field>
          </div>
          <div className="row">
            <button className="primary" disabled={saveProfile.pending}>
              Save organization profile
            </button>
            <Status text={status} />
          </div>
        </form>
      </section>
    </main>
  );
}
