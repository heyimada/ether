import * as Popover from "@radix-ui/react-popover";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Check, ChevronDown, GitBranch, Tag } from "lucide-react";
import { useState } from "react";
import type { RepoInfo } from "../lib/api";

// Branch and tag switcher: a filter field, Branches and Tags tabs, the current ref checked
// and the default branch marked. Picking a ref opens the same view at that ref.
export function RefPicker({ info, current, kind }: { info: RepoInfo; current: string; kind: "tree" | "commits" }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const isTag = info.tags.includes(current) && !info.branches.includes(current);
  const [tab, setTab] = useState<"branches" | "tags">(isTag ? "tags" : "branches");
  const def = info.repo.defaultBranch;
  const branches = [...info.branches].sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
  const refs = (tab === "branches" ? branches : info.tags).filter((r) => r.toLowerCase().includes(query.trim().toLowerCase()));

  const pick = (ref: string) => {
    setOpen(false);
    setQuery("");
    const params = { owner: info.repo.owner, repo: info.repo.name, _splat: ref };
    navigate(kind === "tree" ? { to: "/$owner/$repo/tree/$", params } : { to: "/$owner/$repo/commits/$", params });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="ref-trigger" aria-label={`Switch branch or tag, current ${current}`}>
        {isTag ? <Tag size={16} aria-hidden /> : <GitBranch size={16} aria-hidden />}
        <span className="mono ref-name">{current}</span>
        <ChevronDown size={16} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="start" sideOffset={6} aria-label="Switch branch or tag">
          <Command shouldFilter={false} label="Branches and tags">
            <div className="popover-head">
              <strong>Switch branches or tags</strong>
              <Command.Input className="popover-filter" value={query} onValueChange={setQuery} placeholder="Filter branches and tags" aria-label="Filter branches and tags" />
            </div>
            <div className="popover-tabs" role="tablist" aria-label="Ref type">
              {(["branches", "tags"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === "branches" ? "Branches" : "Tags"}
                </button>
              ))}
            </div>
            <Command.List className="popover-list">
              {refs.map((ref) => (
                <Command.Item key={ref} value={ref} onSelect={() => pick(ref)} className="popover-item">
                  <Check size={16} aria-hidden className={ref === current ? "" : "invisible"} />
                  <span className="mono popover-ref">{ref}</span>
                  {tab === "branches" && ref === def && <span className="pill">default</span>}
                </Command.Item>
              ))}
              <Command.Empty className="popover-empty">{tab === "branches" ? "No branches match." : info.tags.length ? "No tags match." : "No tags yet."}</Command.Empty>
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
