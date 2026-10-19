import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";
import { createInvite, findUser, isOrg } from "./access";
import { auth, placeholderEmail } from "./auth";
import { config } from "./config";
import { db } from "./db/client";
import { user } from "./db/schema";

const usage = `Usage:
  bun src/server/cli.ts create-admin <username> --password <password>
  bun src/server/cli.ts reset-password <username> --password <new-password>
  bun src/server/cli.ts invite --by <admin-username>
  bun src/server/cli.ts backup <dest-dir>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { password: { type: "string" }, by: { type: "string" } },
});

const [command, arg] = positionals;
const MIN_PASSWORD = 10;

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
    const { mkdirSync, cpSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (!arg) throw new Error(usage);
    const dest = join(arg, new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(dest, { recursive: true });
    // VACUUM INTO gives a consistent snapshot while the server keeps running.
    const { Database } = await import("bun:sqlite");
    new Database(join(config.dataDir, "ether.db")).exec(`VACUUM INTO '${join(dest, "ether.db").replaceAll("'", "''")}'`);
    cpSync(join(config.dataDir, "repos"), join(dest, "repos"), { recursive: true });
    cpSync(join(config.dataDir, "auth-secret"), join(dest, "auth-secret"));
    console.log(`Backed up to ${dest}`);
    break;
  }
  default:
    console.log(usage);
    process.exit(command ? 1 : 0);
}
