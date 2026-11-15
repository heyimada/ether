import * as Popover from "@radix-ui/react-popover";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Check, ChevronDown, GitBranch, GitBranchPlus, Tag } from "lucide-react";
import { useState } from "react";
import { post, repoApi, type RepoInfo } from "../lib/api";
import { ErrorNote, useAction } from "./ui";

// The Branches / Tags tabs, shared with the clone box on the repository page.
export const TAB_BUTTON =
  "min-h-0 rounded-none border-0 border-b-2 border-transparent bg-transparent px-2 py-1.5 shadow-none [transition:border-color_220ms_var(--ease-out),background-color_150ms_ease] hover:not-disabled:border-transparent hover:not-disabled:bg-surface-3 active:transform-none aria-selected:border-b-accent aria-selected:font-semibold aria-selected:hover:not-disabled:border-b-accent";

// Branch and tag switcher: a filter field, Branches and Tags tabs, the current ref checked
// and the default branch marked. Picking a ref opens the same view at that ref. Typing a name that
// isn't a branch yet offers to create it from the current ref, for anyone who may push.
export function RefPicker({ info, current, kind }: { info: RepoInfo; current: string; kind: "tree" | "commits" }) {
  const navigate = useNavigate();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const isTag = info.tags.includes(current) && !info.branches.includes(current);
  const [tab, setTab] = useState<"branches" | "tags">(isTag ? "tags" : "branches");
  const def = info.repo.defaultBranch;
  const branches = [...info.branches].sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
  const refs = (tab === "branches" ? branches : info.tags).filter((r) => r.toLowerCase().includes(query.trim().toLowerCase()));

  const wanted = query.trim();
  const canCreate = tab === "branches" && info.role !== "read" && !info.repo.empty && wanted !== "" && !info.branches.includes(wanted);

  const pick = (ref: string) => {
    setOpen(false);
    setQuery("");
    const params = { owner: info.repo.owner, repo: info.repo.name, _splat: ref };
    navigate(kind === "tree" ? { to: "/$owner/$repo/tree/$", params } : { to: "/$owner/$repo/commits/$", params });
  };

  // The name the last create was for: its error only shows while that name is still in the field.
  const [tried, setTried] = useState<string | null>(null);
  const create = useAction(async (name: string) => {
    setTried(name);
    await post(`${repoApi(info.repo.owner, info.repo.name)}/branches`, { name, from: current });
    await router.invalidate();
    pick(name);
  });

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTried(null);
      }}
    >
      <Popover.Trigger className="max-w-full" aria-label={`Switch branch or tag, current ${current}`}>
        {isTag ? <Tag size={16} aria-hidden /> : <GitBranch size={16} aria-hidden />}
        <span className="max-w-[220px] truncate font-mono">{current}</span>
        <ChevronDown size={16} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="start" sideOffset={6} aria-label="Switch branch or tag">
          <Command shouldFilter={false} label="Branches and tags">
            <div className="flex flex-col gap-2 border-b border-border p-3">
              <strong>Switch branches or tags</strong>
              <Command.Input
                className="px-2 py-1.5"
                value={query}
                onValueChange={setQuery}
                placeholder="Filter branches and tags"
                aria-label="Filter branches and tags"
              />
            </div>
            <div className="flex gap-1 border-b border-border px-3 pt-2 pb-0" role="tablist" aria-label="Ref type">
              {(["branches", "tags"] as const).map((t) => (
                <button key={t} type="button" role="tab" className={TAB_BUTTON} aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === "branches" ? "Branches" : "Tags"}
                </button>
              ))}
            </div>
            <Command.List className="max-h-[280px] overflow-y-auto p-1">
              {refs.map((ref) => (
                <Command.Item key={ref} value={ref} onSelect={() => pick(ref)} className="popover-item">
                  <Check size={16} aria-hidden className={ref === current ? "" : "invisible"} />
                  <span className="min-w-0 flex-1 wrap-anywhere font-mono text-sm">{ref}</span>
                  {tab === "branches" && ref === def && <span className="pill">default</span>}
                </Command.Item>
              ))}
              {canCreate && (
                <Command.Item value={`create:${wanted}`} onSelect={() => !create.pending && create.run(wanted)} className="popover-item" disabled={create.pending}>
                  <GitBranchPlus size={16} aria-hidden />
                  <span className="min-w-0 flex-1 wrap-anywhere text-sm">
                    Create branch <strong className="font-mono">{wanted}</strong> from <span className="font-mono">{current}</span>
                  </span>
                </Command.Item>
              )}
              {!canCreate && (
                <Command.Empty className="px-2 py-1.5 text-xs text-muted">
                  {tab === "branches" ? "No branches match." : info.tags.length ? "No tags match." : "No tags yet."}
                </Command.Empty>
              )}
            </Command.List>
            {create.error && canCreate && tried === wanted && (
              <div className="border-t border-border p-3">
                <ErrorNote error={create.error} />
              </div>
            )}
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
