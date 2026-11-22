import { Elysia } from "elysia";
import { HttpError, readerOrVisitor } from "../access";
import { cliFile, cliManifest, installPs1, installSh } from "../cli-dist";
import { config } from "../config";

// Which client binaries this server offers, with sizes and checksums. Like the rest of the API it needs an account,
// unless the admin lets visitors browse.
export const cliApiRoutes = new Elysia()
  .get("/cli", async ({ request }) => {
    await readerOrVisitor(request);
    return { ...cliManifest(), server: config.publicUrl };
  })
  // The binaries and installers themselves are public: they're the open-source client, with nothing about this
  // server in them but its URL, and the installer has to fetch them before anyone can log in.
  .get("/cli/download/:file", ({ params }) => {
    const path = cliFile(params.file);
    if (!path) throw new HttpError(404, "No such download");
    return new Response(Bun.file(path), {
      headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${params.file.replace(/-(darwin|linux|windows)-\w+/, "")}"`, "Cache-Control": "no-cache" },
    });
  });

export const cliInstallRoutes = new Elysia()
  .get("/install.sh", () => new Response(installSh(), { headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-cache" } }))
  .get("/install.ps1", () => new Response(installPs1(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } }));
