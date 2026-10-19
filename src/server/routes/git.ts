import { Elysia } from "elysia";
import { existsSync } from "node:fs";
import { VISITOR, allows, anonymousRead, repoAccess, tokenUser, type RepoAccess, type Viewer } from "../access";
import { recordPush } from "../contrib";
import { NAME_RE, ensureWiki, listRefs, newAuthorEmails, repoExists, wikiPath } from "../git";
import { advertiseRefs, basicCredentials, challenge, runService, type Service } from "../smart-http";

const SERVICES = new Set<Service>(["git-upload-pack", "git-receive-pack"]);

// Git authenticates with username + personal access token over HTTP Basic. Every request is
// challenged until it carries valid credentials, except reads of public repositories when an
// admin lets visitors without an account read them.
async function authorize(req: Request, owner: string, repoParam: string, service: Service): Promise<(RepoAccess & { viewer: Viewer }) | Response> {
  if (!repoParam.endsWith(".git")) return new Response("Not found\n", { status: 404 });
  const name = repoParam.slice(0, -4);
  if (!NAME_RE.test(owner) || !NAME_RE.test(name) || name.startsWith(".")) return new Response("Not found\n", { status: 404 });

  const creds = basicCredentials(req);
  // Without credentials, reads of public repositories may proceed as the visitor when the
  // admin allows it; anything else is challenged so git asks for a token.
  const viewer = creds ? tokenUser(creds.username, creds.secret) : service === "git-upload-pack" && anonymousRead() ? VISITOR : null;
  if (!viewer) return challenge();

  // `<repo>.wiki.git` is the repository's wiki, with the repository's permissions.
  const isWiki = name.endsWith(".wiki");
  const repo = repoAccess(viewer, owner, isWiki ? name.slice(0, -5) : name);
  if (!repo && viewer === VISITOR) return challenge();
  if (!repo || !repoExists(repo.path)) return new Response("Repository not found\n", { status: 404 });
  const need = service === "git-receive-pack" ? "write" : "read";
  if (!allows(repo.role, need)) return new Response(`You need ${need} access to this repository\n`, { status: 403 });
  if (!isWiki) return { ...repo, viewer };
  if (!existsSync(wikiPath(repo.path))) await ensureWiki(repo.path);
  return { ...repo, path: wikiPath(repo.path), viewer };
}

export const gitRoutes = new Elysia()
  .get("/:owner/:repo/info/refs", async ({ request, params, query }) => {
    const service = query.service as Service;
    if (!SERVICES.has(service)) return new Response("Dumb HTTP is not supported\n", { status: 400 });
    const access = await authorize(request, params.owner, params.repo, service);
    return access instanceof Response ? access : advertiseRefs(service, access.path);
  })
  .post("/:owner/:repo/git-upload-pack", { parse: "none" }, async ({ request, params }) => {
    const access = await authorize(request, params.owner, params.repo, "git-upload-pack");
    return access instanceof Response ? access : runService("git-upload-pack", access.path, request);
  })
  .post("/:owner/:repo/git-receive-pack", { parse: "none" }, async ({ request, params }) => {
    const access = await authorize(request, params.owner, params.repo, "git-receive-pack");
    if (access instanceof Response) return access;
    const before = (await listRefs(access.path)).map((r) => r.sha);
    // Learn the pusher's commit emails from what the push brought in.
    return runService("git-receive-pack", access.path, request, async () => {
      const after = (await listRefs(access.path)).map((r) => r.sha);
      recordPush(access.viewer.id, await newAuthorEmails(access.path, before, after));
    });
  });
