import { REPO } from "./config";

// Only the GitHub calls review.ts and gate.ts make. Reads use the workflow's GITHUB_TOKEN; writes use the
// review App's installation token, so its comments and check run are attributed to the App.

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  state: string;
  user: { login: string; type: string };
  labels: { name: string }[];
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { full_name: string } };
}
export interface PullFile {
  filename: string;
  status: string;
  patch?: string;
}
export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type: string } | null;
}
export interface Review {
  id: number;
  body: string;
  commit_id: string;
  user: { login: string; type: string } | null;
}
export interface Thread {
  id: string;
  isResolved: boolean;
  comment: { databaseId: number; body: string; path: string; line: number | null; byBot: boolean; login: string };
}
export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app: { slug: string } | null;
}
export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}
export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export type GitHub = ReturnType<typeof github>;

export function github(token: string) {
  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path.replace(API, "")}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }
  const rest = async <T>(method: string, path: string, body?: unknown) => (await request(method, path, body)).json() as Promise<T>;

  async function paginate<T>(path: string, pick: (page: any) => T[] = (p) => p): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      const res = await request("GET", url);
      out.push(...pick(await res.json()));
      url = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return out;
  }

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await rest<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", { query, variables });
    if (res.errors?.length || !res.data) throw new Error(`GitHub GraphQL: ${res.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
    return res.data;
  }

  const repo = `/repos/${REPO}`;
  const [owner, name] = REPO.split("/");

  return {
    pull: (n: number) => rest<Pull>("GET", `${repo}/pulls/${n}`),
    openPulls: () => paginate<Pull>(`${repo}/pulls?state=open`),
    pullFiles: (n: number) => paginate<PullFile>(`${repo}/pulls/${n}/files`),
    // Three-dot compare: the changes on head since it diverged from base. status is "ahead" when base is an ancestor.
    compare: (base: string, head: string) => rest<{ status: string; files?: PullFile[] }>("GET", `${repo}/compare/${base}...${head}`),
    permission: async (login: string) =>
      (await rest<{ permission: Permission }>("GET", `${repo}/collaborators/${encodeURIComponent(login)}/permission`)).permission,
    issueComments: (n: number) => paginate<IssueComment>(`${repo}/issues/${n}/comments`),
    createIssueComment: (n: number, body: string) => rest<IssueComment>("POST", `${repo}/issues/${n}/comments`, { body }),
    updateIssueComment: (id: number, body: string) => rest<IssueComment>("PATCH", `${repo}/issues/comments/${id}`, { body }),
    createReview: (n: number, review: { commit_id: string; body: string; comments: ReviewComment[] }) =>
      rest<Review>("POST", `${repo}/pulls/${n}/reviews`, { ...review, event: "COMMENT" }),
    reply: (n: number, commentId: number, body: string) => rest("POST", `${repo}/pulls/${n}/comments/${commentId}/replies`, { body }),
    async threads(n: number): Promise<Thread[]> {
      const out: Thread[] = [];
      let after: string | null = null;
      do {
        const data: any = await graphql(
          `query($owner: String!, $name: String!, $n: Int!, $after: String) {
            repository(owner: $owner, name: $name) { pullRequest(number: $n) { reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id isResolved comments(first: 1) { nodes { databaseId body path line author { __typename login } } } }
            } } }
          }`,
          { owner, name, n, after },
        );
        const page = data.repository.pullRequest.reviewThreads;
        for (const t of page.nodes) {
          const c = t.comments.nodes[0];
          if (!c) continue;
          // GraphQL drops the "[bot]" suffix from App logins; __typename tells a Bot from a user with the same name.
          out.push({ id: t.id, isResolved: t.isResolved, comment: { databaseId: c.databaseId, body: c.body, path: c.path, line: c.line, byBot: c.author?.__typename === "Bot", login: c.author?.login ?? "" } });
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return out;
    },
    resolveThread: (threadId: string) =>
      graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id: threadId }),
    checkRuns: (sha: string) => paginate<CheckRun>(`${repo}/commits/${sha}/check-runs`, (p) => p.check_runs),
    createCheckRun: (run: { name: string; head_sha: string; status: "completed"; conclusion: string; output: { title: string; summary: string } }) =>
      rest<CheckRun>("POST", `${repo}/check-runs`, run),
    updateCheckRun: (id: number, run: { status: "completed"; conclusion: string; output: { title: string; summary: string } }) =>
      rest<CheckRun>("PATCH", `${repo}/check-runs/${id}`, run),
  };
}

// Locally, a dry run reads with the GitHub CLI's login.
export function readToken(dryRun: boolean): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const gh = dryRun ? Bun.spawnSync(["gh", "auth", "token"]) : null;
  if (gh?.success) return gh.stdout.toString().trim();
  throw new Error("GITHUB_TOKEN is not set");
}

export const isBot =(user: { login: string; type: string } | null) => !user || user.type === "Bot" || user.login.endsWith("[bot]");
// REST shows App logins as "name[bot]", GraphQL as "name".
export const sameBot = (login: string, botLogin: string) => login.replace(/\[bot\]$/, "") === botLogin.replace(/\[bot\]$/, "");
// Markers are only trusted from the App itself, so nobody else can plant "already reported" or "reviewed" state.
export const isReviewBot = (user: { login: string; type: string } | null, botLogin: string) => user?.type === "Bot" && sameBot(user.login, botLogin);
