import { Elysia } from "elysia";
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HttpError } from "./access";
import { auth } from "./auth";
import { config } from "./config";
import { accountRoutes } from "./routes/account";
import { gitRoutes } from "./routes/git";
import { issueRoutes } from "./routes/issues";
import { ciRoutes } from "./routes/ci";
import { dashboardRoutes } from "./routes/dashboard";
import { labelRoutes } from "./routes/labels";
import { orgRoutes } from "./routes/orgs";
import { profileRoutes } from "./routes/profiles";
import { releaseRoutes } from "./routes/releases";
import { repoRoutes } from "./routes/repos";
import { reviewRoutes } from "./routes/reviews";
import { sshKeyRoutes } from "./routes/ssh-keys";
import { deployKeyRoutes } from "./routes/deploy-keys";
import { branchProtectionRoutes } from "./routes/branch-protection";
import { wikiRoutes } from "./routes/wiki";

const api = new Elysia({ prefix: "/api" })
  .onError(({ error, request }) => {
    if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
    // Better Auth's APIError carries a numeric statusCode and a user-facing message.
    const { statusCode, status, body } = error as { statusCode?: number; status?: unknown; body?: { message?: string } };
    const code = typeof statusCode === "number" ? statusCode : typeof status === "number" ? status : 500;
    if (code < 500) return Response.json({ error: body?.message ?? "Bad request" }, { status: code });
    console.error(`${request.method} ${new URL(request.url).pathname}`, error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  })
  // Session cookies are SameSite=Lax; also refuse state-changing requests from foreign origins.
  .onBeforeHandle(({ request }) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const origin = request.headers.get("origin");
    if (origin && !config.trustedOrigins.includes(origin) && origin !== new URL(request.url).origin)
      return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
  })
  .get("/health", () => ({ ok: true }))
  .use(accountRoutes)
  .use(repoRoutes)
  .use(issueRoutes)
  .use(profileRoutes)
  .use(orgRoutes)
  .use(labelRoutes)
  .use(releaseRoutes)
  .use(reviewRoutes)
  .use(wikiRoutes)
  .use(sshKeyRoutes)
  .use(deployKeyRoutes)
  .use(branchProtectionRoutes)
  .use(ciRoutes)
  .use(dashboardRoutes)
  .all("/*", () => Response.json({ error: "Not found" }, { status: 404 }));

// The web app is a TanStack Start SPA build: static assets plus a shell for every app route.
function serveWeb(request: Request): Response {
  const root = config.webDist;
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const file = resolve(root, `.${pathname}`);
  const inside = !relative(root, file).startsWith("..");
  if (inside && pathname !== "/" && existsSync(file) && statSync(file).isFile()) {
    const immutable = pathname.startsWith("/assets/");
    return new Response(Bun.file(file), { headers: immutable ? { "Cache-Control": "public, max-age=31536000, immutable" } : {} });
  }
  const shell = join(root, "_shell.html");
  if (!existsSync(shell))
    return new Response("Web app not built. Run `bun run build`.\n", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(Bun.file(shell), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

export const app = new Elysia({
  serve: {
    hostname: config.host,
    port: config.port,
    // Pushes stream arbitrarily large packs, and pack generation can be silent for a while.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    idleTimeout: 0,
  },
})
  .onAfterHandle(({ set }) => {
    Object.assign(set.headers, securityHeaders);
  })
  // Forward unmodified: Better Auth routes on its full basePath, which mount() would strip.
  .all("/api/auth/*", { parse: "none" }, ({ request }) => auth.handler(request))
  .use(api)
  .use(gitRoutes)
  .get("/*", ({ request }) => serveWeb(request));
