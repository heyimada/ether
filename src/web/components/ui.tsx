import { useRouterState } from "@tanstack/react-router";
import { Check, CircleCheck, CircleDot, Copy, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquareText, Workflow } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useContext, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { snappy } from "../lib/motion";

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
      className="small copy-button"
      data-copied={copied || undefined}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={copied ? "done" : "copy"} className="copy-icon" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={snappy}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </motion.span>
      </AnimatePresence>
      {copied ? "Copied" : label}
    </button>
  );
}

// A tab bar whose underline slides to the current tab. Which tab is current stays the
// links' business; the bar only finds it, so `activeSelector` names how they mark it.
export function TabBar({ label, className = "tabs", activeSelector = '[data-status="active"]', children }: { label: string; className?: string; activeSelector?: string; children: ReactNode }) {
  const nav = useRef<HTMLElement>(null);
  const href = useRouterState({ select: (s) => s.location.href });
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector<HTMLElement>(activeSelector);
      setBar(active ? { x: active.offsetLeft, w: active.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [href, activeSelector, children]);
  return (
    <nav ref={nav} className={`${className} tab-bar`} aria-label={label}>
      {children}
      {bar && <motion.span className="tab-indicator" aria-hidden initial={false} animate={{ x: bar.x, scaleX: bar.w }} transition={snappy} />}
    </nav>
  );
}

// A thin bar along the top while the router loads the next page. It only shows up when a
// load takes long enough to notice (see the delay in styles.css).
export function RouteProgress() {
  const loading = useRouterState({ select: (s) => s.isLoading });
  return <div className="route-progress" data-state={loading ? "loading" : "idle"} aria-hidden />;
}

// Brand header for the signed-out pages, which double as Ether's front door: what Ether is
// on one side, the form on the other. On phones the pitch shrinks to the brand line.
export function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="auth">
      <section className="auth-hero">
        <div className="auth-brand">
          <span className="brand-mark brand-mark-lg" aria-hidden />
          <p className="auth-name">Ether</p>
        </div>
        <p className="auth-headline">Code hosting and review, on a server you own.</p>
        <p className="muted auth-tag">Self-hosted code hosting and review for your team.</p>
        <ul className="auth-features">
          <li>
            <GitBranch size={16} aria-hidden /> Git over HTTPS and SSH
          </li>
          <li>
            <GitPullRequest size={16} aria-hidden /> Pull requests with line-by-line reviews
          </li>
          <li>
            <MessageSquareText size={16} aria-hidden /> Issues, labels, wikis and releases
          </li>
          <li>
            <Workflow size={16} aria-hidden /> Checks that run on every push
          </li>
        </ul>
        <AuthPreview />
      </section>
      <section className="auth-panel stack">
        <h1 className="auth-title">{title}</h1>
        {children}
        <p className="auth-footer muted">{footer}</p>
      </section>
    </main>
  );
}

// A still life of a pull request, drawn from the app's own pieces. Decoration only.
function AuthPreview() {
  return (
    <div className="auth-preview card" aria-hidden>
      <div className="auth-preview-head">
        <GitPullRequest size={16} className="state-icon-open" />
        <span className="auth-preview-title">Add analytical parser</span>
        <span className="muted">#42</span>
      </div>
      <div className="auth-preview-diff mono">
        <span className="dl-hunk">@@ -1,3 +1,4 @@</span>
        <span>{"  export function parse(input: string) {"}</span>
        <span className="dl-del">{"-   return input.split(' ');"}</span>
        <span className="dl-add">{"+   return input.split(/\\s+/)"}</span>
        <span className="dl-add">{"+     .filter(Boolean);"}</span>
        <span>{"  }"}</span>
      </div>
      <div className="auth-preview-foot">
        <span className="avatar">M</span>
        <span className="review-approved auth-preview-chip">
          <Check size={14} /> Approved
        </span>
        <span className="ci-success auth-preview-chip">
          <CircleCheck size={14} /> Checks passed
        </span>
      </div>
    </div>
  );
}
