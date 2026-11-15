export const REPO_NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;
export const ACTIVITY_WEEKS = 12;

export const TAG_MAX = 100;
export const RELEASE_TITLE_MAX = 200;
export const ASSET_MAX_MB = 500;
export const MAX_ASSET = ASSET_MAX_MB * 1024 * 1024;

export const WIKI_TITLE_MAX = 100;
export const WIKI_MESSAGE_MAX = 200;

export const titleToSlug = (title: string) =>
  title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, WIKI_TITLE_MAX);
