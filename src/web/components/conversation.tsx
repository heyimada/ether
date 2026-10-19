import { Link, useRouter } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { patch, post, repoApi, timeAgo, type Comment, type Issue, type RepoInfo } from "../lib/api";
import { Markdown } from "./content";
import { Avatar, ErrorNote, StateBadge, StateIcon, onSubmit, useAction } from "./ui";

export function IssueList({ info, kind, data, state }: { info: RepoInfo; kind: "issues" | "pulls"; data: { items: Issue[]; open: number; closed: number }; state: "open" | "closed" }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const listTo = kind === "issues" ? "/$owner/$repo/issues" : "/$owner/$repo/pulls";
  const canCreate = kind === "issues" || info.role !== "read";
  return (
    <section className="card">
      <header>
        <Link to={listTo} params={params} search={{}} className={state === "open" ? "active" : "muted"}>
          {data.open} Open
        </Link>
        <Link to={listTo} params={params} search={{ state: "closed" }} className={state === "closed" ? "active" : "muted"}>
          {data.closed} Closed
        </Link>
        <span className="spacer" />
        {canCreate && (
          <Link to={kind === "issues" ? "/$owner/$repo/issues/new" : "/$owner/$repo/pulls/new"} params={params} className="button primary">
            {kind === "issues" ? "New issue" : "New pull request"}
          </Link>
        )}
      </header>
      {data.items.length === 0 ? (
        <p className="empty">{state === "open" ? `There are no open ${kind === "issues" ? "issues" : "pull requests"}.` : "Nothing closed yet."}</p>
      ) : (
        <ul className="list">
          {data.items.map((i) => (
            <li key={i.number}>
              <StateIcon state={i.state} isPull={i.isPull} />
              <div>
                <Link
                  to={i.isPull ? "/$owner/$repo/pull/$number" : "/$owner/$repo/issues/$number"}
                  params={{ ...params, number: String(i.number) }}
                  style={{ fontWeight: 600 }}
                >
                  {i.title}
                </Link>
                <div className="muted">
                  {i.isPull ? `${i.head} → ${i.base} · ` : ""}opened {timeAgo(i.createdAt)} by {i.author}
                </div>
              </div>
              <span className="spacer" />
              {i.comments > 0 && (
                <span className="muted num" aria-label={`${i.comments} comments`}>
                  <MessageSquare size={14} aria-hidden /> {i.comments}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function IssueHeader({ issue }: { issue: Issue }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h1 className="issue-title">
        {issue.title}
        <span className="num">#{issue.number}</span>
      </h1>
      <div className="row">
        <StateBadge state={issue.state} />
        <span className="muted">
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

function CommentCard({ author, at, body }: { author: string; at: string; body: string }) {
  return (
    <section className="card comment">
      <header>
        <Avatar name={author} size={24} />
        <strong>{author}</strong>
        <span className="muted">commented {timeAgo(at)}</span>
      </header>
      <Markdown source={body} />
    </section>
  );
}

// The opening post, its comments, the reply box, and close/reopen.
export function Conversation({ info, issue, comments, me }: { info: RepoInfo; issue: Issue; comments: Comment[]; me: string }) {
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
  const canToggle = issue.state !== "merged" && (issue.author === me || info.role !== "read");
  const noun = issue.isPull ? "pull request" : "issue";

  return (
    <div className="timeline">
      <CommentCard author={issue.author} at={issue.createdAt} body={issue.body} />
      {comments.map((c) => (
        <CommentCard key={c.id} author={c.author} at={c.createdAt} body={c.body} />
      ))}
      <form className="card body stack-sm" onSubmit={onSubmit(comment.run)}>
        <ErrorNote error={comment.error ?? setState.error} />
        <label htmlFor="comment">Comment</label>
        <textarea id="comment" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdown is supported" />
        <div className="row">
          <span className="spacer" />
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
    </div>
  );
}
