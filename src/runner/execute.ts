import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chownWorkspaceArgs, cli, collect, containerRuntime, createArgs, DEFAULT_IMAGE, envScript, execArgs, shellCommand } from "../server/ci-container";
import { LogMasker } from "../server/log-mask";
import { evalTemplate, fillTemplate, holds, toText, type Context, type Status, type Value } from "./expr";
import type { JobAssignment, JobChannel, JobResult, RunningJob, Shell } from "./protocol";
import { parseOutputs } from "./step-output";

// Runs a job from its assignment: a fresh checkout, then its steps, in a container of its own or on the host.
// By default each job runs in a container (see ci-container.ts) and sees nothing of the machine. Everything
// this does on Ether's behalf comes in through the assignment and goes out through the channel.

function command(shell: Shell | null, run: string): string[] {
  const chosen = shell ?? (Bun.which("bash") ? "bash" : process.platform === "win32" ? "cmd" : "sh");
  switch (chosen) {
    case "bash":
      return [Bun.which("bash") ?? "bash", "-e", "-c", run];
    case "sh":
      return ["sh", "-e", "-c", run];
    case "pwsh":
      return ["pwsh", "-NoProfile", "-NonInteractive", "-Command", run];
    case "powershell":
      return ["powershell", "-NoProfile", "-NonInteractive", "-Command", run];
    case "cmd":
      return ["cmd", "/d", "/s", "/c", run];
  }
}

