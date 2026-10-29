import { Link, useRouteContext } from "@tanstack/react-router";
import { BookOpen, FileText, Folder, FolderGit2, GitBranch, History, Star, Tag } from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import formatSize from "pretty-bytes";
import { api, repoApi, shortSha, timeAgo, type Commit, type RepoInfo, type TreeEntry } from "../lib/api";
import { rise, staggered } from "../lib/motion";
import { CodeView, Markdown } from "./content";
import { RefPicker, TAB_BUTTON } from "./ref-picker";
import type { Release } from "./releases";
import { Avatar, CopyButton, ROW } from "./ui";

const LAYOUT_2 = "grid grid-cols-[1fr_260px] gap-6 max-lg:grid-cols-[1fr]";
const MAIN_COL = "flex min-w-0 flex-col gap-4";
const SIDE_COL = "flex min-w-0 flex-col gap-6";
const CARD_HEADER = "flex flex-wrap items-center gap-3 rounded-t-md border-b border-border bg-surface-2 px-4 py-2.5";
const SETUP = "overflow-x-auto rounded-sm border border-border bg-surface-2 p-3";
const SIDE_HEADING = "mt-0 mb-2 text-base";
const SIDE_TEXT = "m-0 text-base wrap-anywhere";
const TD = "border-t border-border px-4 py-2 transition-colors duration-150";

export type TreeData = { sha: string; path: string; entries: TreeEntry[]; lastCommit: Commit | null; commitCount: number | null; readme: string | null };
export type BlobData = { sha: string; path: string; size: number; binary: boolean; tooLarge: boolean; content: string | null };

