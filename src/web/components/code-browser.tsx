import { Link, useRouteContext } from "@tanstack/react-router";
import { BookOpen, FileText, Folder, FolderGit2, History, Tag } from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import formatSize from "pretty-bytes";
import { api, repoApi, shortSha, timeAgo, type Commit, type RepoInfo, type TreeEntry } from "../lib/api";
import { rise, staggered } from "../lib/motion";
import { CodeView, Markdown } from "./content";
import { RefPicker } from "./ref-picker";
import type { Release } from "./releases";
import { Avatar, CopyButton } from "./ui";

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
    <div className="stack-sm" style={{ gap: 6 }}>
      {ssh && (
        <div className="popover-tabs clone-tabs" role="tablist" aria-label="Clone over">
          {(["https", "ssh"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
              {k === "https" ? "HTTPS" : "SSH"}
            </button>
          ))}
        </div>
      )}
      <div className="clone">
        <input className="mono" readOnly value={url} aria-label="Clone URL" onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={url} />
      </div>
    </div>
  );
}

export function QuickSetup({ info }: { info: RepoInfo }) {
  const url = cloneUrl(info);
  return (
    <section className="card">
      <header>
        <h2 style={{ margin: 0 }}>Quick setup</h2>
      </header>
      <div className="body">
        <CloneBox info={info} />
        <p className="muted">
          Git asks for a username and password: use your Ether username and a <Link to="/settings">personal access token</Link>.
        </p>
        <h3>Push an existing repository</h3>
        <pre className="setup">{`git remote add origin ${url}\ngit push -u origin main`}</pre>
        <h3>Start a new one</h3>
        <pre className="setup">{`git init\ngit add .\ngit commit -m "first commit"\ngit branch -M main\ngit remote add origin ${url}\ngit push -u origin main`}</pre>
      </div>
    </section>
  );
}

export { RefPicker };

export function Breadcrumb({ info, gitRef, path }: { info: RepoInfo; gitRef: string; path: string }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const parts = path ? path.split("/") : [];
  return (
    <p className="breadcrumb" aria-label="Path">
      <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: gitRef }}>
        {info.repo.name}
      </Link>
      {parts.map((part, i) => (
        <span key={i}>
          <span className="sep">/</span>
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
    <div className="layout-2">
      <div className="main-col">
        {top}
        <div className="row">
          <RefPicker info={info} current={gitRef} kind="tree" />
          {data.path && <Breadcrumb info={info} gitRef={gitRef} path={data.path} />}
        </div>
        <section className="card">
          {data.lastCommit && (
            <header className="commit-bar">
              <Avatar name={data.lastCommit.author} />
              <strong>{data.lastCommit.author}</strong>
              <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: data.lastCommit.sha }} className="commit-bar-msg">
                {data.lastCommit.subject}
              </Link>
              <span className="spacer" />
              <code className="muted">{shortSha(data.lastCommit.sha)}</code>
              <span className="muted">{timeAgo(data.lastCommit.date)}</span>
              {data.commitCount !== null && (
                <Link to="/$owner/$repo/commits/$" params={{ ...params, _splat: gitRef }} className="commit-count">
                  <History size={16} aria-hidden />
                  <span className="num">{data.commitCount}</span> {data.commitCount === 1 ? "commit" : "commits"}
                </Link>
              )}
            </header>
          )}
          <table className="files" aria-label="Files">
            <colgroup>
              <col className="col-name" />
              <col className="col-msg" />
              <col className="col-when" />
              <col className="col-size" />
            </colgroup>
            <motion.tbody {...staggered}>
              {data.path && (
                <tr>
                  <td colSpan={4}>
                    <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: parent }} aria-label="Parent directory">
                      ..
                    </Link>
                  </td>
                </tr>
              )}
              {data.entries.map((e, i) => (
                <motion.tr key={e.path} variants={rise} custom={i}>
                  <td className="name">
                    <span className="file-name">
                      {e.type === "tree" ? <Folder size={16} aria-hidden className="dir-icon" /> : e.type === "commit" ? <FolderGit2 size={16} aria-hidden /> : <FileText size={16} aria-hidden className="muted" />}
                      {e.type === "commit" ? (
                        <span title="Submodule">{e.name}</span>
                      ) : (
                        <Link to={e.type === "tree" ? "/$owner/$repo/tree/$" : "/$owner/$repo/blob/$"} params={{ ...params, _splat: `${gitRef}/${e.path}` }}>
                          {e.name}
                        </Link>
                      )}
                    </span>
                  </td>
                  <td className="msg">
                    {e.lastCommit && (
                      <Link to="/$owner/$repo/commit/$sha" params={{ ...params, sha: e.lastCommit.sha }}>
                        {e.lastCommit.subject}
                      </Link>
                    )}
                  </td>
                  <td className="when">{e.lastCommit ? timeAgo(e.lastCommit.date) : ""}</td>
                  <td className="size num">{e.size !== null ? formatSize(e.size) : ""}</td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </section>
        {data.readme !== null && (
          <section className="card">
            <header>
              <BookOpen size={16} aria-hidden />
              <strong>README</strong>
            </header>
            <Markdown source={data.readme} label="README" />
          </section>
        )}
      </div>
      <aside className="side-col">
        <section className="side-section" aria-labelledby="side-about">
          <h3 id="side-about">About</h3>
          <p className="side-text">{info.repo.description || <span className="muted">No description.</span>}</p>
        </section>
        <section className="side-section" aria-labelledby="side-clone">
          <h3 id="side-clone">Clone</h3>
          <CloneBox info={info} />
          <p className="hint">Sign in to git with your username and a personal access token.</p>
        </section>
        {side}
        <section className="side-section" aria-labelledby="side-releases">
          <h3 id="side-releases">
            <Link to="/$owner/$repo/releases" params={params} className="heading-link">
              Releases
            </Link>{" "}
            {releases && releases.length > 0 && <span className="count">{releases.length}</span>}
          </h3>
          {releases?.length ? (
            <div className="side-text release">
              <Tag size={16} aria-hidden className="muted" />
              <Link to="/$owner/$repo/releases/tag/$tag" params={{ ...params, tag: releases[0].tag }}>
                {releases[0].title}
              </Link>
              <span className="pill">Latest</span>
              <span className="muted mono">{releases[0].tag}</span>
            </div>
          ) : info.tags.length ? (
            <div className="side-text release">
              <Tag size={16} aria-hidden className="muted" />
              <Link to="/$owner/$repo/tree/$" params={{ ...params, _splat: info.tags[0] }} className="mono">
                {info.tags[0]}
              </Link>
              <span className="muted num">{info.tags.length === 1 ? "1 tag" : `${info.tags.length} tags`}</span>
            </div>
          ) : (
            <p className="side-text muted">No releases yet.</p>
          )}
          {info.role !== "read" && (
            <Link to="/$owner/$repo/releases/new" params={params} className="side-text">
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
      <div className="row">
        <RefPicker info={info} current={gitRef} kind="tree" />
        <Breadcrumb info={info} gitRef={gitRef} path={data.path} />
      </div>
      <section className="card">
        <header>
          <span className="muted">{formatSize(data.size)}</span>
          <span className="spacer" />
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
