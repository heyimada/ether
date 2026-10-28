import { Elysia } from "elysia";
import { existsSync } from "node:fs";
import { VISITOR, allows, anonymousRead, repoAccess, tokenUser, type RepoAccess, type Viewer } from "../access";
import { onPush } from "../ci";
import { recordPush } from "../contrib";
import { recordPushEvents } from "../events";
import { NAME_RE, ensureWiki, listRefs, newAuthorEmails, repoExists, wikiPath } from "../git";
import { ProtectionUnavailable, receivePackGuard, type Guard } from "../protection";
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

// The repository's branch rules for receive-pack, or a plain-text refusal git shows as "remote: …".
function guardOrRefusal(repoId: number, hasBranches: boolean): Guard | Response {
  try {
    return receivePackGuard(repoId, hasBranches);
  } catch (e) {
    if (e instanceof ProtectionUnavailable) return new Response(`${e.message}\n`, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    throw e;
  }
}

export const gitRoutes = new Elysia()
  .get("/:owner/:repo/info/refs", async ({ request, params, query }) => {
    const service = query.service as Service;
    if (!SERVICES.has(service)) return new Response("Dumb HTTP is not supported\n", { status: 400 });
    const access = await authorize(request, params.owner, params.repo, service);
    if (access instanceof Response) return access;
    // git only shows the reason for a refusal at this first step, so an unusable hook is reported here too.
    if (service === "git-receive-pack" && !access.path.endsWith(".wiki.git")) {
      const refused = guardOrRefusal(access.repo.id, (await listRefs(access.path)).some((r) => r.kind === "branch"));
      if (refused instanceof Response) return refused;
    }
    return advertiseRefs(service, access.path);
  })
  .post("/:owner/:repo/git-upload-pack", { parse: "none" }, async ({ request, params }) => {
    const access = await authorize(request, params.owner, params.repo, "git-upload-pack");
    return access instanceof Response ? access : runService("git-upload-pack", access.path, request);
  })
  .post("/:owner/:repo/git-receive-pack", { parse: "none" }, async ({ request, params }) => {
    const access = await authorize(request, params.owner, params.repo, "git-receive-pack");
    if (access instanceof Response) return access;
    const before = await listRefs(access.path);
    // Branch rules guard the repository's code, not its wiki.
    const guard = access.path.endsWith(".wiki.git") ? undefined : guardOrRefusal(access.repo.id, before.some((r) => r.kind === "branch"));
    if (guard instanceof Response) return guard;
    // Learn the pusher's commit emails from what the push brought in, and start CI.
    return runService("git-receive-pack", access.path, request, async () => {
      const after = await listRefs(access.path);
      recordPush(access.viewer.id, await newAuthorEmails(access.path, before.map((r) => r.sha), after.map((r) => r.sha)));
      // A wiki push moves the wiki's own main, which is not news about the repository's code.
      if (access.path.endsWith(".wiki.git")) return;
      await recordPushEvents(access.repo.id, access.viewer.id, access.path, before, after);
      await onPush(access.repo.id, access.path, before, after, access.viewer.id);
    }, guard);
  });
