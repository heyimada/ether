import { useRouter } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { api, del, post, timeAgo } from "../lib/api";
import { ErrorNote, Field, onSubmit, useAction } from "./ui";

export type SshKey = { id: number; title: string; keyType: string; fingerprint: string; createdAt: string; lastUsedAt: string | null };

export const loadSshKeys = () => api<{ keys: SshKey[] }>("/api/me/ssh-keys").then((r) => r.keys);

export function SshKeys({ keys, sshBase }: { keys: SshKey[]; sshBase: string | null }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const add = useAction(async () => {
    await post("/api/me/ssh-keys", { title, key });
    setTitle("");
    setKey("");
    await router.invalidate();
  });
  const remove = useAction(async (id: number) => {
    await del(`/api/me/ssh-keys/${id}`);
    await router.invalidate();
  });
  return (
    <section className="card">
      <header>
        <h2 style={{ margin: 0 }}>SSH keys</h2>
      </header>
      <div className="body stack-md">
        <p className="muted" style={{ margin: 0 }}>
          {sshBase ? (
            <>
              Use git over SSH with these keys, for example <code>git clone {sshBase}/owner/repo.git</code>.
            </>
          ) : (
            "Git over SSH is turned off on this server; your keys will work once an admin turns it on."
          )}
        </p>
        <ErrorNote error={remove.error} />
        {keys.length > 0 && (
          <ul className="list card" aria-label="SSH keys">
            {keys.map((k) => (
              <li key={k.id}>
                <KeyRound size={18} aria-hidden className="muted" />
                <div style={{ minWidth: 0 }}>
                  <strong>{k.title}</strong>
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
          <Field id="ssh-title" label="Key title" hint="For example the machine it's on.">
            <input id="ssh-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
          </Field>
          <Field id="ssh-key" label="Public key" hint="The contents of a .pub file, such as ~/.ssh/id_ed25519.pub. Never paste a private key.">
            <textarea id="ssh-key" className="mono" value={key} onChange={(e) => setKey(e.target.value)} required style={{ minHeight: 80 }} placeholder="ssh-ed25519 AAAA… you@laptop" />
          </Field>
          <div>
            <button disabled={add.pending}>Add SSH key</button>
          </div>
        </form>
      </div>
    </section>
  );
}
