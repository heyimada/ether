import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { DiffView } from "../components/content";
import { Conversation, IssueHeader } from "../components/conversation";
import { IssueSidebar } from "../components/labels";
import { ErrorNote, useAction } from "../components/ui";
import { api, post, repoApi, shortSha, type Comment, type Commit, type Issue } from "../lib/api";

type PullData = {
  pull: Issue;
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
      <nav className="tabs subtabs" aria-label="Pull request">
        <Link to="/$owner/$repo/pull/$number" params={params} search={{}} className={!tab ? "active" : ""}>
          Conversation
        </Link>
        <Link to="/$owner/$repo/pull/$number" params={params} search={{ tab: "commits" }} className={tab === "commits" ? "active" : ""}>
          Commits<span className="count">{data.commits.length}</span>
        </Link>
        <Link to="/$owner/$repo/pull/$number" params={params} search={{ tab: "files" }} className={tab === "files" ? "active" : ""}>
          Files changed
        </Link>
      </nav>
      {tab === "files" ? (
        <DiffView diff={data.diff} truncated={data.truncated} />
      ) : tab === "commits" ? (
        <section className="card">
          <ul className="list">
            {data.commits.map((c) => (
              <li key={c.sha}>
                <Link to="/$owner/$repo/commit/$sha" params={{ owner: info.repo.owner, repo: info.repo.name, sha: c.sha }}>
                  {c.subject}
                </Link>
                <span className="spacer" />
                <code className="muted">{shortSha(c.sha)}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="issue-layout">
          <div className="timeline">
            <Conversation info={info} issue={pull} comments={data.comments} me={me?.username ?? null} />
            <MergeBox data={data} />
          </div>
          <IssueSidebar info={info} issue={pull} />
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
  const blocked = !data.mergeable;
  return (
    <section className={`card body merge-box ${blocked ? "blocked conflict" : ""}`}>
      <ErrorNote error={merge.error} />
      {data.missing ? (
        <p>A branch of this pull request no longer exists.</p>
      ) : blocked ? (
        <>
          <p style={{ marginTop: 0 }}>
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
        <p style={{ marginTop: 0 }}>
          <strong>This branch has no conflicts with the base branch.</strong>
        </p>
      )}
      {canMerge ? (
        <button className="primary" onClick={() => merge.run()} disabled={blocked || merge.pending}>
          Merge pull request
        </button>
      ) : (
        <p className="muted">Only collaborators with write access can merge.</p>
      )}
    </section>
  );
}
