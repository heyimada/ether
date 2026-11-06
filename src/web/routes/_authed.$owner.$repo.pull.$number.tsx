import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { DiffView } from "../components/content";
import { Conversation, IssueHeader } from "../components/conversation";
import { CiBadge, ciDone, EVENT_LABEL, type CiEvent, type CiStatus } from "../components/ci";
import { IssueSidebar } from "../components/labels";
import { ReviewList, ReviewPanel, ReviewersSection, type ReviewData } from "../components/reviews";
import { ErrorNote, onSubmit, TabBar, useAction } from "../components/ui";
import { api, patch, post, repoApi, shortSha, type Comment, type Commit, type Issue } from "../lib/api";

type PullData = ReviewData & {
  pull: Issue;
  requireChecks: boolean;
  requireCodeOwnerReview: boolean;
  // Open pull requests stacked with this one, bottom first (this one included); empty when it stands alone.
  stack: { number: number; title: string; draft: boolean; base: string; head: string }[];
  codeOwners: {
    path: string;
    groups: { pattern: string; line: number; owners: { name: string; valid: boolean }[]; files: string[]; fileCount: number; approvedBy: string | null }[];
    incomplete: boolean;
  } | null;
  checks: { status: CiStatus; runs: { id: number; workflow: string; event: CiEvent; status: CiStatus }[] } | null;
  deployments: { environment: string; url: string | null; runId: number }[];
  comments: Comment[];
  role: "owner" | "write" | "read";
  mergeable: boolean;
  conflicts: string[];
  commits: Commit[];
  diff: string;
  truncated: boolean;
  missing: boolean;
};

export const Route = createFileRoute("/_authed/$owner/$repo/pull/$number")({
  validateSearch: (s: Record<string, unknown>): { tab?: "files" | "commits" } => ({ tab: s.tab === "files" || s.tab === "commits" ? s.tab : undefined }),
  loader: ({ context: { info }, params }) => api<PullData>(`${repoApi(info.repo.owner, info.repo.name)}/pulls/${params.number}`),
  component: PullPage,
});

