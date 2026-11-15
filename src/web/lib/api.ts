import type { Isolation } from "../../runner/protocol";
import type { Role } from "../../server/access";

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
  return readBody<T>(res);
}

export async function upload<T = unknown>(path: string, body: Blob, method = "PUT"): Promise<T> {
  return readBody<T>(await fetch(path, { method, body, credentials: "same-origin" }));
}

async function readBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let parsed: { error?: string; message?: string } | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {}
    throw new ApiError(res.status, parsed?.error ?? parsed?.message ?? (res.statusText || `Request failed (${res.status})`));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const post = <T = unknown>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });
export const patch = <T = unknown>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const put = <T = unknown>(path: string, json: unknown) => api<T>(path, { method: "PUT", json });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });

export const repoApi = (owner: string, repo: string) => `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export type Me = { username: string; isAdmin: boolean; accent: string | null; theme: "light" | "dark" | null };

export type Instance = { anonymousRead: boolean; ciEnabled: boolean; ciIsolation: Isolation; sshBase: string | null; sshHostKey: { fingerprint: string; publicKey: string } | null };

export type Person = { username: string; isAdmin: boolean; isOrg: boolean; displayName: string; avatarVersion: number | null };

// One row of GET /api/repos.
export type RepoRow = {
  owner: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  relation: "owner" | "org" | "collaborator" | "public";
  ownerIsOrg: boolean;
  mine: boolean;
  stars: number;
  updatedAt: string;
};

export type Release = {
  tag: string;
  title: string;
  notes: string;
  prerelease: boolean;
  author: string | null;
  createdAt: string;
  assets: { name: string; size: number }[];
};

export type { Role };
export const canWrite = (role: Role) => role !== "read";
export const isOwner = (role: Role) => role === "owner";

export type RepoInfo = {
  repo: { owner: string; name: string; description: string; visibility: "private" | "public"; requireApproval: boolean; ciEnabled: boolean; requireChecks: boolean; requireCodeOwnerReview: boolean; allowMergeCommit: boolean; allowSquashMerge: boolean; allowRebaseMerge: boolean; defaultBranch: string; empty: boolean };
  role: Role;
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
  draft: boolean;
  base: string | null;
  head: string | null;
  mergeCommit: string | null;
  mergeMethod: "merge" | "squash" | "rebase" | null;
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
