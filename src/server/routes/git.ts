import { Elysia } from "elysia";
import { VISITOR, allows, anonymousRead, findRepo, repoAccess, tokenUser, type RepoAccess, type Viewer } from "../access";
import { JOB_GIT_USER, jobMayRead } from "../ci";
import { repoExists } from "../git";
import { ProtectionUnavailable } from "../protection";
import { gitDir, parseRepoName, prepareReceive, received } from "../push";
import { advertiseRefs, basicCredentials, challenge, runService, type Service } from "../smart-http";

const SERVICES = new Set<Service>(["git-upload-pack", "git-receive-pack"]);

type Target = RepoAccess & { viewer: Viewer; dir: string; isWiki: boolean };

// Git authenticates with username + personal access token over HTTP Basic. Every request is
// challenged until it carries valid credentials, except reads of public repositories when an
// admin lets visitors without an account read them.
async function authorize(req: Request, owner: string, repoParam: string, service: Service): Promise<Target | Response> {
  const parsed = repoParam.endsWith(".git") ? parseRepoName(owner, repoParam.slice(0, -4)) : null;
  if (!parsed) return new Response("Not found\n", { status: 404 });

  const creds = basicCredentials(req);
  // A CI job on an external runner checks out its own repository with the token it got for that job.
  if (creds?.username === JOB_GIT_USER && service === "git-upload-pack" && !parsed.isWiki) {
    const found = findRepo(owner, parsed.name);
    if (found && repoExists(found.path) && jobMayRead(creds.secret, found.repo.id)) return { ...found, role: "read", viewer: VISITOR, dir: found.path, isWiki: false };
  }
  // Without credentials, reads of public repositories may proceed as the visitor when the
  // admin allows it; anything else is challenged so git asks for a token.
  const viewer = creds ? tokenUser(creds.username, creds.secret) : service === "git-upload-pack" && anonymousRead() ? VISITOR : null;
  if (!viewer) return challenge();

  const repo = repoAccess(viewer, owner, parsed.name);
  if (!repo && viewer === VISITOR) return challenge();
  if (!repo || !repoExists(repo.path)) return new Response("Repository not found\n", { status: 404 });
  const need = service === "git-receive-pack" ? "write" : "read";
  if (!allows(repo.role, need)) return new Response(`You need ${need} access to this repository\n`, { status: 403 });
  return { ...repo, viewer, dir: await gitDir(repo.path, parsed.isWiki), isWiki: parsed.isWiki };
}

// What receive-pack needs, or a plain-text refusal git shows as "remote: …".
async function receiveOrRefusal(t: Target) {
  try {
    return await prepareReceive(t.repo.id, t.dir, t.isWiki);
  } catch (e) {
    if (e instanceof ProtectionUnavailable) return new Response(`${e.message}\n`, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    throw e;
  }
}

export const gitRoutes = new Elysia()
  .get("/:owner/:repo/info/refs", async ({ request, params, query }) => {
    const service = query.service as Service;
    if (!SERVICES.has(service)) return new Response("Dumb HTTP is not supported\n", { status: 400 });
    const t = await authorize(request, params.owner, params.repo, service);
    if (t instanceof Response) return t;
    // git only shows the reason for a refusal at this first step, so an unusable hook is reported here too.
    if (service === "git-receive-pack") {
      const refused = await receiveOrRefusal(t);
      if (refused instanceof Response) return refused;
    }
    return advertiseRefs(service, t.dir);
  })
  .post("/:owner/:repo/git-upload-pack", { parse: "none" }, async ({ request, params }) => {
    const t = await authorize(request, params.owner, params.repo, "git-upload-pack");
    return t instanceof Response ? t : runService("git-upload-pack", t.dir, request);
  })
  .post("/:owner/:repo/git-receive-pack", { parse: "none" }, async ({ request, params }) => {
    const t = await authorize(request, params.owner, params.repo, "git-receive-pack");
    if (t instanceof Response) return t;
    const ready = await receiveOrRefusal(t);
    if (ready instanceof Response) return ready;
    return runService("git-receive-pack", t.dir, request, ready.guard, async (code) => {
      if (code === 0) await received({ id: t.repo.id, path: t.path }, t.dir, t.isWiki, ready.before, t.viewer.id, t.viewer.id);
    });
  });
