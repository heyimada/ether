import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton, ErrorNote, useAction } from "../components/ui";
import { api, post, put, timeAgo } from "../lib/api";
import { requireAccount } from "../lib/require-account";

type Invite = { createdAt: string; expiresAt: string; usedBy: string | null };
type UserRow = { username: string; isAdmin: boolean; isOrg: boolean };

export const Route = createFileRoute("/_authed/site-admin")({
  beforeLoad: ({ context, location }) => {
    const { me } = requireAccount(context.me, location.href);
    if (!me.isAdmin) throw redirect({ to: "/" });
    return { me };
  },
  loader: async () => {
    const [invites, users, instance] = await Promise.all([
      api<{ invites: Invite[] }>("/api/invites"),
      api<{ users: UserRow[] }>("/api/users"),
      api<{ anonymousRead: boolean; ciEnabled: boolean }>("/api/instance"),
    ]);
    return { invites: invites.invites, users: users.users.filter((u) => !u.isOrg), instance };
  },
  component: Admin,
});

function Admin() {
  const router = useRouter();
  const { invites, users, instance } = Route.useLoaderData();
  const [saved, setSaved] = useState("");
  const [allowVisitors, setAllowVisitors] = useState(instance.anonymousRead);
  const [allowCi, setAllowCi] = useState(instance.ciEnabled);
  const setCi = useAction(async (ciEnabled: boolean) => {
    setSaved("");
    setAllowCi(ciEnabled);
    try {
      await put("/api/admin/settings", { ciEnabled });
    } catch (e) {
      setAllowCi(!ciEnabled);
      throw e;
    }
    setSaved("Saved");
    await router.invalidate();
  });
  const setAnonymous = useAction(async (anonymousRead: boolean) => {
    setSaved("");
    setAllowVisitors(anonymousRead);
    try {
      await put("/api/admin/settings", { anonymousRead });
    } catch (e) {
      setAllowVisitors(!anonymousRead);
      throw e;
    }
    setSaved("Saved");
    await router.invalidate();
  });
  const [link, setLink] = useState<string | null>(null);
  const invite = useAction(async () => {
    const res = await post<{ code: string }>("/api/invites");
    // Build the link from the address the admin is using, which is what friends will use too.
    setLink(`${location.origin}/register?code=${encodeURIComponent(res.code)}`);
    await router.invalidate();
  });

  return (
    <main className="page stack" style={{ maxWidth: 820 }}>
      <h1>Admin</h1>
      <section className="card body stack-sm">
        <h2 style={{ margin: 0 }}>Access</h2>
        <ErrorNote error={setAnonymous.error} />
        <label className="radio" style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={allowVisitors} onChange={(e) => setAnonymous.run(e.target.checked)} disabled={setAnonymous.pending} />
          <span>
            Let visitors without an account read public repositories
            <span className="hint" style={{ display: "block" }}>
              They can browse and clone public repositories and read their issues and pull requests. Everything else still needs an account. Leave this off if
              people outside your team can reach this server.
            </span>
          </span>
        </label>
        <ErrorNote error={setCi.error} />
        <label className="radio" style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={allowCi} onChange={(e) => setCi.run(e.target.checked)} disabled={setCi.pending} />
          <span>
            Run CI jobs on this server
            <span className="hint" style={{ display: "block" }}>
              Repositories that turn CI on run the commands in their <code>.ether/ci.yml</code> on this machine, as the user Ether runs as. Only allow this
              if you trust everyone with write access to those repositories.
            </span>
          </span>
        </label>
        {saved && (
          <span role="status" className="muted">
            {saved}
          </span>
        )}
      </section>
      <section className="card">
        <header>
          <h2 style={{ margin: 0 }}>Invites</h2>
          <span className="spacer" />
          <button className="primary" onClick={() => invite.run()} disabled={invite.pending}>
            Create invite link
          </button>
        </header>
        <div className="body">
          <ErrorNote error={invite.error} />
          {link && (
            <div className="notice" style={{ marginBottom: 12 }}>
              <p style={{ marginTop: 0 }}>Send this one-time link to your friend. It expires in 7 days.</p>
              <div className="clone">
                <code aria-label="Invite link">{link}</code>
                <CopyButton text={link} />
              </div>
            </div>
          )}
          {invites.length === 0 ? (
            <p className="muted">No invites yet.</p>
          ) : (
            <ul className="list">
              {invites.map((i, n) => (
                <li key={n}>
                  <span>Created {timeAgo(i.createdAt)}</span>
                  <span className="spacer" />
                  <span className="muted">
                    {i.usedBy ? `Used by ${i.usedBy}` : new Date(i.expiresAt) < new Date() ? "Expired" : `Expires ${timeAgo(i.expiresAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section className="card">
        <header>
          <h2 style={{ margin: 0 }}>Users</h2>
        </header>
        <ul className="list">
          {users.map((u) => (
            <li key={u.username}>
              <strong>{u.username}</strong>
              {u.isAdmin && <span className="badge">admin</span>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
