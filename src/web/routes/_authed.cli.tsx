import { Link, createFileRoute } from "@tanstack/react-router";
import { Download, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyButton } from "../components/ui";
import { api } from "../lib/api";

type Binary = { platform: string; os: string; arch: string; file: string; size: number; sha256: string };
type Manifest = { version: string | null; binaries: Binary[]; server: string };

export const Route = createFileRoute("/_authed/cli")({
  loader: () => api<Manifest>("/api/cli"),
  component: CliPage,
});

// The visitor's platform as well as the browser lets on: Chromium tells the architecture when asked; elsewhere a
// Mac is taken to be Apple silicon and anything else x86-64.
function useDetectedPlatform() {
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    const ua = navigator.userAgent;
    const os = /Mac/.test(ua) ? "darwin" : /Win/.test(ua) ? "windows" : /Linux|X11/.test(ua) ? "linux" : null;
    if (!os) return;
    setPlatform(`${os}-${os === "darwin" ? "arm64" : "x64"}`);
    const hints = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string }> } }).userAgentData;
    hints
      ?.getHighEntropyValues(["architecture"])
      .then(({ architecture }) => setPlatform(`${os}-${architecture === "arm" ? "arm64" : architecture === "x86" ? "x64" : os === "darwin" ? "arm64" : "x64"}`))
      .catch(() => {});
  }, []);
  return platform;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <pre className="m-0 min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-surface-3 px-3 py-2 text-sm" aria-label={label}>
        <code>{text}</code>
      </pre>
      <CopyButton text={text} />
    </div>
  );
}

function CliPage() {
  const { version, binaries, server } = Route.useLoaderData();
  const detected = useDetectedPlatform();
  const mine = binaries.find((b) => b.platform === detected) ?? null;
  const unix = binaries.some((b) => !b.platform.startsWith("windows"));
  const windows = binaries.some((b) => b.platform.startsWith("windows"));
  const showWindowsFirst = detected?.startsWith("windows") ?? false;

  return (
    <main className="page stack max-w-[820px]">
      <h1 className="flex items-center gap-2">
        <Terminal aria-hidden /> Command-line client
      </h1>
      <p className="m-0 text-muted">
        <code>ether</code> works with this server from your terminal: repositories, issues, pull requests with reviews, checks and merges, and any API call.
        {version && <> Version {version}.</>}
      </p>

      {binaries.length === 0 ? (
        <p className="notice" role="status">
          This server doesn't offer the client for download yet. An admin can add it with <code>bun run build:cli</code>; until then it can be built from{" "}
          <code>cli/</code> with <code>cargo build --release</code>.
        </p>
      ) : (
        <>
          <section className="card body stack-sm" aria-label="Install">
            <h2 className="m-0">Install</h2>
            {showWindowsFirst && windows && <Command label="Install on Windows" text={`irm ${server}/install.ps1 | iex`} />}
            {unix && <Command label="Install on macOS or Linux" text={`curl -fsSL ${server}/install.sh | sh`} />}
            {!showWindowsFirst && windows && <Command label="Install on Windows" text={`irm ${server}/install.ps1 | iex`} />}
            <p className="hint m-0">The installer checks the download's SHA-256 and puts ether in ~/.local/bin (on Windows, %LOCALAPPDATA%\Programs\ether).</p>
            {mine && (
              <a className="button primary self-start" href={`/api/cli/download/${mine.file}`} download>
                <Download size={16} aria-hidden /> Download for {mine.os} ({mine.arch})
              </a>
            )}
          </section>

          <section className="card body stack-sm" aria-label="Log in">
            <h2 className="m-0">Log in</h2>
            <p className="m-0">
              Create a token under <Link to="/settings">Settings → Access tokens</Link>, then:
            </p>
            <Command label="Login command" text={`echo "$TOKEN" | ether auth login --host ${server} --with-token`} />
            <p className="m-0">Tab completion for your shell:</p>
            <Command label="Completions" text="ether completion zsh > ~/.zfunc/_ether   # or bash, fish, powershell" />
          </section>

          <section className="card" aria-label="All downloads">
            <header>
              <h2 className="m-0 text-base">All downloads</h2>
            </header>
            <ul className="list">
              {binaries.map((b) => (
                <li key={b.platform} className="flex-wrap">
                  <a href={`/api/cli/download/${b.file}`} download className="font-semibold">
                    {b.os} ({b.arch})
                  </a>
                  <span className="text-muted">{mb(b.size)}</span>
                  <span className="flex-1" />
                  <code className="text-xs text-muted wrap-anywhere" title="SHA-256">
                    {b.sha256}
                  </code>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