// On the host, only what tools need to work: no ETHER_* settings, auth secret or tokens.
function hostEnv() {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "ProgramFiles"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

const MAX_OUTPUT_FILE = 1024 * 1024;

const removeContainer = (runtime: string, name: string) => Bun.spawn([runtime, "rm", "--force", name], { stdout: "ignore", stderr: "ignore" }).exited;

// A host step runs in its own process group, so stopping it also stops what it started (a `sleep`, a
// test runner's workers), which would otherwise keep running and hold its output open.
function killTree(proc: ReturnType<typeof Bun.spawn>) {
  try {
    if (process.platform !== "win32") return void process.kill(-proc.pid, "SIGKILL");
  } catch {
    // Already gone, or not a group leader (a container CLI): fall through.
  }
  proc.kill();
}

// Containers of this instance's jobs that a crash or restart interrupted; another Ether's on the same daemon stay.
// Async and with timeouts, so a slow or wedged daemon can't hold up a start.
export async function removeLeftoverContainers(instance: string) {
  const runtime = containerRuntime();
  if (!runtime) return;
  const list = await collect(runtime, ["ps", "--all", "--quiet", "--filter", "label=ether.ci=1", "--filter", `label=ether.ci.instance=${instance}`], 30_000);
  const ids = list.code === 0 ? list.output.split(/\s+/).filter(Boolean) : [];
  if (ids.length) await collect(runtime, ["rm", "--force", ...ids], 60_000);
}

// Starts the job and returns at once; `instance` labels its container, so removeLeftoverContainers can find it.
export function startJob(job: JobAssignment, channel: JobChannel, instance: string): RunningJob {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let box: { runtime: string; name: string } | null = null;
  let outputs: Record<string, string> = {};

  // Held in `proc` like a step, so stopping the job ends a clone that's taking long.
  const git = async (args: string[]) => {
    // The token goes in through the environment: not visible in `ps`, and not left in the checkout's config.
    const auth = job.checkout.authorization ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${job.checkout.authorization}` } : {};
    const running = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore", detached: process.platform !== "win32", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth } });
    proc = running;
    const timer = setTimeout(() => killTree(running), 10 * 60_000);
    const output = await new Response(running.stderr as ReadableStream<Uint8Array>).text();
    const code = await running.exited;
    clearTimeout(timer);
    proc = null;
    return { code, output };
  };

  const execute = async (): Promise<JobResult> => {
    const append = channel.log;
    const fail = (message: string): JobResult => {
      append(`${message}\n`);
      return "error";
    };
    // Everything that goes into the log passes a masker, step names (often the command itself) included.
    const masked = (text: string) => {
      const m = new LogMasker(job.mask);
      return m.push(text) + m.flush();
    };
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), "ether-ci-"));
      const clone = await git(["clone", "--quiet", "--no-checkout", job.checkout.url, dir]);
      const checkout = clone.code === 0 && !stopped ? await git(["-C", dir, "checkout", "--quiet", "--detach", job.checkout.sha]) : clone;
      // Nothing more to do for a job stopped by now, least of all pulling an image for it.
      if (stopped) return "cancelled";
      if (checkout.code !== 0) return fail(`Could not check out ${job.checkout.sha}: ${checkout.output}`);

      if (job.isolation === "container") {
        const runtime = containerRuntime();
        if (!runtime) return fail("No container runtime found: install Docker or Podman on the machine that runs this job, or let it run jobs on the host (unsafe).");
        const image = job.image ?? DEFAULT_IMAGE;
        box = { runtime, name: `ether-ci-${job.runId}-${job.jobId}-${randomBytes(4).toString("hex")}` };
        append(`▶ Starting ${image} with ${basename(runtime)}\n`);
        // Creating pulls the image when it isn't there yet, which can take a while.
        if ((await cli(runtime, createArgs(box.name, image, instance), append, 15 * 60_000)) !== 0) return fail(`✖ Could not create a container from ${image}`);
        if ((await cli(runtime, ["cp", `${dir}/.`, `${box.name}:/workspace`], append, 10 * 60_000)) !== 0) return fail("✖ Could not copy the checkout into the container");
        if ((await cli(runtime, ["start", box.name], append, 60_000)) !== 0) return fail("✖ Could not start the container");
        // `cp` leaves the checkout owned by root; an image that runs as another user needs it to be theirs.
        // The image decides what `sh` and `id` do here, so this runs like every other call: async and with a timeout.
        const who = await collect(runtime, ["exec", box.name, "sh", "-c", 'echo "$(id -u):$(id -g)"'], 30_000);
        // stdout and stderr arrive together, so pick out the uid:gid line.
        const owner = who.code === 0 ? (/^(\d+:\d+)$/m.exec(who.output)?.[1] ?? null) : null;
        if (owner && owner !== "0:0" && (await cli(runtime, chownWorkspaceArgs(box.name, owner), append, 5 * 60_000)) !== 0)
          append(`Could not hand /workspace to the image's user ${owner}; steps may not be able to write to it\n`);
        append("\n");
      }

      let result: JobResult = "success";
      // Whether a step that counts has failed, which is what success() and failure() look at.
      let failed = false;
      const steps: { [id: string]: Value } = {};
      const status = (): Status => ({ success: !failed, failure: failed, cancelled: false });
      const context = (env: Record<string, string>): Context => ({ ...job.context, steps, env });
      const failStep = (id: string | null) => {
        failed = true;
        result = "failure";
        if (id) steps[id] = { outcome: "failure", conclusion: "failure", outputs: {} };
      };
      for (const [index, step] of job.steps.entries()) {
        if (stopped) break;
        let name: string;
        let script: string;
        const env: Record<string, string> = {};
        try {
          for (const [key, value] of Object.entries(step.env)) env[key] = toText(evalTemplate(value, context(env), status()));
          name = fillTemplate(step.name, context(env), status());
          if (!holds(step.if, context(env), status())) {
            append(masked(`⊘ ${name} (skipped)\n\n`));
            if (step.id) steps[step.id] = { outcome: "skipped", conclusion: "skipped", outputs: {} };
            continue;
          }
          script = fillTemplate(step.run, context(env), status());
        } catch (e) {
          append(masked(`✖ ${step.name}: ${(e as Error).message}\n\n`));
          failStep(step.id);
          continue;
        }
        append(masked(`▶ ${name}\n`));
        const started = Date.now();
        // Steps write their outputs to this file, a fresh one each.
        const outputFile = box ? `/tmp/ether-ci-output-${index}` : join(dir, `.ether-ci-output-${randomBytes(6).toString("hex")}`);
        const vars = { ...job.vars, ...env, CI_OUTPUT: outputFile };
        let running: ReturnType<typeof Bun.spawn>;
        try {
          if (box) {
            // The job's variables go in on stdin; the CLI keeps Ether's own environment.
            const variables = envScript(vars);
            const exec = Bun.spawn([box.runtime, ...execArgs(box.name, shellCommand(step.shell, script))], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
            exec.stdin.write(variables);
            await exec.stdin.end();
            running = exec;
          } else
            running = Bun.spawn(command(step.shell, script), {
              cwd: dir,
              env: { ...hostEnv(), ...vars },
              stdout: "pipe",
              stderr: "pipe",
              stdin: "ignore",
              detached: process.platform !== "win32",
            });
        } catch (e) {
          return fail(masked(`✖ ${name}: ${(e as Error).message}`));
        }
        proc = running;
        const timer = setTimeout(() => {
          append(`\n✖ Timed out after ${step.timeoutMinutes} minutes\n`);
          killTree(running);
        }, step.timeoutMinutes * 60_000);
        // One masker and decoder per stream, so a secret or a character split across chunks stays whole.
        const forward = async (s: ReadableStream<Uint8Array>) => {
          const decoder = new TextDecoder();
          const mask = new LogMasker(job.mask);
          for await (const chunk of s) append(mask.push(decoder.decode(chunk, { stream: true })));
          append(mask.flush());
        };
        await Promise.all([forward(running.stdout as ReadableStream<Uint8Array>), forward(running.stderr as ReadableStream<Uint8Array>)]);
        const code = await running.exited;
        clearTimeout(timer);
        proc = null;
        append(masked(`${code === 0 ? "✔" : "✖"} ${name} (exit ${code}, ${((Date.now() - started) / 1000).toFixed(1)}s)\n\n`));
        // The file belongs to the step's own user and may be anything a step wrote, so it's read like any other output.
        let written = "";
        if (box) {
          const read = await collect(box.runtime, ["exec", box.name, "sh", "-c", `cat ${outputFile} 2>/dev/null; rm -f ${outputFile}`], 30_000, MAX_OUTPUT_FILE);
          if (read.code === 0) written = read.output;
        } else if (existsSync(outputFile)) {
          written = readFileSync(outputFile, "utf8").slice(0, MAX_OUTPUT_FILE);
          rmSync(outputFile, { force: true });
        }
        const outcome = code === 0 ? "success" : "failure";
        if (step.id) steps[step.id] = { outcome, conclusion: code === 0 || step.continueOnError ? "success" : "failure", outputs: parseOutputs(written) };
        if (code !== 0 && !step.continueOnError) {
          failed = true;
          result = "failure";
        }
      }
      for (const [key, value] of Object.entries(job.outputs)) {
        try {
          outputs[key] = fillTemplate(value, context({}), status());
        } catch (e) {
          append(masked(`Output ${key}: ${(e as Error).message}\n`));
        }
      }
      return result;
    } catch (e) {
      append(`\nRunner error: ${(e as Error).message}\n`);
      return "error";
    } finally {
      if (box) await removeContainer(box.runtime, box.name);
      box = null;
      try {
        if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A leftover temp dir shouldn't change how the job went.
      }
    }
  };

  return {
    done: execute().then((result) => (stopped ? "cancelled" : result)),
    outputs: () => outputs,
    stop() {
      stopped = true;
      if (proc) killTree(proc);
      // Killing the CLI doesn't stop what it started inside the container.
      if (box) void removeContainer(box.runtime, box.name);
    },
  };
}
