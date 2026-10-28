// How CI jobs run in a container (Docker or Podman, which take the same arguments): one container per
// job, the checkout copied in rather than mounted, so a job sees nothing of the host's files.

export const DEFAULT_IMAGE = process.env.ETHER_CI_IMAGE || "oven/bun:1";
const MEMORY = process.env.ETHER_CI_MEMORY || "4g";
const CPUS = process.env.ETHER_CI_CPUS || "2";
const PIDS = process.env.ETHER_CI_PIDS || "1024";

// Registry, path, tag and digest characters only; never a leading "-" that the CLI would read as a flag.
export const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;

// The CLI to drive, or null when neither Docker nor Podman is installed. ETHER_CI_RUNTIME picks one explicitly.
export function containerRuntime(): string | null {
  const wanted = process.env.ETHER_CI_RUNTIME;
  if (wanted) return Bun.which(wanted);
  return Bun.which("docker") ?? Bun.which("podman");
}

// A container that idles until the job's steps are exec'd into it and is removed afterwards.
// The default capability set stays (package managers need it), minus raw sockets; setuid binaries
// can't gain privileges; memory, CPU and process count are capped.
export function createArgs(name: string, image: string): string[] {
  if (!IMAGE_RE.test(image)) throw new Error(`"${image}" is not a valid image name`);
  return [
    "create",
    "--name",
    name,
    "--label",
    "ether.ci=1",
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

// Variables are passed by name only: the CLI copies each value from its own environment, so values
// (secrets included) never appear on a command line, in `ps` or in a file, and may span lines.
export const execArgs = (container: string, envNames: string[], command: string[]) => ["exec", "--workdir", "/workspace", ...envNames.flatMap((n) => ["--env", n]), container, ...command];
