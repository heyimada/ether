import { Link } from "@tanstack/react-router";
import formatSize from "pretty-bytes";
import { FileArchive, Package, Tag } from "lucide-react";
import { repoApi, timeAgo, type RepoInfo } from "../lib/api";
import { Markdown } from "./content";

export type Release = {
  tag: string;
  title: string;
  notes: string;
  prerelease: boolean;
  author: string | null;
  createdAt: string;
  assets: { name: string; size: number }[];
};

export function ReleaseCard({ info, release, latest, headingLevel = 2 }: { info: RepoInfo; release: Release; latest?: boolean; headingLevel?: 1 | 2 }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  const base = `${repoApi(info.repo.owner, info.repo.name)}/releases/${encodeURIComponent(release.tag)}`;
  const H = headingLevel === 1 ? "h1" : "h2";
  return (
    <article className="card release-card" aria-label={`Release ${release.tag}`}>
      <header>
        <H style={{ margin: 0, fontSize: headingLevel === 1 ? 24 : 18 }}>
          {headingLevel === 1 ? (
            release.title
          ) : (
            <Link to="/$owner/$repo/releases/tag/$tag" params={{ ...params, tag: release.tag }} className="heading-link">
              {release.title}
            </Link>
          )}
        </H>
        {latest && <span className="pill pill-accent">Latest</span>}
        {release.prerelease && <span className="pill">Pre-release</span>}
        <span className="spacer" />
        <span className="muted mono">
          <Tag size={14} aria-hidden /> {release.tag}
        </span>
      </header>
      <div className="body stack-sm">
        <p className="muted" style={{ margin: 0 }}>
          {release.author ?? "Someone"} released this {timeAgo(release.createdAt)}
        </p>
        <Markdown source={release.notes || "_No release notes._"} label="Release notes" />
        <section aria-label="Assets">
          <h3 style={{ fontSize: 14, margin: "8px 0" }}>Assets</h3>
          <ul className="list card">
            {release.assets.map((a) => (
              <li key={a.name}>
                <Package size={16} aria-hidden className="muted" />
                <a href={`${base}/assets/${encodeURIComponent(a.name)}`}>{a.name}</a>
                <span className="spacer" />
                <span className="muted num">{formatSize(a.size)}</span>
              </li>
            ))}
            <li>
              <FileArchive size={16} aria-hidden className="muted" />
              <a href={`${base}/source.zip`}>Source code (zip)</a>
            </li>
          </ul>
        </section>
      </div>
    </article>
  );
}
