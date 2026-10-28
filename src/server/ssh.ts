import { eq } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server, utils, type Connection } from "ssh2";
import { allows, findRepo, repoAccess, type Role, type Viewer } from "./access";
import { config } from "./config";
import { onPush } from "./ci";
import { recordPush } from "./contrib";
import { recordPushEvents } from "./events";
import { db } from "./db/client";
import { deployKey, sshKey, user } from "./db/schema";
import { NAME_RE, ensureWiki, fixHead, listRefs, newAuthorEmails, repoExists, wikiPath } from "./git";
import { channelPump } from "./ssh-relay";

// One persistent host key per data directory, so clients see a stable identity.
function hostKey(): Buffer {
  const file = join(config.dataDir, "ssh_host_ed25519_key");
  if (!existsSync(file)) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file, utils.generateKeyPairSync("ed25519").private, { mode: 0o600 });
  }
  return readFileSync(file);
}

const fingerprintOf = (blob: Uint8Array) => `SHA256:${new Bun.CryptoHasher("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

// What people compare against on their first connection (ssh-keygen -lf, known_hosts), or null when SSH is off.
let hostKeyCache: { fingerprint: string; publicKey: string } | null = null;
export function hostKeyInfo(): { fingerprint: string; publicKey: string } | null {
  if (!config.sshPort) return null;
  if (!hostKeyCache) {
    const parsed = utils.parseKey(hostKey());
    if (parsed instanceof Error || Array.isArray(parsed)) return null;
    const blob = parsed.getPublicSSH();
    hostKeyCache = { fingerprint: fingerprintOf(blob), publicKey: `${parsed.type} ${Buffer.from(blob).toString("base64")}` };
  }
  return hostKeyCache;
}

// Who a key speaks for: an account with all its repositories, or a deploy key with one repository.
type Principal =
  | { kind: "user"; viewer: Viewer; keyId: number; keyText: string }
  | { kind: "deploy"; repoId: number; role: Role; addedBy: string | null; title: string; keyId: number; keyText: string };

// A key belongs to one account or one repository, never both.
export const keyInUse = (blob: string) =>
  !!db.select({ id: sshKey.id }).from(sshKey).where(eq(sshKey.blob, blob)).get() ||
  !!db.select({ id: deployKey.id }).from(deployKey).where(eq(deployKey.blob, blob)).get();

// Matched on the key data alone: RSA clients name the signature algorithm (rsa-sha2-256), not the key type.
function keyPrincipal(data: Buffer): Principal | null {
  const blob = data.toString("base64");
  const row = db
    .select({ id: sshKey.id, keyType: sshKey.keyType, userId: user.id, username: user.username, role: user.role })
    .from(sshKey)
    .innerJoin(user, eq(user.id, sshKey.userId))
    .where(eq(sshKey.blob, blob))
    .get();
  if (row?.username)
    return { kind: "user", viewer: { id: row.userId, username: row.username, isAdmin: row.role === "admin" }, keyId: row.id, keyText: `${row.keyType} ${blob}` };
  const dk = db.select().from(deployKey).where(eq(deployKey.blob, blob)).get();
  if (dk) return { kind: "deploy", repoId: dk.repoId, role: dk.readOnly ? "read" : "write", addedBy: dk.createdBy, title: dk.title, keyId: dk.id, keyText: `${dk.keyType} ${blob}` };
  return null;
}

// The repository a principal reaches by name, with its role there, or null when it can't see it.
function reach(principal: Principal, owner: string, name: string) {
  if (principal.kind === "user") return repoAccess(principal.viewer, owner, name);
  const found = findRepo(owner, name);
  if (!found || found.repo.id !== principal.repoId) return null;
  return { ...found, role: principal.role };
}

// git-upload-pack '/owner/repo.git' (quotes and leading slash optional), as git sends it.
const COMMAND_RE = /^(git-upload-pack|git-receive-pack) +'?\/?([^'/\s]+)\/([^'/\s]+?)'?$/;

// git asks for protocol v2 by sending GIT_PROTOCOL (e.g. "version=2"); anything odd is dropped.
const GIT_PROTOCOL_RE = /^[\w.=:-]{1,64}$/;

function deny(stream: { stderr: { write: (s: string) => void }; exit: (c: number) => void; end: () => void }, message: string) {
  stream.stderr.write(`ether: ${message}\n`);
  stream.exit(1);
  stream.end();
}

function onClient(client: Connection) {
  let principal: Principal | null = null;
  client.on("authentication", (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
    const owner = keyPrincipal(ctx.key.data);
    if (!owner) return ctx.reject(["publickey"]);
    // First the client asks whether the key would be accepted, then proves it holds it.
    if (!ctx.signature) return ctx.accept();
    const parsed = utils.parseKey(owner.keyText);
    if (parsed instanceof Error || !ctx.blob || !parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
    principal = owner;
    const table = owner.kind === "user" ? sshKey : deployKey;
    db.update(table).set({ lastUsedAt: new Date() }).where(eq(table.id, owner.keyId)).run();
    ctx.accept();
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      let gitProtocol = "";
      session.on("env", (ok, reject, info) => {
        if (info.key !== "GIT_PROTOCOL" || !GIT_PROTOCOL_RE.test(info.val)) return reject?.();
        gitProtocol = info.val;
        ok?.();
      });
      // Like GitHub: no shell, just a friendly hello.
      session.on("pty", (ok) => ok?.());
      session.on("shell", (ok) => {
        const stream = ok();
        const who = principal?.kind === "user" ? principal.viewer.username : `deploy key "${keyTitle(principal?.title, "untitled")}"`;
        stream.write(`Hi ${who}! You've authenticated, but Ether does not provide shell access.\r\n`);
        stream.exit(1);
        stream.end();
      });
      session.on("exec", async (ok, _reject, info) => {
        const stream = ok();
        const m = COMMAND_RE.exec(info.command.trim());
        if (!m || !principal) return deny(stream, "only git clone, fetch and push are supported");
        const [, service, owner, repoParam] = m;
        const name = repoParam.replace(/\.git$/, "");
        if (!NAME_RE.test(owner) || !NAME_RE.test(name) || name.startsWith(".")) return deny(stream, "repository not found");
        const isWiki = name.endsWith(".wiki");
        const access = reach(principal, owner, isWiki ? name.slice(0, -5) : name);
        if (!access || !repoExists(access.path)) return deny(stream, "repository not found");
        const need = service === "git-receive-pack" ? "write" : "read";
        if (!allows(access.role, need)) return deny(stream, `you need ${need} access to ${owner}/${name}`);
        const path = isWiki ? await ensureWiki(access.path) : access.path;

        const before = service === "git-receive-pack" ? await listRefs(path) : [];
        const proc = Bun.spawn(["git", service.slice(4), path], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, GIT_PROTOCOL: gitProtocol, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
        });
        const relay = channelPump([stream, client], () => proc.kill());
        // Both directions wait for the other side, so a slow peer can't make either end buffer a whole pack in memory.
        // Not an async iterator: finishing one destroys the channel, which the response still needs.
        stream.on("data", (chunk: Buffer) => {
          proc.stdin.write(chunk);
          const flushed = proc.stdin.flush();
          if (flushed instanceof Promise) {
            stream.pause();
            flushed.then(() => stream.resume(), () => proc.kill());
          }
        });
        stream.on("end", () => proc.stdin.end());
        await Promise.all([relay.pump(proc.stdout, stream), relay.pump(proc.stderr, stream.stderr)]);
        const code = await proc.exited;
        relay.release();
        if (service === "git-receive-pack" && code === 0) {
          await fixHead(path).catch(() => {});
          const after = await listRefs(path);
          // Author emails are only learned from a person's own pushes; a deploy key has no person behind it.
          if (principal.kind === "user") recordPush(principal.viewer.id, await newAuthorEmails(path, before.map((r) => r.sha), after.map((r) => r.sha)).catch(() => []));
          // A deploy key's pushes count as whoever added it. Once that account is deleted they fall back to the
          // repository's owner, which for an organization's repository is the organization itself.
          const actorId = principal.kind === "user" ? principal.viewer.id : (principal.addedBy ?? access.repo.ownerId);
          if (!isWiki) {
            await recordPushEvents(access.repo.id, actorId, path, before, after).catch(() => {});
            await onPush(access.repo.id, path, before, after, actorId).catch(() => {});
          }
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
  // A busy port shouldn't take the web app down with it.
  server.on("error", (e: Error) => console.error(`Git over SSH unavailable: ${e.message}`));
  server.listen(config.sshPort, config.host);
  return server;
}

// A key's title as stored and shown, also at the SSH prompt: without control or invisible formatting
// characters, so it can't carry terminal escape sequences to whoever uses the key.
export function keyTitle(title: unknown, fallback: string): string {
  const clean = typeof title === "string" ? title.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 100) : "";
  return clean || fallback;
}

// Parses an OpenSSH public key line for storage, or explains why it isn't one.
export function parsePublicKey(text: string): { keyType: string; blob: string; fingerprint: string } {
  const parsed = utils.parseKey(text.trim());
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.isPrivateKey()) throw new Error("That doesn't look like an SSH public key (it should start with ssh-ed25519, ssh-rsa or ecdsa-sha2-…)");
  const blob = parsed.getPublicSSH();
  return { keyType: parsed.type, blob: Buffer.from(blob).toString("base64"), fingerprint: fingerprintOf(blob) };
}
