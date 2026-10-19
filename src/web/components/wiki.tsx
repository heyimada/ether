import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { put, repoApi, type RepoInfo } from "../lib/api";
import { Markdown } from "./content";
import { ErrorNote, Field, onSubmit, useAction } from "./ui";

export type WikiPage = { slug: string; title: string };

export const titleToSlug = (title: string) =>
  title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 100);

// [[Page]] and [[text|Page]] become links; missing pages link to creating them.
function linkWikiPages(source: string, info: RepoInfo, pages: WikiPage[]) {
  const base = `/${info.repo.owner}/${info.repo.name}/wiki`;
  const known = new Set(pages.map((p) => p.slug));
  return source.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, a: string, b?: string) => {
    const [text, target] = b ? [a.trim(), b.trim()] : [a.trim(), a.trim()];
    const slug = titleToSlug(target);
    const href = known.has(slug) ? `${base}/${slug}` : `${base}/new?title=${encodeURIComponent(target)}`;
    return `[${text.replace(/[[\]]/g, "")}](${href})`;
  });
}

export function WikiContent({ info, source, pages, title }: { info: RepoInfo; source: string; pages: WikiPage[]; title: string }) {
  return <Markdown source={linkWikiPages(source, info, pages)} label={title} />;
}

export function WikiSidebar({ info, pages, current }: { info: RepoInfo; pages: WikiPage[]; current?: string }) {
  const params = { owner: info.repo.owner, repo: info.repo.name };
  return (
    <aside className="side-col">
      <section className="side-section">
        <div className="side-head">
          <h3>Pages</h3>
          <span className="muted num">{pages.length}</span>
        </div>
        <ul className="people" aria-label="Wiki pages">
          {pages.map((p) => (
            <li key={p.slug}>
              <Link to="/$owner/$repo/wiki/$slug" params={{ ...params, slug: p.slug }} className={p.slug === current ? "active-page" : ""}>
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
        {info.role !== "read" && (
          <Link to="/$owner/$repo/wiki/new" params={params} search={{}} className="button small" style={{ marginTop: 12 }}>
            New page
          </Link>
        )}
      </section>
      <section className="side-section">
        <h3>Clone this wiki</h3>
        <code className="side-text" style={{ overflowWrap: "anywhere" }}>
          {`${location.origin}/${info.repo.owner}/${info.repo.name}.wiki.git`}
        </code>
      </section>
    </aside>
  );
}

export function WikiEditor({ info, slug, initial }: { info: RepoInfo; slug?: string; initial: { title: string; content: string } }) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [message, setMessage] = useState("");
  const save = useAction(async () => {
    const target = slug ?? titleToSlug(title);
    if (!target) throw new Error("Give the page a title");
    const res = await put<{ slug: string }>(`${repoApi(info.repo.owner, info.repo.name)}/wiki/${encodeURIComponent(target)}`, { title, content, message });
    await router.invalidate();
    await router.navigate({ to: "/$owner/$repo/wiki/$slug", params: { owner: info.repo.owner, repo: info.repo.name, slug: res.slug } });
  });
  return (
    <form className="card body stack-md" onSubmit={onSubmit(save.run)}>
      <ErrorNote error={save.error} />
      <Field id="wiki-title" label="Page title">
        <input id="wiki-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} />
      </Field>
      <Field id="wiki-content" label="Content" hint="Markdown. Link other pages with [[Page title]].">
        <textarea id="wiki-content" value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 320 }} className="mono" />
      </Field>
      <Field id="wiki-message" label="Edit message" hint="Optional: what changed.">
        <input id="wiki-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} />
      </Field>
      <div>
        <button className="primary" disabled={save.pending}>
          Save page
        </button>
      </div>
    </form>
  );
}
