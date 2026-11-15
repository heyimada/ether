import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { del, post, timeAgo } from "../lib/api";
import { CopyButton, ErrorNote, useAction } from "./ui";

export type RunnerInfo = { id: number; name: string; isolation: "container" | "host"; labels: string[]; scope: "server" | "organization" | "repository"; online: boolean; lastSeenAt: string | null };

// Machines that run CI jobs, for the whole server, an organization or a repository, depending on `base`.
export function Runners({ base, runners, empty, filled }: { base: string; runners: RunnerInfo[]; empty: string; filled: string }) {
  const router = useRouter();
  const [command, setCommand] = useState<string | null>(null);
  const add = useAction(async () => {
    const { token } = await post<{ token: string }>(`${base}/runners/registration`);
    setCommand(`ether-runner register --url ${location.origin} --token ${token}`);
  });
  const remove = useAction(async (id: number) => {
    await del(`${base}/runners/${id}`);
    await router.invalidate();
  });
  return (
    <section className="card" aria-label="Runners">
      <header>
        <h2 className="m-0">Runners</h2>
        <span className="flex-1" />
        <button onClick={() => add.run()} disabled={add.pending}>
          Add runner
        </button>
      </header>
      <div className="body">
        <p className="mt-0 text-muted">{runners.length ? filled : empty}</p>
        <ErrorNote error={add.error ?? remove.error} />
        {command && (
          <div className="notice mb-3">
            <p className="mt-0">Run this on the other machine, then start it with ether-runner run. The token works once and expires in an hour. Add --labels to name what workflows can ask for with runs-on.</p>
            <div className="flex items-center gap-2">
              <code aria-label="Runner registration command" className="wrap-anywhere">
                {command}
              </code>
              <CopyButton text={command} />
            </div>
          </div>
        )}
        {runners.length > 0 && (
          <ul className="list" aria-label="Registered runners">
            {runners.map((r) => (
              <li key={r.id}>
                <span className="font-mono">{r.name}</span>
                <span className="pill">{r.online ? "Online" : "Offline"}</span>
                {r.labels.map((l) => (
                  <span key={l} className="pill font-mono">
                    {l}
                  </span>
                ))}
                <span className="flex-1" />
                <span className="text-muted">
                  {r.scope !== "server" && `${r.scope} · `}
                  {r.isolation === "host" ? "on its host" : "in containers"}
                  {r.lastSeenAt ? ` · seen ${timeAgo(r.lastSeenAt)}` : " · not seen yet"}
                </span>
                <button aria-label={`Remove runner ${r.name}`} onClick={() => remove.run(r.id)} disabled={remove.pending}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
