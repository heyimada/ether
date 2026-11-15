import * as linguist from "linguist-languages";
import * as git from "./git";

// Language breakdown of a commit's tree by bytes, like GitHub's language bar. Languages come from
// GitHub Linguist's data (extensions, file names and colours). Programming, markup and prose
// count; data formats (JSON, YAML, lockfiles…) and vendored or generated directories don't.

type Lang = { name: string; color: string | null };

const COUNTED = new Set(["programming", "markup", "prose"]);
// Where Linguist lists an extension under several languages, the one people almost always mean.
const PREFERRED: Record<string, string> = {
  ".md": "Markdown",
  ".h": "C",
  ".m": "Objective-C",
  ".pl": "Perl",
  ".t": "Perl",
  ".r": "R",
  ".rs": "Rust",
  ".v": "Verilog",
  ".cs": "C#",
  ".fs": "F#",
  ".html": "HTML",
  ".inc": "PHP",
  ".asm": "Assembly",
  ".d": "D",
  ".l": "Lex",
  ".pro": "Prolog",
  ".cls": "TeX",
  ".b": "Brainfuck",
};
// Linguist files plain SQL under data; its dialects can't be told apart by extension alone.
const AMBIGUOUS = new Set([".sql"]);
const SKIP_DIRS = /(^|\/)(node_modules|vendor|vendors|dist|build|out|target|third[_-]?party|bower_components|\.yarn|\.git)\//i;
const SKIP_FILES = /(\.min\.(js|css)|\.map|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock)$/i;

const byExtension = new Map<string, Lang>();
const byFilename = new Map<string, Lang>();
{
  const candidates = new Map<string, { lang: Lang; primary: boolean }[]>();
  for (const l of Object.values(linguist) as { name: string; type: string; color?: string; extensions?: string[]; filenames?: string[] }[]) {
    if (!COUNTED.has(l.type)) continue;
    const lang = { name: l.name, color: l.color ?? null };
    (l.extensions ?? []).forEach((ext, i) => {
      const key = ext.toLowerCase();
      candidates.set(key, [...(candidates.get(key) ?? []), { lang, primary: i === 0 }]);
    });
    for (const f of l.filenames ?? []) if (!byFilename.has(f)) byFilename.set(f, lang);
  }
  for (const [ext, list] of candidates) {
    if (AMBIGUOUS.has(ext)) continue;
    const pick = list.find((c) => c.lang.name === PREFERRED[ext]) ?? (list.length === 1 ? list[0] : list.find((c) => c.primary) ?? list[0]);
    byExtension.set(ext, pick.lang);
  }
}

export function languageOf(path: string): Lang | null {
  if (SKIP_DIRS.test(path) || SKIP_FILES.test(path)) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const named = byFilename.get(name);
  if (named) return named;
  // Longest matching extension first, so ".d.ts" style double extensions can win when listed.
  for (let i = name.indexOf("."); i !== -1; i = name.indexOf(".", i + 1)) {
    const lang = byExtension.get(name.slice(i).toLowerCase());
    if (lang) return lang;
  }
  return null;
}

export type LanguageShare = { name: string; color: string | null; bytes: number; percent: number };

const cache = new Map<string, LanguageShare[]>();

// By bytes, largest first, for one commit. Cached per repository and commit: a commit never changes.
export async function languages(repoPath: string, sha: string): Promise<LanguageShare[]> {
  const key = `${repoPath}\0${sha}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await git.git(repoPath, ["-c", "core.quotepath=false", "ls-tree", "-r", "-l", "-z", "--end-of-options", sha]);
  const totals = new Map<string, { lang: Lang; bytes: number }>();
  if (res.code === 0) {
    for (const line of new TextDecoder().decode(res.stdout).split("\0")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      const [mode, type, , size] = line.slice(0, tab).split(/\s+/);
      // Plain files only: no symlinks (120000) or submodules.
      if (type !== "blob" || mode === "120000") continue;
      const lang = languageOf(line.slice(tab + 1));
      if (!lang) continue;
      const t = totals.get(lang.name) ?? { lang, bytes: 0 };
      t.bytes += Number(size) || 0;
      totals.set(lang.name, t);
    }
  }
  const sum = [...totals.values()].reduce((s, t) => s + t.bytes, 0);
  const out = sum
    ? [...totals.values()]
        .filter((t) => t.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes || a.lang.name.localeCompare(b.lang.name))
        .map((t) => ({ name: t.lang.name, color: t.lang.color, bytes: t.bytes, percent: (t.bytes / sum) * 100 }))
    : [];
  // Old commits fall out eventually; a few hundred repositories' heads fit easily.
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

// The main language of each repository's default branch, for repository lists.
export async function primaryLanguage(repoPath: string): Promise<{ name: string; color: string | null } | null> {
  const head = await git.resolveCommit(repoPath, await git.headBranch(repoPath));
  if (!head) return null;
  const [top] = await languages(repoPath, head);
  return top ? { name: top.name, color: top.color } : null;
}