function PullPage() {
  const { info, me } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const { pull } = data;
  const params = { owner: info.repo.owner, repo: info.repo.name, number: String(pull.number) };

  return (
    <div>
      <IssueHeader issue={pull}>
        <BaseEditor pull={pull} />
      </IssueHeader>
      <TabBar label="Pull request" className="tabs subtabs" activeSelector=".active">
        <Link to="/$owner/$repo/pull/$number" params={params} search={{}} className={!tab ? "active" : ""}>
          Conversation
        </Link>
        <Link to="/$owner/$repo/pull/$number" params={params} search={{ tab: "commits" }} className={tab === "commits" ? "active" : ""}>
          Commits<span className="count">{data.commits.length}</span>
        </Link>
        <Link to="/$owner/$repo/pull/$number" params={params} search={{ tab: "files" }} className={tab === "files" ? "active" : ""}>
          Files changed
        </Link>
      </TabBar>
      {tab === "files" ? (
        <div className="stack-md">
          {me && pull.state === "open" && <ReviewPanel info={info} pull={pull} diff={data.diff} me={me.username} />}
          <DiffView diff={data.diff} truncated={data.truncated} />
        </div>
      ) : tab === "commits" ? (
        <section className="card">
          <ul className="list">
            {data.commits.map((c) => (
              <li key={c.sha}>
                <Link to="/$owner/$repo/commit/$sha" params={{ owner: info.repo.owner, repo: info.repo.name, sha: c.sha }}>
                  {c.subject}
                </Link>
                <span className="flex-1" />
                <code className="text-muted">{shortSha(c.sha)}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_240px] items-start gap-6 max-lg:grid-cols-[minmax(0,1fr)]">
          <div className="timeline">
            <Conversation info={info} issue={pull} comments={data.comments} me={me?.username ?? null} />
            <ReviewList reviews={data.reviews} />
            <MergeBox data={data} />
          </div>
          <IssueSidebar info={info} issue={pull}>
            {data.stack.length > 0 && <StackSection data={data} />}
            <ReviewersSection info={info} pull={pull} data={data} />
          </IssueSidebar>
        </div>
      )}
    </div>
  );
}

// Point an open pull request at another branch: the author or anyone with write access.
function BaseEditor({ pull }: { pull: Issue }) {
  const router = useRouter();
  const { info, me } = Route.useRouteContext();
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState(pull.base ?? "");
  const save = useAction(async () => {
    await patch(`${repoApi(info.repo.owner, info.repo.name)}/issues/${pull.number}`, { base });
    setEditing(false);
    await router.invalidate();
  });
  if (!me || pull.state !== "open" || (me.username !== pull.author && info.role === "read")) return null;
  if (!editing)
    return (
      <button className="ghost small" onClick={() => (setBase(pull.base ?? ""), setEditing(true))}>
        Change base
      </button>
    );
  return (
    <form className="inline-flex flex-wrap items-center gap-2" onSubmit={onSubmit(save.run)}>
      <label htmlFor="new-base" className="sr-only">
        Base branch
      </label>
      <select id="new-base" className="w-auto" value={base} onChange={(e) => setBase(e.target.value)}>
        {info.branches
          .filter((b) => b !== pull.head)
          .map((b) => (
            <option key={b}>{b}</option>
          ))}
      </select>
      <button className="small primary" disabled={save.pending || base === pull.base}>
        Save
      </button>
      <button type="button" className="small" onClick={() => setEditing(false)}>
        Cancel
      </button>
      <ErrorNote error={save.error} />
    </form>
  );
}

// The pull requests stacked with this one, bottom first, so reviewers can walk the stack.
function StackSection({ data }: { data: PullData }) {
  const { info } = Route.useRouteContext();
  return (
    <section>
      <h3 className="m-0 mb-2 text-base">Stack</h3>
      <ol className="m-0 p-0 list-none stack-sm" aria-label="Stack">
        {data.stack.map((p) => (
          <li key={p.number} className="flex items-baseline gap-2" aria-current={p.number === data.pull.number ? "page" : undefined}>
            <span className="text-muted tabular-nums">#{p.number}</span>
            {p.number === data.pull.number ? (
              <strong className="min-w-0 wrap-anywhere">{p.title}</strong>
            ) : (
              <Link to="/$owner/$repo/pull/$number" params={{ owner: info.repo.owner, repo: info.repo.name, number: String(p.number) }} className="min-w-0 wrap-anywhere">
                {p.title}
              </Link>
            )}
            {p.draft && <span className="badge">Draft</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function MergeBox({ data }: { data: PullData }) {
  const router = useRouter();
  const { info, me } = Route.useRouteContext();
  const { pull } = data;
  const merge = useAction(async () => {
    await post(`${repoApi(info.repo.owner, info.repo.name)}/pulls/${pull.number}/merge`);
    await router.invalidate();
  });
  const setDraft = useAction(async (draft: boolean) => {
    await patch(`${repoApi(info.repo.owner, info.repo.name)}/issues/${pull.number}`, { draft });
    await router.invalidate();
  });
  // The author can move their own pull request between draft and ready, as can anyone who can merge.
  const canToggleDraft = !!me && (me.username === pull.author || data.role !== "read");

  if (pull.state === "merged")
    return (
      <section className="card body merge-box done">
        <strong>{pull.mergedBy}</strong> merged this pull request in <code>{pull.mergeCommit && shortSha(pull.mergeCommit)}</code>.
      </section>
    );
  if (pull.state === "closed") return <section className="card body merge-box blocked">This pull request is closed.</section>;

  if (pull.draft)
    return (
      <section className="card body merge-box blocked">
        <ErrorNote error={setDraft.error} />
        <p className="mt-0">
          <strong>This pull request is still a draft.</strong> It can't be merged until it's marked ready for review.
        </p>
        {canToggleDraft && (
          <button className="primary" onClick={() => setDraft.run(false)} disabled={setDraft.pending}>
            Ready for review
          </button>
        )}
      </section>
    );

  const canMerge = data.role !== "read";
  const needsApproval = data.requireApproval && data.reviewDecision !== "approved";
  const needsChecks = data.requireChecks && !!data.checks && data.checks.status !== "success";
  // The pull request whose branch this one goes into, if it's still open.
  const below = data.stack.find((p) => p.head === pull.base);
  const owners = data.codeOwners;
  const needsOwners = data.requireCodeOwnerReview && !!owners && (owners.incomplete || owners.groups.some((g) => !g.approvedBy));
  const blocked = !data.mergeable;
  return (
    <section className={`card body merge-box ${blocked ? "blocked conflict" : ""}`}>
      <ErrorNote error={merge.error} />
      {data.missing ? (
        <p>A branch of this pull request no longer exists.</p>
      ) : blocked ? (
        <>
          <p className="mt-0">
            <strong>This branch has conflicts that must be resolved.</strong> Merge <code>{pull.base}</code> into <code>{pull.head}</code> locally, fix the
            conflicts and push.
          </p>
          {data.conflicts.length > 0 && (
            <ul>
              {data.conflicts.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="mt-0">
          <strong>This branch has no conflicts with the base branch.</strong>
        </p>
      )}
      {data.reviewDecision === "changes_requested" && <p className="m-0 mb-3 text-danger">Changes were requested in a review.</p>}
      {data.reviewDecision === "approved" && <p className="m-0 mb-3 text-open">Approved in review.</p>}
      {data.checks && (
        <div className="m-0 mb-3 stack-sm">
          <p className="m-0">
            <CiBadge status={data.checks.status} />{" "}
            <strong>{data.checks.status === "success" ? "All checks have passed" : ciDone(data.checks.status) ? "Some checks failed" : "Checks are still running"}</strong>
            {needsChecks && " · merging requires passing checks"}
          </p>
          <ul className="m-0 p-0 list-none stack-sm" aria-label="Checks">
            {data.checks.runs.map((r) => (
              <li key={r.id}>
                <CiBadge status={r.status} />{" "}
                <Link to="/$owner/$repo/ci/$id" params={{ owner: info.repo.owner, repo: info.repo.name, id: String(r.id) }}>
                  {r.workflow}
                </Link>{" "}
                <span className="text-muted">({EVENT_LABEL[r.event]})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.deployments.map((d) => (
        <p key={d.environment} className="m-0 mb-3">
          <CiBadge status="success" />{" "}
          <Link to="/$owner/$repo/ci/$id" params={{ owner: info.repo.owner, repo: info.repo.name, id: String(d.runId) }}>
            Deployed to {d.environment}
          </Link>
          {d.url && (
            <>
              {" · "}
              <a href={d.url} target="_blank" rel="noreferrer noopener">
                {d.url}
              </a>
            </>
          )}
        </p>
      ))}
      {owners && (owners.incomplete || owners.groups.length > 0) && (
        <div className="m-0 mb-3 stack-sm">
          <p className="m-0">
            <strong>{owners.incomplete ? "Code owners can't be worked out for this pull request" : owners.groups.every((g) => g.approvedBy) ? "Code owners approved" : "Waiting on code owners"}</strong>
            {needsOwners && " · merging requires their review"}
          </p>
          <ul className="m-0 p-0 list-none stack-sm" aria-label="Code owners">
            {owners.groups.map((g) => (
              <li key={g.line}>
                <span className={g.approvedBy ? "text-open" : "text-muted"}>{g.approvedBy ? "✓" : "○"}</span> <code>{g.pattern}</code>{" "}
                {g.owners.map((o, i) => (
                  <span key={o.name} className={o.valid ? "" : "text-muted line-through"} title={o.valid ? undefined : "Can't approve: not a user with write access or a team of this organization"}>
                    {i > 0 && ", "}
                    {o.name}
                  </span>
                ))}
                {g.owners.length === 0 && <span className="text-muted">no owners</span>}
                <span className="text-muted">
                  {" "}
                  · {g.approvedBy ? `approved by ${g.approvedBy}` : `${g.fileCount} file${g.fileCount === 1 ? "" : "s"}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {below && (
        <p className="m-0 mb-3">
          Stacked on{" "}
          <Link to="/$owner/$repo/pull/$number" params={{ owner: info.repo.owner, repo: info.repo.name, number: String(below.number) }}>
            #{below.number}
          </Link>
          : merging now brings these changes into <code>{pull.base}</code>. Merge #{below.number} first and this pull request moves to its base on its own.
        </p>
      )}
      {needsApproval && (
        <p className="m-0 mb-3">
          <strong>Merging requires an approving review</strong> because this repository protects its pull requests.
        </p>
      )}
      <ErrorNote error={setDraft.error} />
      <div className="flex flex-wrap items-center gap-2">
        {canMerge ? (
          <button className="primary" onClick={() => merge.run()} disabled={blocked || needsApproval || needsChecks || needsOwners || merge.pending}>
            Merge pull request
          </button>
        ) : (
          <p className="m-0 text-muted">Only collaborators with write access can merge.</p>
        )}
        {canToggleDraft && (
          <button className="small" onClick={() => setDraft.run(true)} disabled={setDraft.pending}>
            Convert to draft
          </button>
        )}
      </div>
    </section>
  );
}
