import { Elysia } from "elysia";
import { allows, repoAccess, tokenUser, type RepoAccess, type Viewer } from "../access";
import { recordPush } from "../contrib";
import { NAME_RE, listRefs, newAuthorEmails, repoExists } from "../git";
import { advertiseRefs, basicCredentials, challenge, runService, type Service } from "../smart-http";

const SERVICES = new Set<Service>(["git-upload-pack", "git-receive-pack"]);

// Git authenticates with username + personal access token over HTTP Basic. Every request,
// reads included, is challenged until it carries valid credentials.
function authorize(req: Request, owner: string, repoParam: string, service: Service): (RepoAccess & { viewer: Viewer }) | Response {
  if (!repoParam.endsWith(".git")) return new Response("Not found\n", { status: 404 });
  const name = repoParam.slice(0, -4);
  if (!NAME_RE.test(owner) || !NAME_RE.test(name) || name.startsWith(".")) return new Response("Not found\n", { status: 404 });

  const creds = basicCredentials(req);
  const viewer = creds && tokenUser(creds.username, creds.secret);
  if (!viewer) return challenge();

  const access = repoAccess(viewer, owner, name);
  if (!access || !repoExists(access.path)) return new Response("Repository not found\n", { status: 404 });
  const need = service === "git-receive-pack" ? "write" : "read";
  if (!allows(access.role, need)) return new Response(`You need ${need} access to this repository\n`, { status: 403 });
  return { ...access, viewer };
}

export const gitRoutes = new Elysia()
  .get("/:owner/:repo/info/refs", ({ request, params, query }) => {
    const service = query.service as Service;
    if (!SERVICES.has(service)) return new Response("Dumb HTTP is not supported\n", { status: 400 });
    const access = authorize(request, params.owner, params.repo, service);
    return access instanceof Response ? access : advertiseRefs(service, access.path);
  })
  .post("/:owner/:repo/git-upload-pack", { parse: "none" }, ({ request, params }) => {
    const access = authorize(request, params.owner, params.repo, "git-upload-pack");
    return access instanceof Response ? access : runService("git-upload-pack", access.path, request);
  })
  .post("/:owner/:repo/git-receive-pack", { parse: "none" }, async ({ request, params }) => {
    const access = authorize(request, params.owner, params.repo, "git-receive-pack");
    if (access instanceof Response) return access;
    const before = (await listRefs(access.path)).map((r) => r.sha);
    // Learn the pusher's commit emails from what the push brought in.
    return runService("git-receive-pack", access.path, request, async () => {
      const after = (await listRefs(access.path)).map((r) => r.sha);
      recordPush(access.viewer.id, await newAuthorEmails(access.path, before, after));
    });
  });
