import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton, ErrorNote, useAction } from "../components/ui";
import { api, post, timeAgo } from "../lib/api";

type Invite = { createdAt: string; expiresAt: string; usedBy: string | null };
type UserRow = { username: string; isAdmin: boolean };

export const Route = createFileRoute("/_authed/site-admin")({
  beforeLoad: ({ context }) => {
    if (!context.me.isAdmin) throw redirect({ to: "/" });
  },
  loader: async () => {
    const [invites, users] = await Promise.all([api<{ invites: Invite[] }>("/api/invites"), api<{ users: UserRow[] }>("/api/users")]);
    return { invites: invites.invites, users: users.users };
  },
  component: Admin,
});

function Admin() {
  const router = useRouter();
  const { invites, users } = Route.useLoaderData();
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
