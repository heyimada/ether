import * as Menu from "@radix-ui/react-dropdown-menu";
import { Link, useRouter } from "@tanstack/react-router";
import { colord } from "colord";
import { Check, Settings2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, put, repoApi, type Issue, type Label, type RepoInfo } from "../lib/api";
import { Avatar, ErrorNote, useAction } from "./ui";

// A label in its own colour, with whichever text colour reads on it.
export function LabelPill({ label, info }: { label: Label; info?: RepoInfo }) {
  const bg = colord(label.color);
  const style = { background: label.color, color: bg.contrast("#ffffff") >= bg.contrast("#1f2328") ? "#ffffff" : "#1f2328" };
  if (!info)
    return (
      <span className="label-pill" style={style} title={label.description || undefined}>
        {label.name}
      </span>
    );
  return (
    <Link
      to="/$owner/$repo/issues"
      params={{ owner: info.repo.owner, repo: info.repo.name }}
      search={{ label: label.name }}
      className="label-pill"
      style={style}
      title={label.description || undefined}
    >
      {label.name}
    </Link>
  );
}

// Labels and assignees beside an issue or pull request; writers edit them from menus.
export function IssueSidebar({ info, issue, children }: { info: RepoInfo; issue: Issue; children?: ReactNode }) {
  const router = useRouter();
  const base = `${repoApi(info.repo.owner, info.repo.name)}/issues/${issue.number}`;
  const canEdit = info.role !== "read";
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [people, setPeople] = useState<string[] | null>(null);
  useEffect(() => {
    if (!canEdit) return;
    api<{ labels: Label[] }>(`${repoApi(info.repo.owner, info.repo.name)}/labels`).then((r) => setLabels(r.labels));
    api<{ users: string[] }>(`${repoApi(info.repo.owner, info.repo.name)}/assignable`).then((r) => setPeople(r.users));
  }, [canEdit, info.repo.owner, info.repo.name]);

  const save = useAction(async (path: "labels" | "assignees", values: string[]) => {
    await put(`${base}/${path}`, { [path]: values });
    await router.invalidate();
  });
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  // Picks apply immediately and optimistically, so quick successive toggles build on each other.
  const [current, setCurrent] = useState(issue.labels.map((l) => l.name));
  const [assigned, setAssigned] = useState(issue.assignees);
  useEffect(() => setCurrent(issue.labels.map((l) => l.name)), [issue.labels]);
  useEffect(() => setAssigned(issue.assignees), [issue.assignees]);
  const pickLabel = (name: string) => {
    const next = toggle(current, name);
    setCurrent(next);
    save.run("labels", next);
  };
  const pickPerson = (name: string) => {
    const next = toggle(assigned, name);
    setAssigned(next);
    save.run("assignees", next);
  };

  return (
    <aside className="issue-sidebar">
      {children}
      <ErrorNote error={save.error} />
      <section className="side-section">
        <div className="side-head">
          <h3>Labels</h3>
          {canEdit && (
            <Menu.Root>
              <Menu.Trigger className="ghost small" aria-label="Edit labels">
                <Settings2 size={16} aria-hidden />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu" align="end" sideOffset={4}>
                  <Menu.Label className="menu-label">Apply labels</Menu.Label>
                  {(labels ?? []).map((l) => (
                    <Menu.CheckboxItem
                      key={l.name}
                      className="menu-item"
                      checked={current.includes(l.name)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => pickLabel(l.name)}
                    >
                      <Check size={14} aria-hidden className={current.includes(l.name) ? "" : "invisible"} />
                      <span className="label-dot" style={{ background: l.color }} aria-hidden />
                      {l.name}
                    </Menu.CheckboxItem>
                  ))}
                  <Menu.Separator className="menu-sep" />
                  <Menu.Item asChild className="menu-item">
                    <Link to="/$owner/$repo/labels" params={{ owner: info.repo.owner, repo: info.repo.name }}>
                      Manage labels
                    </Link>
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          )}
        </div>
        {issue.labels.length ? (
          <ul className="chips" aria-label="Issue labels">
            {issue.labels.map((l) => (
              <li key={l.name}>
                <LabelPill label={l} info={info} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted side-text">None yet</p>
        )}
      </section>
      <section className="side-section">
        <div className="side-head">
          <h3>Assignees</h3>
          {canEdit && (
            <Menu.Root>
              <Menu.Trigger className="ghost small" aria-label="Edit assignees">
                <Settings2 size={16} aria-hidden />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu" align="end" sideOffset={4}>
                  <Menu.Label className="menu-label">Assign up to 10 people</Menu.Label>
                  {(people ?? []).map((p) => (
                    <Menu.CheckboxItem
                      key={p}
                      className="menu-item"
                      checked={assigned.includes(p)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => pickPerson(p)}
                    >
                      <Check size={14} aria-hidden className={assigned.includes(p) ? "" : "invisible"} />
                      <Avatar name={p} size={18} />
                      {p}
                    </Menu.CheckboxItem>
                  ))}
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          )}
        </div>
        {issue.assignees.length ? (
          <ul className="people" aria-label="Assignees">
            {issue.assignees.map((p) => (
              <li key={p}>
                <Avatar name={p} />
                <Link to="/$owner" params={{ owner: p }}>
                  {p}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted side-text">No one assigned</p>
        )}
      </section>
    </aside>
  );
}
