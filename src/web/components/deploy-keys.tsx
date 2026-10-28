import { useRouter } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { del, post, timeAgo } from "../lib/api";
import { ErrorNote, Field, onSubmit, useAction } from "./ui";

export type DeployKey = { id: number; title: string; keyType: string; fingerprint: string; readOnly: boolean; createdAt: string; lastUsedAt: string | null };

export function DeployKeys({ base, keys, sshBase }: { base: string; keys: DeployKey[]; sshBase: string | null }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [write, setWrite] = useState(false);
  const add = useAction(async () => {
    await post(`${base}/deploy-keys`, { title, key, write });
    setTitle("");
    setKey("");
    setWrite(false);
    await router.invalidate();
  });
  const remove = useAction(async (id: number) => {
    await del(`${base}/deploy-keys/${id}`);
    await router.invalidate();
  });
  return (
    <section className="card">
      <header>
        <h2 style={{ margin: 0 }}>Deploy keys</h2>
      </header>
      <div className="body stack-md">
        <p className="muted" style={{ margin: 0 }}>
          A deploy key gives a server or a CI system git over SSH access to this repository only, without an account.
          {!sshBase && " Git over SSH is turned off on this server, so deploy keys won't work until an admin turns it on."}
        </p>
        <ErrorNote error={remove.error} />
        {keys.length > 0 && (
          <ul className="list card" aria-label="Deploy keys">
            {keys.map((k) => (
              <li key={k.id}>
                <KeyRound size={18} aria-hidden className="muted" />
                <div style={{ minWidth: 0 }}>
                  <strong>{k.title}</strong> <span className="badge">{k.readOnly ? "read" : "read and write"}</span>
                  <div className="mono muted" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                    {k.fingerprint}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Added {timeAgo(k.createdAt)} · {k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                <span className="spacer" />
                <button className="danger small" aria-label={`Remove ${k.title}`} onClick={() => remove.run(k.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="stack-sm" onSubmit={onSubmit(add.run)}>
          <ErrorNote error={add.error} />
          <Field id="deploy-title" label="Deploy key title" hint="For example the server that uses it.">
            <input id="deploy-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
          </Field>
          <Field id="deploy-key" label="Deploy public key" hint="The contents of a .pub file. Use a key made for this repository, not your personal one.">
            <textarea id="deploy-key" className="mono" value={key} onChange={(e) => setKey(e.target.value)} required style={{ minHeight: 80 }} placeholder="ssh-ed25519 AAAA… deploy@server" />
          </Field>
          <label className="radio">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
            Allow write access (it can push to any branch that protection rules allow)
          </label>
          <div>
            <button disabled={add.pending}>Add deploy key</button>
          </div>
        </form>
      </div>
    </section>
  );
}
