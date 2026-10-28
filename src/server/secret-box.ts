// Sealing small values at rest: AES-256-GCM with a random IV, under a key derived from a server secret.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// One key per purpose, so the same server secret never encrypts two kinds of data under one key.
export const deriveKey = (serverSecret: string, purpose: string) => Buffer.from(hkdfSync("sha256", serverSecret, "", `ether ${purpose}`, 32));

// base64 of IV (12) + tag (16) + ciphertext. `aad` binds the value to where it's stored.
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

// Throws if the value was changed, moved to another `aad`, or sealed under another key.
export function open(key: Buffer, sealed: string, aad: string): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 28) throw new Error("sealed value is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)).setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
