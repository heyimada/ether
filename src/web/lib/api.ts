import { formatDistanceToNowStrict } from "date-fns";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? data.message ?? res.statusText);
  return data as T;
}

export const post = <T = unknown>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });
export const patch = <T = unknown>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const put = <T = unknown>(path: string, json: unknown) => api<T>(path, { method: "PUT", json });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });

export const repoApi = (owner: string, repo: string) => `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export type Me = { username: string; isAdmin: boolean; accent: string | null; theme: "light" | "dark" | null };

export type RepoInfo = {
  repo: { owner: string; name: string; description: string; visibility: "private" | "public"; requireApproval: boolean; ciEnabled: boolean; requireChecks: boolean; defaultBranch: string; empty: boolean };
  role: "owner" | "write" | "read";
  stars: number;
  starred: boolean;
  branches: string[];
  tags: string[];
};

export type Commit = { sha: string; parents: string[]; author: string; email: string; date: number; subject: string; body: string };
export type TreeEntry = {
  name: string;
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  size: number | null;
  lastCommit?: { sha: string; subject: string; date: number } | null;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  isPull: boolean;
  base: string | null;
  head: string | null;
  mergeCommit: string | null;
  mergedBy: string | null;
  author: string;
  comments: number;
  createdAt: string;
  updatedAt: string;
  labels: Label[];
  assignees: string[];
};

export type Label = { name: string; color: string; description: string };

export type Comment = { id: number; body: string; author: string; createdAt: string };

// Splits "<ref>/<path>" where the ref itself may contain slashes, by longest known ref.
export function splitRefPath(splat: string, info: RepoInfo): { ref: string; path: string } {
  const refs = [...info.branches, ...info.tags].sort((a, b) => b.length - a.length);
  for (const ref of refs) if (splat === ref || splat.startsWith(`${ref}/`)) return { ref, path: splat.slice(ref.length + 1) };
  const [first, ...rest] = splat.split("/");
  return { ref: first, path: rest.join("/") };
}

// Compact relative times ("3 minutes ago", "8 months ago") that fit table columns.
export const timeAgo = (value: number | string | Date) => {
  const date = new Date(value);
  return Date.now() - date.getTime() < 60_000 ? "just now" : formatDistanceToNowStrict(date, { addSuffix: true });
};

export const shortSha = (sha: string) => sha.slice(0, 7);
