export const PROFILE_FIELDS = { displayName: 64, bio: 200, pronouns: 32, company: 64, location: 64, status: 80 } as const;
export const MAX_SOCIALS = 4;
export const MAX_PINS = 6;
export const LINK_MAX = 300;
export const AVATAR_MAX_MB = 1;
export const GIF_AVATAR_MAX_MB = 2;
export const MAX_AVATAR = AVATAR_MAX_MB * 1024 * 1024;
export const MAX_GIF_AVATAR = GIF_AVATAR_MAX_MB * 1024 * 1024;
