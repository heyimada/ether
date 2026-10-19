import { fixHead } from "./git";

export type Service = "git-upload-pack" | "git-receive-pack";

const pktLine = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;

const noCache = {
  "Cache-Control": "no-cache, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "Fri, 01 Jan 1980 00:00:00 GMT",
};

function spawnService(service: Service, repo: string, advertise: boolean) {
  const args = [service.slice(4), "--stateless-rpc"];
  if (advertise) args.push("--advertise-refs");
  args.push(repo);
  return Bun.spawn(["git", ...args], {
    stdin: advertise ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Protocol v0/v1 only: the advertisement framing below is the v0 form.
    env: { ...process.env, GIT_PROTOCOL: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

// GET /info/refs?service=...
export function advertiseRefs(service: Service, repo: string): Response {
  const proc = spawnService(service, repo, true);
  const header = new TextEncoder().encode(pktLine(`# service=${service}\n`) + "0000");
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(header);
      for await (const chunk of proc.stdout) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      proc.kill();
    },
  });
  return new Response(body, { headers: { "Content-Type": `application/x-${service}-advertisement`, ...noCache } });
}

// POST /git-upload-pack and /git-receive-pack. Both directions are streamed: pushes arrive
// chunked with no Content-Length and can be far larger than memory should hold.
export function runService(service: Service, repo: string, req: Request, afterPush?: () => Promise<void>): Response {
  const proc = spawnService(service, repo, false);
  let input = req.body;
  const encoding = req.headers.get("content-encoding")?.toLowerCase();
  if (input && (encoding === "gzip" || encoding === "x-gzip")) input = input.pipeThrough(new DecompressionStream("gzip"));

  const pump = (async () => {
    try {
      if (input) for await (const chunk of input) await proc.stdin!.write(chunk);
    } catch {
      proc.kill();
    } finally {
      await proc.stdin!.end();
    }
  })();

  const stderr = new Response(proc.stderr).text();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of proc.stdout) controller.enqueue(chunk);
      await pump;
      const code = await proc.exited;
      if (code !== 0) console.error(`${service} exited ${code}: ${(await stderr).trim()}`);
      if (service === "git-receive-pack") {
        await fixHead(repo).catch((e) => console.error("fixHead", e));
        if (code === 0 && afterPush) await afterPush().catch((e) => console.error("afterPush", e));
      }
      controller.close();
    },
    cancel() {
      proc.kill();
    },
  });
  return new Response(body, { headers: { "Content-Type": `application/x-${service}-result`, ...noCache } });
}

export const challenge = () =>
  new Response("Authentication required\n", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Ether", charset="UTF-8"' } });

export function basicCredentials(req: Request): { username: string; secret: string } | null {
  const header = req.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { username: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}
