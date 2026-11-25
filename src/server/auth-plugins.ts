import { admin, username } from "better-auth/plugins";
import { NAME_MAX } from "../shared/accounts";

// GitHub-style handles: letters, digits and single dashes, not starting with a dash.
export const USERNAME_RE = new RegExp(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,${NAME_MAX - 1}})$`);

// First path segments of the web app's own routes (src/web/routes); a name that matches one
// would shadow that page.
export const RESERVED = new Set(["api", "assets", "login", "register", "new", "settings", "site-admin", "organizations", "notifications", "cli", "_shell"]);

// Shared by the runtime auth instance and the schema generator so the tables always match.
// Kept as a tuple so Better Auth can infer the fields each plugin adds.
export const authPlugins: [ReturnType<typeof username>, ReturnType<typeof admin>] = [
  username({ minUsernameLength: 1, maxUsernameLength: NAME_MAX, usernameValidator: (name) => USERNAME_RE.test(name) }),
  admin(),
];
