#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { instanceLabel } from "../server/ci-container";
import { removeLeftoverContainers, startJob } from "./execute";
import type { Claim, Isolation, JobResult, Progress, RunningJob } from "./protocol";

// ether-runner: runs an Ether server's CI jobs on another machine. It only ever calls the server, so the
// machine needs no open port. Secrets come with each job and stay in memory.

type Config = { url: string; id: number; token: string; name: string; isolation: Isolation };

const USAGE = `Usage:
  ether-runner register --url <server> --token <registration token> [--name <name>] [--isolation container|host] [--config <file>]
  ether-runner run [--jobs <n>] [--config <file>]

--isolation host runs jobs directly on this machine as this user, which gives whoever can push to a
repository on the server this machine. The default is a container per job, with Docker or Podman.`;

const IDLE_MS = 2000;
const REPORT_MS = 1000;
const HEARTBEAT_MS = Math.max(1000, Number(process.env.ETHER_RUNNER_HEARTBEAT_MS) || 15_000);
const MAX_REPORT = 200 * 1024;
// More than the server keeps of a log, so a very chatty job can't fill this machine's memory.
const MAX_BUFFER = 4 * 1024 * 1024;

const die = (message: string): never => {
  console.error(`ether-runner: ${message}`);
  process.exit(1);
};

const defaultConfig = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ether-runner", "config.json");

const call = (url: string, path: string, token: string | null, body: unknown) =>
  fetch(new URL(`/api${path}`, url), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function register(values: { url?: string; token?: string; name?: string; isolation?: string; config?: string }) {
  if (!values.url || !values.token) die(`--url and --token are required\n\n${USAGE}`);
  const url = new URL(values.url!).origin;
  const { protocol, hostname: host } = new URL(url);
  // Jobs bring their secrets with them.
  if (protocol !== "https:" && host !== "localhost" && host !== "127.0.0.1") console.error(`Warning: ${url} isn't HTTPS, so job secrets and tokens would cross the network unencrypted.`);
  const isolation = (values.isolation ?? "container") as Isolation;
  const name = values.name ?? hostname().split(".")[0];
  const res = await call(url, "/runner/register", null, { token: values.token, name, isolation });
  const data = (await res.json().catch(() => ({}))) as { id?: number; token?: string; error?: string };
  if (!res.ok || !data.token) die(data.error ?? `The server answered ${res.status}`);
  const file = values.config ?? defaultConfig();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const config: Config = { url, id: data.id!, token: data.token!, name, isolation };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Registered ${name} with ${url}. Start it with: ether-runner run${values.config ? ` --config ${values.config}` : ""}`);
}

// Runs one job: streams its log, listens for "stop" in the answers, and says how it ended.
async function work(config: Config, claim: Claim, instance: string, running: Set<RunningJob>) {
  const { assignment, token } = claim;
  const { jobId } = assignment;
  console.log(`Job ${jobId} (run ${assignment.runId}) started`);
  let buffer = "";
  const job = startJob({ ...assignment, checkout: { ...assignment.checkout, url: new URL(assignment.checkout.url, config.url).href } }, { log: (t) => void (buffer.length < MAX_BUFFER && (buffer += t)) }, instance);
  running.add(job);
  let finished = false;
  const done = job.done.then(
    (r) => ((finished = true), r),
    (e): JobResult => {
      finished = true;
      buffer += `\nRunner error: ${(e as Error).message}\n`;
      return "error";
    },
  );

  // Sends what's buffered. A network hiccup keeps it for the next try; the server ends the job if that goes on too long.
  let gone = false;
  let reported = 0;
  const report = async () => {
    const text = buffer.slice(0, MAX_REPORT);
    try {
      const res = await call(config.url, `/runner/jobs/${jobId}/report`, token, { text });
      if (res.status === 404 || res.status === 401) gone = true;
      if (!res.ok) return false;
      buffer = buffer.slice(text.length);
      reported = Date.now();
      if (((await res.json()) as Progress).stop) job.stop();
      return true;
    } catch {
      return false;
    }
  };

  while (!finished) {
    await Promise.race([done, Bun.sleep(REPORT_MS)]);
    if (finished) break;
    if (buffer || Date.now() - reported >= HEARTBEAT_MS) await report();
    // The server has given up on this job: finished elsewhere, restarted, or this runner was removed.
    if (gone) job.stop();
  }
  const result = await done;
  running.delete(job);

  // The rest of the log and the result, retried for a while; past that the server has ended the job anyway.
  for (let attempt = 0; attempt < 60 && !gone; attempt++) {
    if (buffer && !(await report())) {
      await Bun.sleep(5000);
      continue;
    }
    if (buffer) continue;
    const res = await call(config.url, `/runner/jobs/${jobId}/finish`, token, { result }).catch(() => null);
    if (res && (res.ok || res.status === 404)) break;
    await Bun.sleep(5000);
  }
  console.log(`Job ${jobId} ended: ${result}`);
}

async function run(values: { jobs?: string; config?: string }) {
  const file = values.config ?? defaultConfig();
  if (!existsSync(file)) die(`${file} doesn't exist; run ether-runner register first`);
  const config = JSON.parse(readFileSync(file, "utf8")) as Config;
  const slots = Math.max(1, Math.floor(Number(values.jobs) || 1));
  const instance = instanceLabel(`runner:${config.url}:${config.id}`);
  await removeLeftoverContainers(instance).catch((e) => console.error("Removing leftover containers failed:", e));
  const running = new Set<RunningJob>();
  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("Stopping; ending running jobs");
    for (const job of running) job.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(`${config.name} is waiting for jobs from ${config.url} (${slots} at a time, ${config.isolation === "host" ? "on this machine" : "in containers"})`);

  const slot = async () => {
    let offline = false;
    while (!stopping) {
      let res: Response | null = null;
      try {
        res = await call(config.url, "/runner/claim", config.token, { isolation: config.isolation });
        if (offline) console.log("Back in touch with the server");
        offline = false;
      } catch (e) {
        if (!offline) console.error(`Can't reach the server: ${(e as Error).message}`);
        offline = true;
      }
      if (res?.status === 401) die("The server no longer knows this runner. Register it again.");
      if (res?.status === 200) {
        await work(config, (await res.json()) as Claim, instance, running).catch((e) => console.error("Job failed to run:", e));
        continue;
      }
      await Bun.sleep(IDLE_MS + Math.random() * 500);
    }
  };
  await Promise.all(Array.from({ length: slots }, slot));
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    name: { type: "string" },
    isolation: { type: "string" },
    config: { type: "string" },
    jobs: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.isolation && values.isolation !== "container" && values.isolation !== "host") die("--isolation must be container or host");
if (values.help) console.log(USAGE);
else if (positionals[0] === "register") await register(values);
else if (positionals[0] === "run") await run(values);
else die(USAGE);
