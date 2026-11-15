import { eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./access";
import { config } from "./config";
import { db } from "./db/client";
import { profile } from "./db/schema";

const MAX_AVATAR = 1024 * 1024;
const MAX_GIF_AVATAR = 2 * 1024 * 1024;
export const avatarDir = () => join(config.dataDir, "avatars");

const FIELDS = { displayName: 64, bio: 200, pronouns: 32, company: 64, location: 64, status: 80 } as const;

// Links are rendered as anchors, so only absolute http(s) URLs are stored.
function safeUrl(value: string): string {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `Not a valid link: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "Links must start with http:// or https://");
  if (value.length > 300) throw new HttpError(400, "Links can be at most 300 characters");
  return value;
}

// Raster formats only, recognised by their bytes; SVG could carry script.
function sniffImage(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && String.fromCharCode(...b.subarray(0, 4)) === "GIF8") return "image/gif";
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export const profileRow = (userId: string) => db.select().from(profile).where(eq(profile.userId, userId)).get();

export function upsertProfile(userId: string, set: Partial<typeof profile.$inferInsert>) {
  db.insert(profile).values({ userId, ...set }).onConflictDoUpdate({ target: profile.userId, set }).run();
}

// Shared by people and organizations: validated partial update of profile fields.
export function applyProfilePatch(userId: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const set: Partial<typeof profile.$inferInsert> = {};
  for (const [key, max] of Object.entries(FIELDS) as [keyof typeof FIELDS, number][]) {
    if (key in b) {
      if (typeof b[key] !== "string") throw new HttpError(400, `${key} must be text`);
      set[key] = (b[key] as string).trim().slice(0, max);
    }
  }
  if ("website" in b) {
    if (typeof b.website !== "string") throw new HttpError(400, "website must be text");
    set.website = safeUrl(b.website.trim());
  }
  if ("socials" in b) {
    if (!Array.isArray(b.socials) || b.socials.some((s) => typeof s !== "string")) throw new HttpError(400, "socials must be a list of links");
    const links = (b.socials as string[]).map((s) => s.trim()).filter(Boolean);
    if (links.length > 4) throw new HttpError(400, "Up to four social links");
    set.socials = JSON.stringify(links.map(safeUrl));
  }
  if (Object.keys(set).length === 0) throw new HttpError(400, "Nothing to change");
  upsertProfile(userId, set);
}

export async function saveAvatar(userId: string, request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_GIF_AVATAR) throw new HttpError(413, "Avatars can be at most 2 MB");
  const bytes = new Uint8Array(await request.arrayBuffer());
  const type = sniffImage(bytes);
  // Animated GIFs are uploaded untouched, so they get more room than re-encoded stills.
  const limit = type === "image/gif" ? MAX_GIF_AVATAR : MAX_AVATAR;
  if (bytes.length > limit) throw new HttpError(413, type === "image/gif" ? "GIF avatars can be at most 2 MB" : "Avatars can be at most 1 MB");
  if (!type) throw new HttpError(400, "Upload a PNG, JPEG, GIF or WebP image");
  mkdirSync(avatarDir(), { recursive: true });
  writeFileSync(join(avatarDir(), userId), bytes);
  const version = Date.now();
  upsertProfile(userId, { avatarVersion: version, avatarType: type });
  return { avatarVersion: version };
}
