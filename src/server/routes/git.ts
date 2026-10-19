import { Elysia } from "elysia";
import { allows, repoAccess, tokenUser, type RepoAccess } from "../access";
import { NAME_RE, repoExists } from "../git";
import { advertiseRefs, basicCredentials, challenge, runService, type Service } from "../smart-http";

const SERVICES = new Set<Service>(["git-upload-pack", "git-receive-pack"]);

// Git authenticates with username + personal access token over HTTP Basic. Every request,
// reads included, is challenged until it carries valid credentials.
function authorize(req: Request, owner: string, repoParam: string, service: Service): RepoAccess | Response {
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
  return access;
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
  .post("/:owner/:repo/git-receive-pack", { parse: "none" }, ({ request, params }) => {
    const access = authorize(request, params.owner, params.repo, "git-receive-pack");
    return access instanceof Response ? access : runService("git-receive-pack", access.path, request);
  });
