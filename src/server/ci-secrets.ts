import { and, asc, eq, inArray } from "drizzle-orm";
import { authSecret } from "./auth";
import { db } from "./db/client";
import { ciSecret, user } from "./db/schema";
import { deriveKey, open, seal } from "./secret-box";

export { SECRET_NAME_RE } from "./ci-workflow";
export const MAX_SECRET = 64 * 1024;

let key: Buffer | null = null;
const secretKey = () => (key ??= deriveKey(authSecret(), "ci secrets"));
const aad = (repoId: number, name: string) => `${repoId}\0${name}`;

// Names and when they changed; values never leave the server except into a job's environment.
export const listSecrets = (repoId: number) =>
  db
    .select({ name: ciSecret.name, updatedAt: ciSecret.updatedAt, updatedBy: user.username })
    .from(ciSecret)
    .leftJoin(user, eq(user.id, ciSecret.updatedBy))
    .where(eq(ciSecret.repoId, repoId))
    .orderBy(asc(ciSecret.name))
    .all();

export function setSecret(repoId: number, name: string, value: string, by: string) {
  const sealed = seal(secretKey(), value, aad(repoId, name));
  const now = new Date();
  db.insert(ciSecret)
    .values({ repoId, name, value: sealed, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({ target: [ciSecret.repoId, ciSecret.name], set: { value: sealed, updatedBy: by, updatedAt: now } })
    .run();
}

// False when there was no such secret.
export function deleteSecret(repoId: number, name: string): boolean {
  const where = and(eq(ciSecret.repoId, repoId), eq(ciSecret.name, name));
  if (!db.select({ id: ciSecret.id }).from(ciSecret).where(where).get()) return false;
  db.delete(ciSecret).where(where).run();
  return true;
}

// The values a job asks for, or a message saying which one can't be provided.
export function loadSecrets(repoId: number, names: string[]): Map<string, string> {
  const rows = names.length ? db.select().from(ciSecret).where(and(eq(ciSecret.repoId, repoId), inArray(ciSecret.name, names))).all() : [];
  const out = new Map<string, string>();
  for (const name of names) {
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`The secret ${name} isn't set in this repository's settings`);
    try {
      out.set(name, open(secretKey(), row.value, aad(repoId, name)));
    } catch {
      // The auth secret changed since it was saved (a restore onto another server, a new BETTER_AUTH_SECRET).
      throw new Error(`The secret ${name} can't be decrypted on this server; set it again in the repository's settings`);
    }
  }
  return out;
}
