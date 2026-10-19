import { CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";

// Wraps an async submit handler with pending and error state.
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...args: A) => {
    setPending(true);
    setError(null);
    try {
      await fn(...args);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error };
}

export const onSubmit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};

export function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export type Person = { username: string; isAdmin: boolean; displayName: string; avatarVersion: number | null };

// Everyone on this server, loaded once per session so avatars need no extra lookups.
export const PeopleContext = createContext<Map<string, Person>>(new Map());

export const avatarUrl = (username: string, version: number) => `/api/users/${encodeURIComponent(username)}/avatar?v=${version}`;

// A person's uploaded picture, or their initial. Git author names that match no account
// fall back to initials too. Decorative unless a label is asked for.
export function Avatar({ name, size = 20, labelled = false }: { name: string; size?: number; labelled?: boolean }) {
  const person = useContext(PeopleContext).get(name.toLowerCase());
  const style = { width: size, height: size, fontSize: Math.round(size * 0.45) };
  if (person?.avatarVersion)
    return <img className="avatar" style={style} src={avatarUrl(person.username, person.avatarVersion)} alt={labelled ? `${person.username}'s avatar` : ""} />;
  return (
    <span className="avatar" style={style} role={labelled ? "img" : undefined} aria-label={labelled ? `${name}'s avatar` : undefined} aria-hidden={labelled ? undefined : true}>
      {(person?.displayName || name).trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

const STATE_LABEL = { open: "Open", closed: "Closed", merged: "Merged" } as const;

// State as a labelled icon for list rows; the colour repeats what the icon and label say.
export function StateIcon({ state, isPull }: { state: "open" | "closed" | "merged"; isPull: boolean }) {
  const Icon = state === "merged" ? GitMerge : isPull ? (state === "open" ? GitPullRequest : GitPullRequestClosed) : state === "open" ? CircleDot : CircleCheck;
  return <Icon size={16} role="img" aria-label={STATE_LABEL[state]} aria-hidden={false} className={`state-icon state-icon-${state}`} />;
}

export function StateBadge({ state }: { state: "open" | "closed" | "merged" }) {
  return <span className={`badge state state-${state}`}>{state[0].toUpperCase() + state.slice(1)}</span>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="small"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

// Brand header for the signed-out pages, which double as Ether's front door.
export function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="narrow auth stack">
      <div className="auth-brand">
        <span className="brand-mark brand-mark-lg" aria-hidden />
        <p className="auth-name">Ether</p>
        <p className="muted auth-tag">Self-hosted code hosting and review for your team.</p>
      </div>
      <h1 className="auth-title">{title}</h1>
      {children}
      <p className="auth-footer muted">{footer}</p>
    </main>
  );
}
