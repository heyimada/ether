import { parsePatchFiles } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, useState } from "react";
import { ROW } from "./ui";

const THEMES = { light: "github-light", dark: "github-dark" } as const;

// Markdown from repositories, issues and comments is untrusted: always sanitize.
export function Markdown({ source, label }: { source: string; label?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }) as string), [source]);
  if (!source.trim()) return <p className="text-muted">No description provided.</p>;
  return <article className="markdown" aria-label={label} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function CodeView({ path, content }: { path: string; content: string }) {
  const file = useMemo(() => ({ name: path, contents: content, cacheKey: `${path}:${content.length}` }), [path, content]);
  return (
    <section className="code" aria-label="File contents">
      <File file={file} options={{ theme: THEMES, themeType: "system", disableFileHeader: true, overflow: "scroll" }} />
    </section>
  );
}

export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const files = useMemo(() => parsePatchFiles(diff).flatMap((p) => p.files), [diff]);
  if (!files.length) return <p className="text-muted">No changes.</p>;
  return (
    <section aria-label="Diff">
      <div className={ROW}>
        <span className="text-muted">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <span className="flex-1" />
        <div role="group" aria-label="Diff layout" className={ROW}>
          <button className={style === "unified" ? "primary small" : "small"} onClick={() => setStyle("unified")} aria-pressed={style === "unified"}>
            Unified
          </button>
          <button className={style === "split" ? "primary small" : "small"} onClick={() => setStyle("split")} aria-pressed={style === "split"}>
            Split
          </button>
        </div>
      </div>
      {truncated && <p className="notice">This diff is very large and was truncated.</p>}
      {files.map((f, i) => (
        <FileDiff key={`${f.prevName ?? ""}>${f.name}:${i}`} className="diff-file" fileDiff={f} options={{ theme: THEMES, themeType: "system", diffStyle: style }} />
      ))}
    </section>
  );
}
