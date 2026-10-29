import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { DiffView } from "../components/content";
import { Conversation, IssueHeader } from "../components/conversation";
import { CiBadge, ciDone, EVENT_LABEL, type CiEvent, type CiStatus } from "../components/ci";
import { IssueSidebar } from "../components/labels";
import { ReviewList, ReviewPanel, ReviewersSection, type ReviewData } from "../components/reviews";
import { ErrorNote, TabBar, useAction } from "../components/ui";
import { api, post, repoApi, shortSha, type Comment, type Commit, type Issue } from "../lib/api";

type PullData = ReviewData & {
  pull: Issue;
  requireChecks: boolean;
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
      <IssueHeader issue={pull} />
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
            <ReviewersSection info={info} pull={pull} data={data} />
          </IssueSidebar>
        </div>
      )}
    </div>
  );
}

function MergeBox({ data }: { data: PullData }) {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { pull } = data;
  const merge = useAction(async () => {
    await post(`${repoApi(info.repo.owner, info.repo.name)}/pulls/${pull.number}/merge`);
    await router.invalidate();
  });

  if (pull.state === "merged")
    return (
      <section className="card body merge-box done">
        <strong>{pull.mergedBy}</strong> merged this pull request in <code>{pull.mergeCommit && shortSha(pull.mergeCommit)}</code>.
      </section>
    );
  if (pull.state === "closed") return <section className="card body merge-box blocked">This pull request is closed.</section>;

  const canMerge = data.role !== "read";
  const needsApproval = data.requireApproval && data.reviewDecision !== "approved";
  const needsChecks = data.requireChecks && !!data.checks && data.checks.status !== "success";
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
      {needsApproval && (
        <p className="m-0 mb-3">
          <strong>Merging requires an approving review</strong> because this repository protects its pull requests.
        </p>
      )}
      {canMerge ? (
        <button className="primary" onClick={() => merge.run()} disabled={blocked || needsApproval || needsChecks || merge.pending}>
          Merge pull request
        </button>
      ) : (
        <p className="text-muted">Only collaborators with write access can merge.</p>
      )}
    </section>
  );
}
