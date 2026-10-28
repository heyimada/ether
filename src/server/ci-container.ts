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

// Where a step's variables are copied into the container. They never go through the CLI's own
// environment, where a job could set DOCKER_HOST, LD_PRELOAD and the like for the host's CLI, nor
// onto a command line, where `ps` would show them.
export const STEP_ENV_PATH = "/tmp/.ether-step-env";

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// A file sh can source to export the variables; values may span lines and contain anything but NUL.
export function envScript(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" isn't a valid variable name`);
      if (value.includes("\0")) throw new Error(`${name} contains a NUL character, which environment variables can't hold`);
      return `export ${name}=${shellQuote(value)}\n`;
    })
    .join("");
}

// Runs `command` in the container after loading (and deleting) the step's variables.
export const execArgs = (container: string, command: string[]) => [
  "exec",
  "--workdir",
  "/workspace",
  container,
  "sh",
  "-c",
  `. ${STEP_ENV_PATH} && rm -f ${STEP_ENV_PATH} && exec "$@"`,
  "sh",
  ...command,
];
