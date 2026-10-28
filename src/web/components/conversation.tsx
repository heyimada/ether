import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { rise, staggered } from "../lib/motion";
import { patch, post, repoApi, timeAgo, type Comment, type Issue, type RepoInfo } from "../lib/api";
import { Markdown } from "./content";
import { LabelPill } from "./labels";
import { Avatar, ErrorNote, onSubmit, ROW, StateBadge, StateIcon, useAction } from "./ui";

export function IssueList({
  info,
  kind,
  data,
  state,
  filter = {},
}: {
  info: RepoInfo;
  kind: "issues" | "pulls";
  data: { items: Issue[]; open: number; closed: number };
  state: "open" | "closed";
  filter?: { label?: string; assignee?: string };
}) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const listTo = kind === "issues" ? "/$owner/$repo/issues" : "/$owner/$repo/pulls";
  const { me } = useRouteContext({ from: "/_authed" });
  const canCreate = !!me && (kind === "issues" || info.role !== "read");
  return (
    <section className="card">
      <header>
        <Link to={listTo} params={params} search={{}} className={state === "open" ? "active" : "text-muted"}>
          {data.open} Open
        </Link>
        <Link to={listTo} params={params} search={{ state: "closed" }} className={state === "closed" ? "active" : "text-muted"}>
          {data.closed} Closed
        </Link>
        {(filter.label || filter.assignee) && (
          <Link to={listTo} params={params} search={state === "closed" ? { state } : {}} className="rounded-full border border-border px-2 py-0.5 text-xs text-fg">
            {filter.label ? `label: ${filter.label}` : `assignee: ${filter.assignee}`} ×
          </Link>
        )}
        <span className="flex-1" />
        {kind === "issues" && (
          <Link to="/$owner/$repo/labels" params={params} className="button small">
            Labels
          </Link>
        )}
        {canCreate && (
          <Link to={kind === "issues" ? "/$owner/$repo/issues/new" : "/$owner/$repo/pulls/new"} params={params} className="button primary">
            {kind === "issues" ? "New issue" : "New pull request"}
          </Link>
        )}
      </header>
      {data.items.length === 0 ? (
        <p className="empty">{state === "open" ? `There are no open ${kind === "issues" ? "issues" : "pull requests"}.` : "Nothing closed yet."}</p>
      ) : (
        <motion.ul className="list" {...staggered}>
          {data.items.map((i, n) => (
            <motion.li key={i.number} variants={rise} custom={n}>
              <StateIcon state={i.state} isPull={i.isPull} />
              <div>
                <Link className="font-semibold"
                  to={i.isPull ? "/$owner/$repo/pull/$number" : "/$owner/$repo/issues/$number"}
                  params={{ ...params, number: String(i.number) }}
                >
                  {i.title}
                </Link>
                {i.labels.length > 0 && (
                  <span className="my-1 inline-flex flex-wrap gap-1">
                    {i.labels.map((l) => (
                      <LabelPill key={l.name} label={l} info={kind === "issues" ? info : undefined} />
                    ))}
                  </span>
                )}
                <div className="text-muted">
                  {i.isPull ? `${i.head} → ${i.base} · ` : ""}opened {timeAgo(i.createdAt)} by {i.author}
                </div>
              </div>
              <span className="flex-1" />
              {i.assignees.length > 0 && (
                <span className="inline-flex gap-0.5" aria-label={`Assigned to ${i.assignees.join(", ")}`}>
                  {i.assignees.slice(0, 3).map((a) => (
                    <Avatar key={a} name={a} size={20} />
                  ))}
                </span>
              )}
              {i.comments > 0 && (
                <span className="text-muted tabular-nums" aria-label={`${i.comments} comments`}>
                  <MessageSquare size={14} aria-hidden /> {i.comments}
                </span>
              )}
            </motion.li>
          ))}
        </motion.ul>
      )}
    </section>
  );
}

export function IssueHeader({ issue }: { issue: Issue }) {
  return (
    <div className="mb-4">
      <h1 className="text-5xl font-semibold tracking-tighter">
        {issue.title}
        <span className="ml-2 font-normal text-muted tabular-nums">#{issue.number}</span>
      </h1>
      <div className={ROW}>
        <StateBadge state={issue.state} />
        <span className="text-muted">
          <strong>{issue.author}</strong> opened this {timeAgo(issue.createdAt)}
          {issue.isPull && (
            <>
              {" "}
              · wants to merge <code>{issue.head}</code> into <code>{issue.base}</code>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function CommentCard({ author, at, body, i = 0 }: { author: string; at: string; body: string; i?: number }) {
  return (
    <motion.section className="card comment" variants={rise} custom={i} initial="hidden" animate="visible">
      <header>
        <Avatar name={author} size={24} />
        <strong>{author}</strong>
        <span className="text-muted">commented {timeAgo(at)}</span>
      </header>
      <Markdown source={body} />
    </motion.section>
  );
}

// The opening post, its comments, the reply box, and close/reopen.
export function Conversation({ info, issue, comments, me }: { info: RepoInfo; issue: Issue; comments: Comment[]; me: string | null }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const base = `${repoApi(info.repo.owner, info.repo.name)}/issues/${issue.number}`;
  const comment = useAction(async () => {
    await post(`${base}/comments`, { body });
    setBody("");
    await router.invalidate();
  });
  const setState = useAction(async (state: "open" | "closed") => {
    await patch(base, { state });
    await router.invalidate();
  });
  const canToggle = !!me && issue.state !== "merged" && (issue.author === me || info.role !== "read");
  const noun = issue.isPull ? "pull request" : "issue";

  return (
    <div className="timeline">
      <CommentCard author={issue.author} at={issue.createdAt} body={issue.body} />
      {comments.map((c, i) => (
        <CommentCard key={c.id} author={c.author} at={c.createdAt} body={c.body} i={i + 1} />
      ))}
      {!me ? (
        <p className="card body text-muted m-0">
          <Link to="/login">Sign in</Link> to join the conversation.
        </p>
      ) : (
      <form className="card body stack-sm" onSubmit={onSubmit(comment.run)}>
        <ErrorNote error={comment.error ?? setState.error} />
        <label htmlFor="comment">Comment</label>
        <textarea id="comment" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdown is supported" />
        <div className={ROW}>
          <span className="flex-1" />
          {canToggle &&
            (issue.state === "open" ? (
              <button type="button" onClick={() => setState.run("closed")} disabled={setState.pending}>
                Close {noun}
              </button>
            ) : (
              <button type="button" onClick={() => setState.run("open")} disabled={setState.pending}>
                Reopen {noun}
              </button>
            ))}
          <button className="primary" disabled={comment.pending || !body.trim()}>
            Comment
          </button>
        </div>
      </form>
      )}
    </div>
  );
}
