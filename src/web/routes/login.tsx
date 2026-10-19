import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AuthShell, ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { next?: string } => ({ next: typeof s.next === "string" ? s.next : undefined }),
  component: Login,
});

function Login() {
  const router = useRouter();
  const { next } = Route.useSearch();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useAction(async () => {
    const { error } = await authClient.signIn.username({ username, password });
    if (error) throw new Error(error.message ?? "Sign-in failed");
    await router.invalidate();
    // Only follow same-origin relative redirects.
    await router.history.push(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
  });

  return (
    <AuthShell
      title="Sign in"
      footer={
        <>
          Ether is invite-only. Got an invite link? Open it, or <Link to="/register">enter the code here</Link>.
        </>
      }
    >
      <form className="card body" onSubmit={onSubmit(signIn.run)}>
        <ErrorNote error={signIn.error} />
        <Field id="username" label="Username">
          <input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </Field>
        <Field id="password" label="Password">
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="primary wide" disabled={signIn.pending}>
          {signIn.pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}
