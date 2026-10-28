import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ProfileSettings, loadMyProfile } from "../components/profile-settings";
import { SshKeys, loadSshKeys } from "../components/ssh-keys";
import { CopyButton, ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { ACCENT_PRESETS, DEFAULT_ACCENT, applyAccent, type Theme } from "../lib/accent";
import { api, del, post, put, timeAgo } from "../lib/api";
import { requireAccount } from "../lib/require-account";

type Token = { id: number; name: string; createdAt: string; lastUsedAt: string | null };

export const Route = createFileRoute("/_authed/settings")({
  beforeLoad: ({ context, location }) => requireAccount(context.me, location.href),
  loader: async () => {
    const [{ tokens }, profile, { repos }, sshKeys] = await Promise.all([
      api<{ tokens: Token[] }>("/api/tokens"),
      loadMyProfile(),
      api<{ repos: { owner: string; name: string }[] }>("/api/repos"),
      loadSshKeys(),
    ]);
    return { tokens, profile, repos: repos.map((r) => `${r.owner}/${r.name}`), sshKeys };
  },
  component: Settings,
});

function Settings() {
  const router = useRouter();
  const { me } = Route.useRouteContext();
  const { tokens, profile, repos, sshKeys } = Route.useLoaderData();
  const { instance } = Route.useRouteContext();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction(async () => {
    const res = await post<{ token: string }>("/api/tokens", { name });
    setCreated(res.token);
    setName("");
    await router.invalidate();
  });
  const revoke = useAction(async (id: number) => {
    await del(`/api/tokens/${id}`);
    await router.invalidate();
  });

  return (
    <main className="page stack max-w-[760px]">
      <h1>Settings</h1>
      <ProfileSettings me={me.username} data={profile} repos={repos} />
      <Appearance saved={me.accent} savedTheme={me.theme} />
      <SshKeys keys={sshKeys} sshBase={instance.sshBase} hostKey={instance.sshHostKey} />
      <h2>Access tokens</h2>
      <p className="text-muted">
        Git uses personal access tokens instead of your password. When git asks for credentials, enter <code>{me.username}</code> as the username and a
        token as the password.
      </p>
      <form className="card body" onSubmit={onSubmit(create.run)}>
        <ErrorNote error={create.error} />
        <Field id="token-name" label="Token name" hint="For example the machine it’s used on.">
          <input id="token-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <button className="primary" disabled={create.pending}>
          Generate token
        </button>
        {created && (
          <div className="notice mt-4">
            <p className="mt-0">Copy this token now. It won’t be shown again.</p>
            <div className="flex items-center gap-2">
              <code aria-label="New token">{created}</code>
              <CopyButton text={created} />
            </div>
          </div>
        )}
      </form>
      <section className="card">
        <header>
          <h2 className="m-0">Your tokens</h2>
        </header>
        <ErrorNote error={revoke.error} />
        {tokens.length === 0 ? (
          <p className="empty">No tokens yet.</p>
        ) : (
          <ul className="list">
            {tokens.map((t) => (
              <li key={t.id}>
                <div>
                  <strong>{t.name}</strong>
                  <div className="text-muted">
                    Created {timeAgo(t.createdAt)} · {t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                <span className="flex-1" />
                <button className="danger small" onClick={() => revoke.run(t.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

const THEMES = [
  { value: null, label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function Appearance({ saved, savedTheme }: { saved: string | null; savedTheme: Theme }) {
  const router = useRouter();
  const [accent, setAccent] = useState(saved ?? DEFAULT_ACCENT);
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [status, setStatus] = useState("");
  // Preview while choosing; leaving the page without saving restores the saved accent.
  useEffect(() => {
    applyAccent(accent === DEFAULT_ACCENT ? null : accent);
  }, [accent]);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(
    () => () => {
      applyAccent(savedRef.current);
    },
    [],
  );
  // The theme saves as soon as it is picked; there is nothing to preview first.
  const saveTheme = useAction(async (next: Theme) => {
    setTheme(next);
    setStatus("");
    await put("/api/me/appearance", { theme: next });
    setStatus("Theme saved");
    await router.invalidate();
  });
  const save = useAction(async () => {
    await put("/api/me/appearance", { accent: accent === DEFAULT_ACCENT ? null : accent });
    setStatus("Accent saved");
    await router.invalidate();
  });
  const choose = (hex: string) => {
    setAccent(hex);
    setStatus("");
  };

  return (
    <section className="card">
      <header>
        <h2 className="m-0">Appearance</h2>
      </header>
      <form className="body stack-sm" onSubmit={onSubmit(save.run)}>
        <ErrorNote error={save.error ?? saveTheme.error} />
        <fieldset className="m-0 flex flex-wrap items-center gap-4 border-0 p-0">
          <legend className="mb-2 p-0 font-semibold">Theme</legend>
          {THEMES.map((t) => (
            <label key={t.label} className="radio">
              <input type="radio" name="theme" checked={theme === t.value} onChange={() => saveTheme.run(t.value)} disabled={saveTheme.pending} />
              {t.label}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <label className="m-0" htmlFor="accent">
            Accent colour
          </label>
          <input id="accent" type="color" className="h-8 w-12 cursor-pointer p-0.5" value={accent} onChange={(e) => choose(e.target.value)} />
          <code className="text-muted">{accent}</code>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested accents">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.hex}
              type="button"
              className="size-8 min-h-0 rounded-full border-2 border-surface p-0 [box-shadow:0_0_0_1px_var(--border)] [transition:box-shadow_var(--dur)_ease,transform_var(--dur)_var(--ease-out)] hover:[transform:scale(1.1)] aria-pressed:[box-shadow:0_0_0_2px_var(--text)]"
              style={{ background: p.hex }}
              aria-label={p.hex === DEFAULT_ACCENT ? `${p.name} (default)` : p.name}
              aria-pressed={accent === p.hex}
              onClick={() => choose(p.hex)}
            />
          ))}
        </div>
        <p className="hint m-0">
          Any colour works. Ether adjusts its lightness where needed so text and buttons stay readable in light and dark mode.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button className="primary" disabled={save.pending}>
            Save accent
          </button>
          <button type="button" onClick={() => choose(DEFAULT_ACCENT)} disabled={accent === DEFAULT_ACCENT}>
            Use default
          </button>
          {status && (
            <span role="status" className="text-muted">
              {status}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
