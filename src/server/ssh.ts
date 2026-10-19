import { eq } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server, utils, type Connection } from "ssh2";
import { allows, repoAccess, type Viewer } from "./access";
import { config } from "./config";
import { recordPush } from "./contrib";
import { db } from "./db/client";
import { sshKey, user } from "./db/schema";
import { NAME_RE, ensureWiki, fixHead, listRefs, newAuthorEmails, repoExists, wikiPath } from "./git";

// One persistent host key per data directory, so clients see a stable identity.
function hostKey(): Buffer {
  const file = join(config.dataDir, "ssh_host_ed25519_key");
  if (!existsSync(file)) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file, utils.generateKeyPairSync("ed25519").private, { mode: 0o600 });
  }
  return readFileSync(file);
}

// Matched on the key data alone: RSA clients name the signature algorithm (rsa-sha2-256), not the key type.
function keyOwner(data: Buffer): (Viewer & { keyId: number; keyText: string }) | null {
  const row = db
    .select({ id: sshKey.id, keyType: sshKey.keyType, blob: sshKey.blob, userId: user.id, username: user.username, role: user.role })
    .from(sshKey)
    .innerJoin(user, eq(user.id, sshKey.userId))
    .where(eq(sshKey.blob, data.toString("base64")))
    .get();
  if (!row?.username) return null;
  return { id: row.userId, username: row.username, isAdmin: row.role === "admin", keyId: row.id, keyText: `${row.keyType} ${row.blob}` };
}

// git-upload-pack '/owner/repo.git' (quotes and leading slash optional), as git sends it.
const COMMAND_RE = /^(git-upload-pack|git-receive-pack) +'?\/?([^'/\s]+)\/([^'/\s]+?)'?$/;

function deny(stream: { stderr: { write: (s: string) => void }; exit: (c: number) => void; end: () => void }, message: string) {
  stream.stderr.write(`ether: ${message}\n`);
  stream.exit(1);
  stream.end();
}

function onClient(client: Connection) {
  let viewer: (Viewer & { keyId: number }) | null = null;
  client.on("authentication", (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
    const owner = keyOwner(ctx.key.data);
    if (!owner) return ctx.reject(["publickey"]);
    // First the client asks whether the key would be accepted, then proves it holds it.
    if (!ctx.signature) return ctx.accept();
    const parsed = utils.parseKey(owner.keyText);
    if (parsed instanceof Error || !ctx.blob || !parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
    viewer = owner;
    db.update(sshKey).set({ lastUsedAt: new Date() }).where(eq(sshKey.id, owner.keyId)).run();
    ctx.accept();
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      // Like GitHub: no shell, just a friendly hello.
      session.on("pty", (ok) => ok?.());
      session.on("shell", (ok) => {
        const stream = ok();
        stream.write(`Hi ${viewer?.username}! You've authenticated, but Ether does not provide shell access.\r\n`);
        stream.exit(1);
        stream.end();
      });
      session.on("exec", async (ok, _reject, info) => {
        const stream = ok();
        const m = COMMAND_RE.exec(info.command.trim());
        if (!m || !viewer) return deny(stream, "only git clone, fetch and push are supported");
        const [, service, owner, repoParam] = m;
        const name = repoParam.replace(/\.git$/, "");
        if (!NAME_RE.test(owner) || !NAME_RE.test(name) || name.startsWith(".")) return deny(stream, "repository not found");
        const isWiki = name.endsWith(".wiki");
        const access = repoAccess(viewer, owner, isWiki ? name.slice(0, -5) : name);
        if (!access || !repoExists(access.path)) return deny(stream, "repository not found");
        const need = service === "git-receive-pack" ? "write" : "read";
        if (!allows(access.role, need)) return deny(stream, `you need ${need} access to ${owner}/${name}`);
        const path = isWiki ? await ensureWiki(access.path) : access.path;

        const before = service === "git-receive-pack" ? (await listRefs(path)).map((r) => r.sha) : [];
        const proc = Bun.spawn(["git", service.slice(4), path], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
        });
        stream.on("data", (chunk: Buffer) => {
          proc.stdin.write(chunk);
          proc.stdin.flush();
        });
        stream.on("end", () => proc.stdin.end());
        stream.on("close", () => proc.kill());
        const pump = async (from: ReadableStream<Uint8Array>, to: { write: (b: Uint8Array) => unknown }) => {
          for await (const chunk of from) to.write(chunk);
        };
        await Promise.all([pump(proc.stdout, stream), pump(proc.stderr, stream.stderr)]);
        const code = await proc.exited;
        if (service === "git-receive-pack" && code === 0) {
          await fixHead(path).catch(() => {});
          const after = (await listRefs(path)).map((r) => r.sha);
          recordPush(viewer.id, await newAuthorEmails(path, before, after).catch(() => []));
        }
        stream.exit(code);
        stream.end();
      });
    });
  });
  client.on("error", () => {});
}

export function startSsh(): Server | null {
  if (!config.sshPort) return null;
  const server = new Server({ hostKeys: [hostKey()], ident: "Ether" }, onClient);
  server.listen(config.sshPort, config.host);
  return server;
}

// Parses an OpenSSH public key line for storage, or explains why it isn't one.
export function parsePublicKey(text: string): { keyType: string; blob: string; fingerprint: string } {
  const parsed = utils.parseKey(text.trim());
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.isPrivateKey()) throw new Error("That doesn't look like an SSH public key (it should start with ssh-ed25519, ssh-rsa or ecdsa-sha2-…)");
  const blob = parsed.getPublicSSH();
  const digest = new Bun.CryptoHasher("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { keyType: parsed.type, blob: Buffer.from(blob).toString("base64"), fingerprint: `SHA256:${digest}` };
}
