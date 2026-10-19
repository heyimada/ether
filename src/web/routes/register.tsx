import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AuthShell, ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { post } from "../lib/api";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/register")({
  validateSearch: (s: Record<string, unknown>): { code?: string } => ({ code: typeof s.code === "string" ? s.code : undefined }),
  component: Register,
});

function Register() {
  const router = useRouter();
  const { code: initial } = Route.useSearch();
  const [code, setCode] = useState(initial ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const register = useAction(async () => {
    await post("/api/register", { code, username, password });
    const { error } = await authClient.signIn.username({ username, password });
    if (error) throw new Error(error.message ?? "Account created, but sign-in failed");
    await router.invalidate();
    await router.navigate({ to: "/" });
  });

  return (
    <AuthShell
      title="Create your account"
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>.
        </>
      }
    >
      <form className="card body" onSubmit={onSubmit(register.run)}>
        <ErrorNote error={register.error} />
        <Field id="code" label="Invite code" hint="Filled in for you when you open an invite link.">
          <input id="code" value={code} onChange={(e) => setCode(e.target.value)} required />
        </Field>
        <Field id="username" label="Username" hint="Letters, digits and dashes.">
          <input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,38}" />
        </Field>
        <Field id="password" label="Password" hint="At least 10 characters.">
          <input id="password" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="primary wide" disabled={register.pending}>
          {register.pending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
