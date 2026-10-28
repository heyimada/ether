import { useNavigate, useParams } from "@tanstack/react-router";
import { Command } from "cmdk";
import { BookLock, CircleDot, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, repoApi, type Issue } from "../lib/api";

type RepoRow = { owner: string; name: string; description: string };

// Header search: jumps to any repository you can see, or to #number in the current one.
export function JumpBox() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { owner?: string; repo?: string };
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<RepoRow[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || repos) return;
    api<{ repos: RepoRow[] }>("/api/repos").then((r) => setRepos(r.repos), () => setRepos([]));
  }, [open, repos]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const done = () => {
    setOpen(false);
    setQuery("");
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const q = query.trim().toLowerCase();
  const number = /^#(\d+)$/.exec(q)?.[1];
  const inRepo = params.owner && params.repo ? { owner: params.owner, repo: params.repo } : null;
  const matches = (repos ?? []).filter((r) => `${r.owner}/${r.name} ${r.description}`.toLowerCase().includes(q)).slice(0, 8);

  const goToNumber = async () => {
    if (!inRepo || !number) return;
    done();
    // Issues and pull requests share numbers; ask which one this is before routing.
    const { issue } = await api<{ issue: Issue }>(`${repoApi(inRepo.owner, inRepo.repo)}/issues/${number}`).catch(() => ({ issue: null as Issue | null }));
    await navigate(
      issue?.isPull
        ? { to: "/$owner/$repo/pull/$number", params: { ...inRepo, number } }
        : { to: "/$owner/$repo/issues/$number", params: { ...inRepo, number } },
    );
  };

  return (
    <div className="relative min-w-0 flex-[0_1_320px] max-md:order-3 max-md:flex-[1_1_100%]" ref={root}>
      <Command shouldFilter={false} label="Search or jump to" loop>
        <div className="flex items-center gap-2 rounded-sm border border-border bg-[color-mix(in_srgb,var(--surface-2)_80%,transparent)] px-2.5 text-muted [transition:border-color_150ms_ease,box-shadow_220ms_ease] hover:border-control-border focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-focus focus-within:bg-surface focus-within:shadow-[0_0_0_6px_color-mix(in_srgb,var(--focus)_14%,transparent)]">
          <Search size={16} aria-hidden className="text-muted" />
          <Command.Input
            className="min-w-0 border-0 bg-transparent px-0 py-1.5 text-fg outline-none focus-visible:shadow-none focus-visible:outline-none"
            aria-label="Search or jump to"
            placeholder="Search or jump to…"
            value={query}
            onValueChange={(v) => {
              setQuery(v);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") done();
              // "#12" is a direct jump, so Enter goes there without picking an item first.
              if (e.key === "Enter" && number && inRepo) {
                e.preventDefault();
                goToNumber();
              }
            }}
          />
        </div>
        {open && (
          <Command.List className="jump-list">
            {repos === null && <Command.Loading>Loading repositories…</Command.Loading>}
            {number && inRepo && (
              <Command.Item value={`#${number}`} onSelect={goToNumber}>
                <CircleDot size={16} aria-hidden />
                Go to #{number} in {inRepo.owner}/{inRepo.repo}
              </Command.Item>
            )}
            {!number && (
              <Command.Group heading="Repositories">
                {matches.map((r) => (
                  <Command.Item
                    key={`${r.owner}/${r.name}`}
                    value={`${r.owner}/${r.name}`}
                    onSelect={() => {
                      done();
                      navigate({ to: "/$owner/$repo", params: { owner: r.owner, repo: r.name } });
                    }}
                  >
                    <BookLock size={16} aria-hidden />
                    <span className="wrap-anywhere">
                      {r.owner}/{r.name}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {!number && "new repository".includes(q) && (
              <Command.Group heading="Actions">
                <Command.Item
                  value="new-repository"
                  onSelect={() => {
                    done();
                    navigate({ to: "/new" });
                  }}
                >
                  <Plus size={16} aria-hidden />
                  New repository
                </Command.Item>
              </Command.Group>
            )}
            {repos !== null && <Command.Empty>{number ? "Open a repository first to jump by number." : "No repositories match."}</Command.Empty>}
          </Command.List>
        )}
      </Command>
    </div>
  );
}
