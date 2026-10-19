import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { LabelPill } from "../components/labels";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { api, del, post, repoApi, type Label } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/labels")({
  loader: ({ context: { info } }) => api<{ labels: Label[] }>(`${repoApi(info.repo.owner, info.repo.name)}/labels`),
  component: Labels,
});

const SUGGESTED = ["#d73a4a", "#0075ca", "#a2eeef", "#7057ff", "#008672", "#e4e669", "#d876e3", "#fbca04"];

function Labels() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const { labels } = Route.useLoaderData();
  const base = `${repoApi(info.repo.owner, info.repo.name)}/labels`;
  const canEdit = info.role !== "read";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(SUGGESTED[labels.length % SUGGESTED.length]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const create = useAction(async () => {
    await post(base, { name, description, color });
    setName("");
    setDescription("");
    await router.invalidate();
  });
  const remove = useAction(async (label: string) => {
    await del(`${base}/${encodeURIComponent(label)}`);
    setConfirm(null);
    await router.invalidate();
  });

  return (
    <div className="stack-md" style={{ maxWidth: 900 }}>
      <section className="card">
        <header>
          <h2 style={{ margin: 0 }}>Labels</h2>
          <span className="muted num">{labels.length}</span>
        </header>
        <ErrorNote error={remove.error} />
        <ul className="list" aria-label="Labels">
          {labels.map((l) => (
            <li key={l.name}>
              <LabelPill label={l} info={info} />
              <span className="muted" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {l.description}
              </span>
              <span className="spacer" />
              {canEdit &&
                (confirm === l.name ? (
                  <>
                    <span className="muted">Remove from every issue?</span>
                    <button className="danger small" onClick={() => remove.run(l.name)}>
                      Delete
                    </button>
                    <button className="small" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="danger small" onClick={() => setConfirm(l.name)}>
                    Delete
                  </button>
                ))}
            </li>
          ))}
        </ul>
      </section>
      {canEdit && (
        <form className="card body stack-sm" onSubmit={onSubmit(create.run)}>
          <h2 style={{ margin: 0 }}>New label</h2>
          <ErrorNote error={create.error} />
          <div className="form-grid">
            <Field id="label-name" label="Label name">
              <input id="label-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} />
            </Field>
            <Field id="label-description" label="Description">
              <input id="label-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={100} />
            </Field>
          </div>
          <div className="accent-row">
            <label htmlFor="label-color" style={{ margin: 0 }}>
              Colour
            </label>
            <input id="label-color" type="color" className="accent-input" value={color} onChange={(e) => setColor(e.target.value)} />
            {name && <LabelPill label={{ name, color, description }} />}
          </div>
          <div>
            <button className="primary" disabled={create.pending}>
              Create label
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
