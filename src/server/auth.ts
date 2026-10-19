import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authPlugins } from "./auth-plugins";
import { config } from "./config";
import { db, schema } from "./db/client";

// Generated once per data directory unless provided by the environment.
function authSecret(): string {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  const file = join(config.dataDir, "auth-secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

// Accounts are username-based; Better Auth still wants an email, so we derive an
// unroutable one from the username.
export const placeholderEmail = (name: string) => `${name.toLowerCase()}@users.ether.invalid`;

export const auth = betterAuth({
  appName: "Ether",
  baseURL: config.publicUrl,
  basePath: "/api/auth",
  secret: authSecret(),
  trustedOrigins: config.trustedOrigins,
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  plugins: authPlugins,
  session: { expiresIn: 60 * 60 * 24 * 30 },
  // `tailscale serve` on loopback forwards the caller's tailnet address in X-Forwarded-For.
  // Trusting only that hop means a client-supplied header can't pick its own rate-limit bucket.
  advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["127.0.0.1", "::1"] } },
  hooks: {
    // Public sign-up is closed: accounts are only created server-side by redeeming an invite.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path.startsWith("/sign-up") && ctx.request) throw new APIError("FORBIDDEN", { message: "Registration requires an invite" });
      // Organizations are user rows without credentials; refuse them outright regardless.
      if (ctx.path.startsWith("/sign-in")) {
        const name = (ctx.body as { username?: unknown } | undefined)?.username;
        if (typeof name === "string" && db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.username, name.toLowerCase())).get()?.role === "org")
          throw new APIError("UNAUTHORIZED", { message: "Invalid username or password" });
      }
    }),
  },
  telemetry: { enabled: false },
});

export type Session = typeof auth.$Infer.Session;