export async function loadTree(info: RepoInfo, ref: string, path: string): Promise<TreeData> {
  const base = repoApi(info.repo.owner, info.repo.name);
  const q = new URLSearchParams({ ref, path });
  const tree = await api<Omit<TreeData, "readme">>(`${base}/tree?${q}`);
  const readmeEntry = tree.entries.find((e) => e.type === "blob" && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
  let readme: string | null = null;
  if (readmeEntry) {
    const blob = await api<BlobData>(`${base}/blob?${new URLSearchParams({ ref: tree.sha, path: readmeEntry.path })}`);
    readme = blob.content;
  }
  return { ...tree, readme };
}

export const cloneUrl = (info: RepoInfo) => `${location.origin}/${info.repo.owner}/${info.repo.name}.git`;

export function CloneBox({ info }: { info: RepoInfo }) {
  const { instance } = useRouteContext({ from: "/_authed" });
  const [kind, setKind] = useState<"https" | "ssh">("https");
  const ssh = instance.sshBase ? `${instance.sshBase}/${info.repo.owner}/${info.repo.name}.git` : null;
  const url = kind === "ssh" && ssh ? ssh : cloneUrl(info);
  return (
    <div className="stack-sm gap-1.5">
      {ssh && (
        <div className="flex gap-1 border-b border-border p-0" role="tablist" aria-label="Clone over">
          {(["https", "ssh"] as const).map((k) => (
            <button key={k} type="button" role="tab" className={TAB_BUTTON} aria-selected={kind === k} onClick={() => setKind(k)}>
              {k === "https" ? "HTTPS" : "SSH"}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          className="min-w-0 flex-1 bg-surface-2 px-2 py-[5px] font-mono text-xs"
          readOnly
          value={url}
          aria-label="Clone URL"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton text={url} />
      </div>
    </div>
  );
}

export function QuickSetup({ info }: { info: RepoInfo }) {
  const url = cloneUrl(info);
  return (
    <section className="card">
      <header className={CARD_HEADER}>
        <h2 className="text-md m-0">
          Quick setup
        </h2>
      </header>
      <div className="body">
        <CloneBox info={info} />
        <p className="text-muted">
          Git asks for a username and password: use your Ether username and a <Link to="/settings">personal access token</Link>.
        </p>
        <h3>Push an existing repository</h3>
        <pre className={SETUP}>{`git remote add origin ${url}\ngit push -u origin main`}</pre>
        <h3>Start a new one</h3>
        <pre className={SETUP}>{`git init\ngit add .\ngit commit -m "first commit"\ngit branch -M main\ngit remote add origin ${url}\ngit push -u origin main`}</pre>
      </div>
    </section>
  );
}

export { RefPicker };

export function Breadcrumb({ info, gitRef, path }: { info: RepoInfo; gitRef: string; path: string }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const parts = path ? path.split("/") : [];
  return (
    <p className="m-0 text-lg" aria-label="Path">
      <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: gitRef }}>
        {info.repo.name}
      </Link>
      {parts.map((part, i) => (
        <span key={i}>
          <span className="mx-1 text-muted">/</span>
          {i === parts.length - 1 ? (
            <strong>{part}</strong>
          ) : (
            <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: `${gitRef}/${parts.slice(0, i + 1).join("/")}` }}>
              {part}
            </Link>
          )}
        </span>
      ))}
    </p>
  );
}

export function TreeView({
  info,
  gitRef,
  data,
  top,
  side,
  releases,
}: {
  info: RepoInfo;
  gitRef: string;
  data: TreeData;
  top?: ReactNode;
  side?: ReactNode;
  releases?: Release[];
}) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const parent = [gitRef, data.path.split("/").slice(0, -1).join("/")].filter(Boolean).join("/");
  return (
    <div className={LAYOUT_2}>
      <div className={MAIN_COL}>
        {top}
        <div className={ROW}>
          <RefPicker info={info} current={gitRef} kind="tree" />
          {data.path && <Breadcrumb info={info} gitRef={gitRef} path={data.path} />}
        </div>
        <section className="card">
          {data.lastCommit && (
            <header className={`${CARD_HEADER} text-sm`}>
              <Avatar name={data.lastCommit.author} />
              <strong>{data.lastCommit.author}</strong>
              <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: data.lastCommit.sha }} className="min-w-0 wrap-anywhere text-fg">
                {data.lastCommit.subject}
              </Link>
              <span className="flex-1" />
              <code className="text-muted">{shortSha(data.lastCommit.sha)}</code>
              <span className="text-muted">{timeAgo(data.lastCommit.date)}</span>
              {data.commitCount !== null && (
                <Link to="/$owner/$repo/commits/$" params={{ ...params, _splat: gitRef }} className="inline-flex items-center gap-1 font-semibold text-fg">
                  <History size={16} aria-hidden />
                  <span className="tabular-nums">{data.commitCount}</span> {data.commitCount === 1 ? "commit" : "commits"}
                </Link>
              )}
            </header>
          )}
          <table
            className="w-full table-fixed border-collapse [&_tr:first-child>td]:border-t-0 [&_tr:hover>td]:bg-surface-2 [&_tr:last-child>td:first-child]:rounded-bl-md [&_tr:last-child>td:last-child]:rounded-br-md"
            aria-label="Files"
          >
            <colgroup>
              <col className="w-[32%] max-sm:w-auto" />
              <col className="max-sm:hidden" />
              <col className="w-[128px] max-sm:w-[112px]" />
              <col className="w-[80px] max-sm:hidden" />
            </colgroup>
            <motion.tbody {...staggered}>
              {data.path && (
                <tr>
                  <td colSpan={4} className={TD}>
                    <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: parent }} aria-label="Parent directory">
                      ..
                    </Link>
                  </td>
                </tr>
              )}
              {data.entries.map((e, i) => (
                <motion.tr key={e.path} variants={rise} custom={i}>
                  <td className={`${TD} wrap-anywhere`}>
                    <span className="inline-flex items-center gap-2 wrap-anywhere">
                      {e.type === "tree" ? <Folder size={16} aria-hidden className="flex-none text-link" /> : e.type === "commit" ? <FolderGit2 size={16} aria-hidden /> : <FileText size={16} aria-hidden className="text-muted" />}
                      {e.type === "commit" ? (
                        <span title="Submodule">{e.name}</span>
                      ) : (
                        <Link to={e.type === "tree" ? "/$owner/$repo/tree/$" : "/$owner/$repo/blob/$"} params={{ ...params, _splat: `${gitRef}/${e.path}` }}>
                          {e.name}
                        </Link>
                      )}
                    </span>
                  </td>
                  <td className={`${TD} truncate text-muted max-sm:hidden`}>
                    {e.lastCommit && (
                      <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: e.lastCommit.sha }} className="text-muted hover:text-link">
                        {e.lastCommit.subject}
                      </Link>
                    )}
                  </td>
                  <td className={`${TD} text-right whitespace-nowrap text-muted`}>{e.lastCommit ? timeAgo(e.lastCommit.date) : ""}</td>
                  <td className={`${TD} text-right whitespace-nowrap text-muted tabular-nums max-sm:hidden`}>{e.size !== null ? formatSize(e.size) : ""}</td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </section>
        {data.readme !== null && (
          <section className="card">
            <header className={CARD_HEADER}>
              <BookOpen size={16} aria-hidden />
              <strong>README</strong>
            </header>
            <Markdown source={data.readme} label="README" />
          </section>
        )}
      </div>
      <aside className={SIDE_COL}>
        <section aria-labelledby="side-about">
          <h3 id="side-about" className={SIDE_HEADING}>
            About
          </h3>
          <p className={SIDE_TEXT}>{info.repo.description || <span className="text-muted">No description.</span>}</p>
          <ul className="mt-2.5 mb-0 mx-0 flex list-none flex-col gap-1.5 p-0 text-sm text-muted">
            <li className="flex items-center gap-2">
              <Star size={14} aria-hidden /> <span className="font-semibold tabular-nums text-fg">{info.stars}</span> {info.stars === 1 ? "star" : "stars"}
            </li>
            <li className="flex items-center gap-2">
              <GitBranch size={14} aria-hidden /> <span className="font-semibold tabular-nums text-fg">{info.branches.length}</span> {info.branches.length === 1 ? "branch" : "branches"}
            </li>
            <li className="flex items-center gap-2">
              <Tag size={14} aria-hidden /> <span className="font-semibold tabular-nums text-fg">{info.tags.length}</span> {info.tags.length === 1 ? "tag" : "tags"}
            </li>
          </ul>
        </section>
        <section aria-labelledby="side-clone">
          <h3 id="side-clone" className={SIDE_HEADING}>
            Clone
          </h3>
          <CloneBox info={info} />
          <p className="hint mt-2">Sign in to git with your username and a personal access token.</p>
        </section>
        {side}
        <section aria-labelledby="side-releases">
          <h3 id="side-releases" className={SIDE_HEADING}>
            <Link to="/$owner/$repo/releases" params={params} className="text-fg">
              Releases
            </Link>{" "}
            {releases && releases.length > 0 && <span className="count">{releases.length}</span>}
          </h3>
          {releases?.length ? (
            <div className={`${SIDE_TEXT} flex flex-wrap items-center gap-2`}>
              <Tag size={16} aria-hidden className="text-muted" />
              <Link to="/$owner/$repo/releases/tag/$tag" params={{ ...params, tag: releases[0].tag }}>
                {releases[0].title}
              </Link>
              <span className="pill">Latest</span>
              <span className="font-mono text-muted">{releases[0].tag}</span>
              <span className="basis-full text-xs text-muted">
                {releases[0].author ? `${releases[0].author} · ` : ""}
                {timeAgo(releases[0].createdAt)}
              </span>
            </div>
          ) : info.tags.length ? (
            <div className={`${SIDE_TEXT} flex flex-wrap items-center gap-2`}>
              <Tag size={16} aria-hidden className="text-muted" />
              <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: info.tags[0] }} className="font-mono">
                {info.tags[0]}
              </Link>
              <span className="tabular-nums text-muted">{info.tags.length === 1 ? "1 tag" : `${info.tags.length} tags`}</span>
            </div>
          ) : (
            <p className={`${SIDE_TEXT} text-muted`}>No releases yet.</p>
          )}
          {info.role !== "read" && (
            <Link to="/$owner/$repo/releases/new" params={params} className={SIDE_TEXT}>
              Create a release
            </Link>
          )}
        </section>
      </aside>
    </div>
  );
}

export function BlobView({ info, gitRef, data }: { info: RepoInfo; gitRef: string; data: BlobData }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const raw = `${repoApi(info.repo.owner, info.repo.name)}/raw?${new URLSearchParams({ ref: data.sha, path: data.path })}`;
  return (
    <div className="stack-md">
      <div className={ROW}>
        <RefPicker info={info} current={gitRef} kind="tree" />
        <Breadcrumb info={info} gitRef={gitRef} path={data.path} />
      </div>
      <section className="card">
        <header className={CARD_HEADER}>
          <span className="text-muted">{formatSize(data.size)}</span>
          <span className="flex-1" />
          <Link to="/$owner/$repo/commits/$" params={{ ...params, _splat: gitRef }} search={{ path: data.path }} className="button">
            History
          </Link>
          <a className="button" href={raw}>
            Download
          </a>
        </header>
        {data.content !== null ? (
          <CodeView path={data.path} content={data.content} />
        ) : (
          <p className="empty">{data.binary ? "Binary file not shown." : "This file is too large to display."}</p>
        )}
      </section>
    </div>
  );
}
