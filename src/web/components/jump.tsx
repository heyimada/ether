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
    <div className="jump" ref={root}>
      <Command shouldFilter={false} label="Search or jump to" loop>
        <div className="jump-field">
          <Search size={16} aria-hidden className="muted" />
          <Command.Input
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
                    <span className="jump-name">
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
