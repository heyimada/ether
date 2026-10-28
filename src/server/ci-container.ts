// How CI jobs run in a container (Docker or Podman, which take the same arguments): one container per
// job, the checkout copied in rather than mounted, so a job sees nothing of the host's files.

export const DEFAULT_IMAGE = process.env.ETHER_CI_IMAGE || "oven/bun:1";
const MEMORY = process.env.ETHER_CI_MEMORY || "4g";
const CPUS = process.env.ETHER_CI_CPUS || "2";
const PIDS = process.env.ETHER_CI_PIDS || "1024";

// Registry, path, tag and digest characters only; never a leading "-" that the CLI would read as a flag.
export const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;

// Tells this server's containers apart from another Ether's on the same daemon (staging and production on
// one host, two data folders): a hash of the data folder's path, which is the same across restarts.
export const instanceLabel = (dataDir: string) => new Bun.CryptoHasher("sha256").update(dataDir).digest("hex").slice(0, 16);

// The CLI to drive, or null when neither Docker nor Podman is installed. ETHER_CI_RUNTIME picks one explicitly.
export function containerRuntime(): string | null {
  const wanted = process.env.ETHER_CI_RUNTIME;
  if (wanted) return Bun.which(wanted);
  return Bun.which("docker") ?? Bun.which("podman");
}

// A container that idles until the job's steps are exec'd into it and is removed afterwards.
// The default capability set stays (package managers need it), minus raw sockets; setuid binaries
// can't gain privileges; memory, CPU and process count are capped.
// Labels every container with the server that made it (see instanceLabel), so a restart cleans up only its own.
export function createArgs(name: string, image: string, instance: string): string[] {
  if (!IMAGE_RE.test(image)) throw new Error(`"${image}" is not a valid image name`);
  return [
    "create",
    "--name",
    name,
    "--label",
    "ether.ci=1",
    "--label",
    `ether.ci.instance=${instance}`,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "NET_RAW",
    "--memory",
    MEMORY,
    "--cpus",
    CPUS,
    "--pids-limit",
    PIDS,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "tail",
    image,
    "-f",
    "/dev/null",
  ];
}

// The shell command for one step inside the container. Without a shell, bash when the image has it, else sh.
export function shellCommand(shell: string | null, run: string): string[] {
  switch (shell) {
    case null:
      return ["sh", "-c", 'if command -v bash >/dev/null 2>&1; then exec bash -e -c "$1"; else exec sh -e -c "$1"; fi', "sh", run];
    case "bash":
      return ["bash", "-e", "-c", run];
    case "sh":
      return ["sh", "-e", "-c", run];
    case "pwsh":
      return ["pwsh", "-NoProfile", "-NonInteractive", "-Command", run];
    default:
      throw new Error(`shell "${shell}" isn't available in a container; use sh, bash or pwsh`);
  }
}

// A step's variables reach the container on the exec's stdin, as a script sh evaluates before running the
// step. They never go through the CLI's own environment, where a job could set DOCKER_HOST, LD_PRELOAD and
// the like for the host's CLI, nor onto a command line (`ps`) or into a file, whose owner would have to
// match the image's user.

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// A script sh can evaluate to export the variables; values may span lines and contain anything but NUL.
export function envScript(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" isn't a valid variable name`);
      if (value.includes("\0")) throw new Error(`${name} contains a NUL character, which environment variables can't hold`);
      return `export ${name}=${shellQuote(value)}\n`;
    })
    .join("");
}

// Runs `command` in the container after evaluating the variables script written to stdin; the step itself
// gets an empty stdin, as on the host.
export const execArgs = (container: string, command: string[]) => [
  "exec",
  "--interactive",
  "--workdir",
  "/workspace",
  container,
  "sh",
  "-c",
  'eval "$(cat)" && exec "$@" </dev/null',
  "sh",
  ...command,
];

// Hands the copied checkout (root-owned after `cp`) to the user the image runs as, so steps can write to it.
export const chownWorkspaceArgs = (container: string, owner: string) => ["exec", "--user", "0", container, "chown", "-R", owner, "/workspace"];

// A container CLI call whose output goes to `append` (the job's log); resolves with its exit code. Never
// blocks the event loop, always drains both pipes (a chatty image can't stall it) and is killed after `timeoutMs`.
export async function cli(runtime: string, args: string[], append: (s: string) => void, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn([runtime, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of s) append(decoder.decode(chunk, { stream: true }));
  };
  try {
    await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

// Like cli, but keeps the first `max` characters of the output for the caller instead of logging it.
export async function collect(runtime: string, args: string[], timeoutMs: number, max = 64 * 1024): Promise<{ code: number; output: string }> {
  let output = "";
  const code = await cli(runtime, args, (s) => (output.length < max ? (output += s.slice(0, max - output.length)) : undefined), timeoutMs);
  return { code, output };
}
