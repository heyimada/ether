import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authPlugins } from "../src/server/auth-plugins";

// Only used by `auth generate` to emit the Drizzle schema for Better Auth's tables.
export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  plugins: authPlugins,
});
