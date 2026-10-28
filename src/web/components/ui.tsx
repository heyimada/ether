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
const STATE_TEXT = { open: "text-open", closed: "text-closed", merged: "text-merged" } as const;
const STATE_FILL = { open: "bg-open", closed: "bg-closed", merged: "bg-merged" } as const;

// State as a labelled icon for list rows; the colour repeats what the icon and label say.
export function StateIcon({ state, isPull }: { state: "open" | "closed" | "merged"; isPull: boolean }) {
  const Icon = state === "merged" ? GitMerge : isPull ? (state === "open" ? GitPullRequest : GitPullRequestClosed) : state === "open" ? CircleDot : CircleCheck;
  return <Icon size={16} role="img" aria-label={STATE_LABEL[state]} aria-hidden={false} className={`shrink-0 ${STATE_TEXT[state]}`} />;
}

export function StateBadge({ state }: { state: "open" | "closed" | "merged" }) {
  return <span className={`badge border-0 px-3 py-1 text-sm text-on-state shadow-xs ${STATE_FILL[state]}`}>{state[0].toUpperCase() + state.slice(1)}</span>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`small ${copied ? "border-[color-mix(in_srgb,var(--open)_45%,var(--border))]" : ""}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={copied ? "done" : "copy"} className={`inline-flex ${copied ? "text-open" : ""}`} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={snappy}>
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
const AUTH_FEATURES = [
  { Icon: GitBranch, text: "Git over HTTPS and SSH" },
  { Icon: GitPullRequest, text: "Pull requests with line-by-line reviews" },
  { Icon: MessageSquareText, text: "Issues, labels, wikis and releases" },
  { Icon: Workflow, text: "Checks that run on every push" },
];

export function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="grid min-h-screen grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] max-xl:min-h-0 max-xl:grid-cols-1">
      <section className="auth-hero relative isolate flex flex-col justify-center gap-5 overflow-hidden border-r border-border px-[clamp(24px,6vw,88px)] py-16 max-xl:items-center max-xl:gap-2 max-xl:border-r-0 max-xl:px-4 max-xl:pt-10 max-xl:pb-2 max-xl:text-center">
        <div className="flex items-center gap-3 max-xl:flex-col max-xl:gap-2">
          <span className="brand-mark brand-mark-lg" aria-hidden />
          <p className="m-0 text-3xl font-bold tracking-tight">Ether</p>
        </div>
        <p className="mt-2 mb-0 max-w-[15ch] text-[clamp(30px,3.6vw,46px)] leading-[1.08] font-bold tracking-[-0.035em] text-balance max-xl:hidden">Code hosting and review, on a server you own.</p>
        <p className="m-0 max-w-[40ch] text-lg text-balance text-muted max-xl:max-w-[32ch] max-xl:text-base">Self-hosted code hosting and review for your team.</p>
        <ul className="mt-1 mb-0 grid max-w-[560px] list-none grid-cols-2 gap-x-5 gap-y-2.5 p-0 max-xl:hidden">
          {AUTH_FEATURES.map(({ Icon, text }) => (
            <li key={text} className="flex items-center gap-2.5 font-medium">
              <Icon size={16} aria-hidden className="box-content shrink-0 rounded-lg bg-accent-soft p-1.5 text-link" /> {text}
            </li>
          ))}
        </ul>
        <AuthPreview />
      </section>
      <section className="stack mx-auto w-full max-w-[420px] animate-page-in justify-center px-6 py-12 max-xl:px-4 max-xl:pt-6 max-xl:pb-12">
        <h1 className="m-0 text-4xl max-xl:text-center max-xl:text-2xl">{title}</h1>
        {children}
        <p className="text-sm text-balance text-muted max-xl:text-center">{footer}</p>
      </section>
    </main>
  );
}

// A still life of a pull request, drawn from the app's own pieces. Decoration only.
function AuthPreview() {
  return (
    <div className="auth-preview card mt-3 w-[min(100%,460px)] overflow-hidden text-sm shadow-raised max-xl:hidden" aria-hidden>
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3.5 py-2.5">
        <GitPullRequest size={16} className="text-open" />
        <span className="font-semibold">Add analytical parser</span>
        <span className="text-muted">#42</span>
      </div>
      <div className="auth-preview-diff flex flex-col py-1.5 font-mono text-xs">
        <span className="bg-hunk-bg text-muted">@@ -1,3 +1,4 @@</span>
        <span>{"  export function parse(input: string) {"}</span>
        <span className="bg-del-bg text-del-fg">{"-   return input.split(' ');"}</span>
        <span className="bg-add-bg text-add-fg">{"+   return input.split(/\\s+/)"}</span>
        <span className="bg-add-bg text-add-fg">{"+     .filter(Boolean);"}</span>
        <span>{"  }"}</span>
      </div>
      <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2.5">
        <span className="avatar size-[22px]">M</span>
        <span className="auth-preview-chip text-open">
          <Check size={14} /> Approved
        </span>
        <span className="auth-preview-chip text-open">
          <CircleCheck size={14} /> Checks passed
        </span>
      </div>
    </div>
  );
}
