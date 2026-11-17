import { formatDistanceToNowStrict } from "date-fns";

export const noun = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
export const plural = (n: number, one: string, many?: string) => `${n} ${noun(n, one, many)}`;

// Compact relative times ("3 minutes ago", "8 months ago") that fit table columns.
export const timeAgo = (value: number | string | Date) => {
  const date = new Date(value);
  return Date.now() - date.getTime() < 60_000 ? "just now" : formatDistanceToNowStrict(date, { addSuffix: true });
};

export const shortSha = (sha: string) => sha.slice(0, 7);
