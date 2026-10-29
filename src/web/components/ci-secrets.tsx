import { useRouter } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { del, put, timeAgo } from "../lib/api";
import { ErrorNote, Field, onSubmit, useAction } from "./ui";

export type CiSecret = { name: string; updatedAt: string; updatedBy: string | null };

// The repository's secrets by default; with `endpoint` and `title`, an environment's.
export function CiSecrets({
  base,
  secrets,
  isolation,
  endpoint = `${base}/ci/secrets`,
  title = "CI secrets",
  intro,
}: {
  base: string;
  secrets: CiSecret[];
  isolation: "container" | "host";
  endpoint?: string;
  title?: string;
  intro?: ReactNode;
}) {
  const router = useRouter();
  const uid = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const save = useAction(async () => {
    await put(`${endpoint}/${encodeURIComponent(name)}`, { value });
    setName("");
    setValue("");
    await router.invalidate();
  });
  const remove = useAction(async (secret: string) => {
    await del(`${endpoint}/${encodeURIComponent(secret)}`);
    await router.invalidate();
  });
  return (
    <section className="card">
      <header>
        <h2 className="m-0">{title}</h2>
      </header>
      <div className="body stack-md">
        {intro ?? (
          <p className="text-muted m-0">
            Use them in a workflow as <code>{"env: { DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }} }"}</code> on a job or step. Values are encrypted on the
            server, never shown again, and masked in logs. Anyone who can push here can still read them through a workflow, so only add what everyone with write
            access may know.
          </p>
        )}
        {isolation === "host" && (
          <p className="notice m-0">
            CI on this server runs on the host, so jobs that use secrets are refused until an admin switches CI to containers.
          </p>
        )}
        <ErrorNote error={remove.error} />
        {secrets.length > 0 && (
          <ul className="list card" aria-label={title}>
            {secrets.map((s) => (
              <li key={s.name}>
                <LockKeyhole size={18} aria-hidden className="text-muted" />
                <div className="min-w-0">
                  <strong className="font-mono">{s.name}</strong>
                  <div className="text-muted text-xs">
                    Updated {timeAgo(s.updatedAt)}
                    {s.updatedBy ? ` by ${s.updatedBy}` : ""}
                  </div>
                </div>
                <span className="flex-1" />
                <button className="small" onClick={() => setName(s.name)} aria-label={`Replace ${s.name}`}>
                  Replace
                </button>
                <button className="danger small" onClick={() => remove.run(s.name)} aria-label={`Remove ${s.name}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="stack-sm" onSubmit={onSubmit(save.run)}>
          <ErrorNote error={save.error} />
          <Field id={`${uid}-name`} label="Secret name" hint="Upper-case letters, digits and _, for example DEPLOY_KEY. Saving an existing name replaces its value.">
            <input id={`${uid}-name`} className="font-mono" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} required maxLength={64} pattern="[A-Z_][A-Z0-9_]*" />
          </Field>
          <Field id={`${uid}-value`} label="Secret value" hint="Up to 64 KB. Several lines are fine, for example a private key.">
            <textarea id={`${uid}-value`} className="font-mono min-h-[80px]" value={value} onChange={(e) => setValue(e.target.value)} required autoComplete="off" spellCheck={false} />
          </Field>
          <div>
            <button disabled={save.pending}>Save secret</button>
          </div>
        </form>
      </div>
    </section>
  );
}
