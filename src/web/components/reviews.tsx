import * as Menu from "@radix-ui/react-dropdown-menu";
import { Link, useRouter } from "@tanstack/react-router";
import { Check, CircleDot, MessageSquare, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, post, put, repoApi, timeAgo, type Issue, type RepoInfo } from "../lib/api";
import { Markdown } from "./content";
import { Avatar, ErrorNote, onSubmit, useAction } from "./ui";

export type Review = {
  id: number;
  author: string;
  state: "approved" | "changes_requested" | "commented";
  body: string;
  commitSha: string;
  createdAt: string;
  comments: { path: string; line: number; body: string }[];
};

export type ReviewData = {
  reviews: Review[];
  reviewRequests: string[];
  reviewers: Record<string, "approved" | "changes_requested">;
  reviewDecision: "approved" | "changes_requested" | null;
  requireApproval: boolean;
};

const VERB = { approved: "approved these changes", changes_requested: "requested changes", commented: "reviewed" } as const;

// Requested and past reviewers with their latest verdict; writers pick who to ask.
export function ReviewersSection({ info, pull, data }: { info: RepoInfo; pull: Issue; data: ReviewData }) {
  const router = useRouter();
  const canEdit = info.role !== "read" && pull.state === "open";
  const [people, setPeople] = useState<string[] | null>(null);
  const [requested, setRequested] = useState(data.reviewRequests);
  useEffect(() => setRequested(data.reviewRequests), [data.reviewRequests]);
  useEffect(() => {
    if (canEdit) api<{ users: string[] }>(`${repoApi(info.repo.owner, info.repo.name)}/assignable`).then((r) => setPeople(r.users.filter((u) => u !== pull.author)));
  }, [canEdit, info.repo.owner, info.repo.name, pull.author]);
  const save = useAction(async (next: string[]) => {
    await put(`${repoApi(info.repo.owner, info.repo.name)}/pulls/${pull.number}/reviewers`, { reviewers: next });
    await router.invalidate();
  });
  const pick = (name: string) => {
    const next = requested.includes(name) ? requested.filter((x) => x !== name) : [...requested, name];
    setRequested(next);
    save.run(next);
  };
  const everyone = [...new Set([...requested, ...Object.keys(data.reviewers)])].sort();

  return (
    <section className="side-section">
      <div className="side-head">
        <h3>Reviewers</h3>
        {canEdit && (
          <Menu.Root>
            <Menu.Trigger className="ghost small" aria-label="Edit reviewers">
              <Settings2 size={16} aria-hidden />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content className="menu" align="end" sideOffset={4}>
                <Menu.Label className="menu-label">Request a review</Menu.Label>
                {(people ?? []).map((p) => (
                  <Menu.CheckboxItem key={p} className="menu-item" checked={requested.includes(p)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => pick(p)}>
                    <Check size={14} aria-hidden className={requested.includes(p) ? "" : "invisible"} />
                    <Avatar name={p} size={18} />
                    {p}
                  </Menu.CheckboxItem>
                ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
      </div>
      <ErrorNote error={save.error} />
      {everyone.length ? (
        <ul className="people" aria-label="Reviewers">
          {everyone.map((p) => {
            const verdict = requested.includes(p) ? "pending" : data.reviewers[p];
            return (
              <li key={p}>
                <Avatar name={p} />
                <Link to="/$owner" params={{ owner: p }} className="people-name">
                  {p}
                </Link>
                <span className={`review-state review-${verdict}`}>
                  {verdict === "approved" ? (
                    <>
                      <Check size={14} aria-hidden /> Approved
                    </>
                  ) : verdict === "changes_requested" ? (
                    <>
                      <X size={14} aria-hidden /> Changes requested
                    </>
                  ) : (
                    <>
                      <CircleDot size={14} aria-hidden /> Pending
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted side-text">No reviews yet</p>
      )}
    </section>
  );
}

export function ReviewList({ reviews }: { reviews: Review[] }) {
  return (
    <>
      {reviews.map((r) => (
        <article key={r.id} className={`card comment review-card review-${r.state}`} aria-label={`Review by ${r.author}`}>
          <header>
            <Avatar name={r.author} size={24} />
            <span>
              <strong>{r.author}</strong> {VERB[r.state]}
            </span>
            <span className="muted">{timeAgo(r.createdAt)}</span>
          </header>
          {r.body && <Markdown source={r.body} />}
          {r.comments.length > 0 && (
            <ul className="list review-comments">
              {r.comments.map((c, i) => (
                <li key={i} className="stack-sm" style={{ alignItems: "stretch" }}>
                  <code className="muted">
                    {c.path}:{c.line}
                  </code>
                  <Markdown source={c.body} />
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </>
  );
}

// Files from a unified diff, in order.
const changedFiles = (diff: string) => [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);

// Shown on the Files changed tab: collect line comments, then submit them with a verdict.
export function ReviewPanel({ info, pull, diff, me }: { info: RepoInfo; pull: Issue; diff: string; me: string }) {
  const router = useRouter();
  const files = useMemo(() => changedFiles(diff), [diff]);
  const [file, setFile] = useState(files[0] ?? "");
  const [line, setLine] = useState("");
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<{ path: string; line: number; body: string }[]>([]);
  const [summary, setSummary] = useState("");
  const isAuthor = pull.author === me;
  const canJudge = !isAuthor && info.role !== "read";
  const [state, setState] = useState<"commented" | "approved" | "changes_requested">("commented");
  const submit = useAction(async () => {
    await post(`${repoApi(info.repo.owner, info.repo.name)}/pulls/${pull.number}/reviews`, { state, body: summary, comments: pending });
    setPending([]);
    setSummary("");
    await router.invalidate();
    await router.navigate({ to: "/$owner/$repo/pull/$number", params: { owner: info.repo.owner, repo: info.repo.name, number: String(pull.number) }, search: {} });
  });

  return (
    <section className="card body stack-sm review-panel" aria-label="Review">
      <h2 style={{ margin: 0, fontSize: 16 }}>Review</h2>
      <ErrorNote error={submit.error} />
      {files.length > 0 && (
        <form
          className="line-comment"
          onSubmit={onSubmit(() => {
            setPending([...pending, { path: file || files[0], line: Number(line), body: comment }]);
            setComment("");
            setLine("");
          })}
        >
          <select aria-label="File" value={file || files[0]} onChange={(e) => setFile(e.target.value)}>
            {files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <input aria-label="Line" type="number" min={1} value={line} onChange={(e) => setLine(e.target.value)} required placeholder="Line" />
          <input aria-label="Line comment" value={comment} onChange={(e) => setComment(e.target.value)} required placeholder="Comment on this line" />
          <button className="small">Add line comment</button>
        </form>
      )}
      {pending.length > 0 && (
        <ul className="list card" aria-label="Pending comments">
          {pending.map((c, i) => (
            <li key={i}>
              <MessageSquare size={14} aria-hidden className="muted" />
              <code>
                {c.path}:{c.line}
              </code>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{c.body}</span>
              <span className="spacer" />
              <button className="ghost small" aria-label={`Remove comment on ${c.path}:${c.line}`} onClick={() => setPending(pending.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="stack-sm" onSubmit={onSubmit(submit.run)}>
        <label htmlFor="review-summary" style={{ margin: 0 }}>
          Review summary
        </label>
        <textarea id="review-summary" value={summary} onChange={(e) => setSummary(e.target.value)} style={{ minHeight: 80 }} placeholder="Markdown is supported" />
        <fieldset className="fieldset stack-sm" style={{ gap: 6 }}>
          <legend className="sr-only">Verdict</legend>
          <label className="radio">
            <input type="radio" name="verdict" checked={state === "commented"} onChange={() => setState("commented")} />
            Comment: general feedback without approving
          </label>
          <label className="radio">
            <input type="radio" name="verdict" checked={state === "approved"} onChange={() => setState("approved")} disabled={!canJudge} />
            Approve: these changes are ready to merge
          </label>
          <label className="radio">
            <input type="radio" name="verdict" checked={state === "changes_requested"} onChange={() => setState("changes_requested")} disabled={!canJudge} />
            Request changes: this needs work before merging
          </label>
          {isAuthor && <span className="hint">You can't approve or request changes on your own pull request.</span>}
        </fieldset>
        <div>
          <button className="primary" disabled={submit.pending}>
            Submit review
          </button>
        </div>
      </form>
    </section>
  );
}
