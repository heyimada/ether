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
    const [invites, users, instance, ci] = await Promise.all([
      api<{ invites: Invite[] }>("/api/invites"),
      api<{ users: UserRow[] }>("/api/users"),
      api<{ anonymousRead: boolean; ciEnabled: boolean; ciIsolation: "container" | "host" }>("/api/instance"),
      api<{ runtime: string | null }>("/api/admin/ci-runtime"),
    ]);
    return { invites: invites.invites, users: users.users.filter((u) => !u.isOrg), instance, runtime: ci.runtime };
  },
  component: Admin,
});

function Admin() {
  const router = useRouter();
  const { invites, users, instance, runtime } = Route.useLoaderData();
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
  const [isolation, setIsolationState] = useState(instance.ciIsolation);
  const setIsolation = useAction(async (ciIsolation: "container" | "host") => {
    setSaved("");
    const before = isolation;
    setIsolationState(ciIsolation);
    try {
      await put("/api/admin/settings", { ciIsolation });
    } catch (e) {
      setIsolationState(before);
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
    <main className="page stack max-w-[820px]">
      <h1>Admin</h1>
      <section className="card body stack-sm">
        <h2 className="m-0">Access</h2>
        <ErrorNote error={setAnonymous.error} />
        <label className="radio items-start">
          <input type="checkbox" checked={allowVisitors} onChange={(e) => setAnonymous.run(e.target.checked)} disabled={setAnonymous.pending} />
          <span>
            Let visitors without an account read public repositories
            <span className="hint block">
              They can browse and clone public repositories and read their issues and pull requests. Everything else still needs an account. Leave this off if
              people outside your team can reach this server.
            </span>
          </span>
        </label>
        <ErrorNote error={setCi.error} />
        <label className="radio items-start">
          <input type="checkbox" checked={allowCi} onChange={(e) => setCi.run(e.target.checked)} disabled={setCi.pending} />
          <span>
            Run CI jobs on this server
            <span className="hint block">
              Repositories that turn CI on run the commands in their workflows (<code>.ether/workflows/</code>) when someone pushes, opens a pull request or starts one.
            </span>
          </span>
        </label>
        {allowCi && (
          <fieldset className="stack-sm m-0 border-0 p-0 pl-7">
            <legend className="text-muted p-0">
              Where jobs run
            </legend>
            <ErrorNote error={setIsolation.error} />
            <label className="radio items-start">
              <input type="radio" name="ci-isolation" checked={isolation === "container"} onChange={() => setIsolation.run("container")} disabled={setIsolation.pending} />
              <span>
                In a container per job (recommended)
                <span className="hint block">
                  {runtime ? (
                    <>
                      Uses <code>{runtime}</code>. Jobs get a copy of the checkout and can't read this server's files. Repository secrets are only passed to
                      these jobs.
                    </>
                  ) : (
                    <>No container runtime found. Install Docker or Podman on this machine, or jobs will fail with a message saying so.</>
                  )}
                </span>
              </span>
            </label>
            <label className="radio items-start">
              <input type="radio" name="ci-isolation" checked={isolation === "host"} onChange={() => setIsolation.run("host")} disabled={setIsolation.pending} />
              <span>
                On this machine, as the user Ether runs as (unsafe)
                <span className="hint block">
                  Jobs can read Ether's data folder, including the database and the auth secret, so everyone with write access to a repository with CI
                  controls the server. Jobs that use secrets are refused.
                </span>
              </span>
            </label>
          </fieldset>
        )}
        {saved && (
          <span role="status" className="text-muted">
            {saved}
          </span>
        )}
      </section>
      <section className="card">
        <header>
          <h2 className="m-0">Invites</h2>
          <span className="flex-1" />
          <button className="primary" onClick={() => invite.run()} disabled={invite.pending}>
            Create invite link
          </button>
        </header>
        <div className="body">
          <ErrorNote error={invite.error} />
          {link && (
            <div className="notice mb-3">
              <p className="mt-0">Send this one-time link to your friend. It expires in 7 days.</p>
              <div className="flex items-center gap-2">
                <code aria-label="Invite link">{link}</code>
                <CopyButton text={link} />
              </div>
            </div>
          )}
          {invites.length === 0 ? (
            <p className="text-muted">No invites yet.</p>
          ) : (
            <ul className="list">
              {invites.map((i, n) => (
                <li key={n}>
                  <span>Created {timeAgo(i.createdAt)}</span>
                  <span className="flex-1" />
                  <span className="text-muted">
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
          <h2 className="m-0">Users</h2>
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
