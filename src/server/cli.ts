import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "./config";

const usage = `Usage:
  bun src/server/cli.ts create-admin <username> --password <password>
  bun src/server/cli.ts reset-password <username> --password <new-password>
  bun src/server/cli.ts invite --by <admin-username>
  bun src/server/cli.ts backup <dest-dir>
  bun src/server/cli.ts restore <backup-dir>     (server stopped, into an empty ETHER_DATA)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { password: { type: "string" }, by: { type: "string" } },
});

const [command, arg] = positionals;
const MIN_PASSWORD = 10;

// Copies a bare repository refs-first. Objects are only ever added, so every ref in the copy
// points at objects that are copied after it, even if a push lands mid-copy.
function copyRepoConsistently(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) if (entry !== "objects") cpSync(join(from, entry), join(to, entry), { recursive: true });
  if (existsSync(join(from, "objects"))) cpSync(join(from, "objects"), join(to, "objects"), { recursive: true });
}

const DATA_FILES = ["ether.db", "repos", "avatars", "releases", "auth-secret", "ssh_host_ed25519_key"];

// Restore never imports the database layer: that would create a fresh ether.db first.
if (command === "restore") {
  if (!arg || !existsSync(join(arg, "ether.db"))) throw new Error(`${usage}

That folder has no ether.db; point at one snapshot folder made by backup.`);
  if (DATA_FILES.some((f) => existsSync(join(config.dataDir, f))))
    throw new Error(`${config.dataDir} already has Ether data. Stop the server and point ETHER_DATA at an empty folder (or move the old data aside) first.`);
  mkdirSync(config.dataDir, { recursive: true });
  for (const f of DATA_FILES) if (existsSync(join(arg, f))) cpSync(join(arg, f), join(config.dataDir, f), { recursive: true });
  console.log(`Restored ${arg} into ${config.dataDir}. Start Ether with ETHER_DATA=${config.dataDir}.`);
  process.exit(0);
}

const { eq } = await import("drizzle-orm");
const { createInvite, findUser, isOrg } = await import("./access");
const { auth, placeholderEmail } = await import("./auth");
const { db } = await import("./db/client");
const { user } = await import("./db/schema");

switch (command) {
  case "create-admin": {
    const password = values.password ?? process.env.ETHER_ADMIN_PASSWORD;
    if (!arg || !password) throw new Error(usage);
    if (findUser(arg)) throw new Error(`User ${arg} already exists`);
    const { user: created } = await auth.api.signUpEmail({ body: { email: placeholderEmail(arg), name: arg, username: arg, password } });
    db.update(user).set({ role: "admin" }).where(eq(user.id, created.id)).run();
    console.log(`Created admin ${created.username}`);
    break;
  }
  // Recovery when someone (including the only admin) forgets their password. Existing
  // sessions are revoked; personal access tokens keep working.
  case "reset-password": {
    const password = values.password;
    const target = arg && findUser(arg);
    if (!target || !password) throw new Error(arg && !target ? `No user named ${arg}` : usage);
    if (password.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters`);
    if (isOrg(target.id)) throw new Error(`${target.username} is an organization; organizations can't sign in`);
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(password);
    if (await ctx.internalAdapter.findCredentialAccount(target.id)) await ctx.internalAdapter.updatePassword(target.id, hash);
    else await ctx.internalAdapter.createAccount({ userId: target.id, providerId: "credential", accountId: target.id, password: hash });
    await ctx.internalAdapter.deleteUserSessions(target.id);
    console.log(`Reset the password for ${target.username} and signed them out everywhere`);
    break;
  }
  case "invite": {
    const by = values.by && findUser(values.by);
    if (!by) throw new Error(usage);
    const { code, expiresAt } = createInvite(by.id);
    console.log(`${config.publicUrl}/register?code=${encodeURIComponent(code)}\n(expires ${expiresAt.toISOString()})`);
    break;
  }
  case "backup": {
    if (!arg) throw new Error(usage);
    const dest = join(arg, new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(dest, { recursive: true });
    // VACUUM INTO gives a consistent snapshot while the server keeps running.
    const { Database } = await import("bun:sqlite");
    new Database(join(config.dataDir, "ether.db")).exec(`VACUUM INTO '${join(dest, "ether.db").replaceAll("'", "''")}'`);
    const repos = join(config.dataDir, "repos");
    if (existsSync(repos))
      for (const owner of readdirSync(repos))
        for (const repo of readdirSync(join(repos, owner))) copyRepoConsistently(join(repos, owner, repo), join(dest, "repos", owner, repo));
    for (const extra of ["avatars", "releases", "ssh_host_ed25519_key"])
      if (existsSync(join(config.dataDir, extra))) cpSync(join(config.dataDir, extra), join(dest, extra), { recursive: true });
    if (existsSync(join(config.dataDir, "auth-secret"))) cpSync(join(config.dataDir, "auth-secret"), join(dest, "auth-secret"));
    else console.warn("No auth-secret file (BETTER_AUTH_SECRET is set in the environment); keep that value with this backup.");
    console.log(`Backed up to ${dest}`);
    break;
  }
  default:
    console.log(usage);
    process.exit(command ? 1 : 0);
}
