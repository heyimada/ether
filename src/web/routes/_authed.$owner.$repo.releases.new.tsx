import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { post, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/releases/new")({
  beforeLoad: ({ context, params }) => {
    if (context.info.role === "read") throw redirect({ to: "/$owner/$repo/releases", params });
  },
  component: NewRelease,
});

function NewRelease() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const base = `${repoApi(info.repo.owner, info.repo.name)}/releases`;
  const [tag, setTag] = useState("");
  const [target, setTarget] = useState(info.repo.defaultBranch);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState("");
  const exists = info.tags.includes(tag);

  const publish = useAction(async () => {
    await post(base, { tag, target, title, notes, prerelease });
    for (const [i, f] of files.entries()) {
      setProgress(`Uploading ${f.name} (${i + 1} of ${files.length})…`);
      const name = f.name.replace(/[^A-Za-z0-9._+-]/g, "_").replace(/^\.+/, "_");
      const res = await fetch(`${base}/${encodeURIComponent(tag)}/assets/${encodeURIComponent(name)}`, { method: "PUT", body: f, credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Uploading ${f.name} failed`);
    }
    setProgress("");
    await router.invalidate();
    await router.navigate({ to: "/$owner/$repo/releases/tag/$tag", params: { owner: info.repo.owner, repo: info.repo.name, tag } });
  });

  return (
    <form className="card body stack-md max-w-[900px]" onSubmit={onSubmit(publish.run)}>
      <h2 className="m-0">Create a release</h2>
      <ErrorNote error={publish.error} />
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-4 max-sm:grid-cols-[minmax(0,1fr)]">
        <Field id="tag" label="Tag" hint={exists ? "Existing tag." : tag ? "A new tag will be created when you publish." : "For example v1.0.0."}>
          <input id="tag" value={tag} onChange={(e) => setTag(e.target.value.trim())} required maxLength={100} list="known-tags" />
        </Field>
        <Field id="target" label="Target branch" hint={exists ? "Not used: the tag already exists." : undefined}>
          <select id="target" value={target} onChange={(e) => setTarget(e.target.value)} disabled={exists}>
            {info.branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </Field>
      </div>
      <datalist id="known-tags">
        {info.tags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Field id="title" label="Release title">
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={tag || undefined} />
      </Field>
      <Field id="notes" label="Release notes" hint="Markdown is supported.">
        <textarea className="min-h-[160px]" id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field id="files" label="Attach files" hint="Binaries or other downloads, up to 500 MB each.">
        <input id="files" type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </Field>
      <label className="radio">
        <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />
        This is a pre-release
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="primary" disabled={publish.pending}>
          Publish release
        </button>
        {progress && (
          <span role="status" className="text-muted">
            {progress}
          </span>
        )}
      </div>
    </form>
  );
}
