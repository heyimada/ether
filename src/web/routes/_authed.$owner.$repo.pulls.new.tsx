import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DiffView } from "../components/content";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { api, post, repoApi, type Commit } from "../lib/api";

type Compare = { commits: Commit[]; diff: string; truncated: boolean; mergeable: boolean };

export const Route = createFileRoute("/_authed/$owner/$repo/pulls/new")({ component: NewPull });

function NewPull() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const base = repoApi(info.repo.owner, info.repo.name);
  const [baseRef, setBaseRef] = useState(info.repo.defaultBranch);
  const [headRef, setHeadRef] = useState(info.branches.find((b) => b !== info.repo.defaultBranch) ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [compare, setCompare] = useState<Compare | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  useEffect(() => {
    setCompare(null);
    setCompareError(null);
    if (!baseRef || !headRef || baseRef === headRef) return;
    let live = true;
    api<Compare>(`${base}/compare?${new URLSearchParams({ base: baseRef, head: headRef })}`)
      .then((c) => live && setCompare(c))
      .catch((e) => live && setCompareError(e.message));
    return () => {
      live = false;
    };
  }, [base, baseRef, headRef]);

  const create = useAction(async () => {
    const { pull } = await post<{ pull: { number: number } }>(`${base}/pulls`, { title, body, base: baseRef, head: headRef });
    await router.invalidate();
    await router.navigate({ to: "/$owner/$repo/pull/$number", params: { owner: info.repo.owner, repo: info.repo.name, number: String(pull.number) } });
  });

  const branchSelect = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => set(e.target.value)} style={{ width: "auto", minWidth: 180 }}>
        <option value="" disabled>
          Choose a branch
        </option>
        {info.branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="stack-md">
      <h2>Open a pull request</h2>
      <div className="row card body" style={{ alignItems: "end" }}>
        {branchSelect("base", "Base", baseRef, setBaseRef)}
        <span className="muted" style={{ paddingBottom: 8 }}>
          ←
        </span>
        {branchSelect("compare", "Compare", headRef, setHeadRef)}
        {compare && (
          <span className={compare.mergeable ? "add-count" : "del-count"} style={{ paddingBottom: 8 }}>
            {compare.mergeable ? "✓ Able to merge" : "✗ These branches have conflicts"}
          </span>
        )}
      </div>
      {baseRef === headRef && <p className="notice">Choose two different branches to compare.</p>}
      <ErrorNote error={compareError} />
      <form className="card body" onSubmit={onSubmit(create.run)}>
        <ErrorNote error={create.error} />
        <Field id="title" label="Title">
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={256} />
        </Field>
        <Field id="body" label="Body" hint="Markdown is supported.">
          <textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <button className="primary" disabled={create.pending || !compare}>
          Create pull request
        </button>
      </form>
      {compare && (
        <>
          <h3>
            {compare.commits.length} commit{compare.commits.length === 1 ? "" : "s"}
          </h3>
          <DiffView diff={compare.diff} truncated={compare.truncated} />
        </>
      )}
    </div>
  );
}
