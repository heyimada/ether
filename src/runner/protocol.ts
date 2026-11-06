import type { Context } from "./expr";

// What Ether and a runner say to each other about a job. The assignment holds everything the runner needs
// and it reports back through a channel, so a runner knows nothing of Ether's database or disk. Assignments
// are plain data, ready to go over the wire to a runner on another machine.

// What `runs-on:` and an environment's rules ask of a runner, and what it offers with `--labels`.
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_LABELS = 10;

export type Shell = "bash" | "sh" | "pwsh" | "powershell" | "cmd";
export type Isolation = "container" | "host";

// Which assignments a runner understands; a runner of another version is told to update.
export const PROTOCOL = 2;

// Its texts can hold `${{ }}` expressions, which the runner fills in right before the step, when earlier steps' outputs are known.
export type RunnerStep = { id: string | null; name: string; run: string; shell: Shell | null; timeoutMinutes: number; env: Record<string, string>; if: string | null; continueOnError: boolean };

export type JobAssignment = {
  jobId: number;
  runId: number;
  isolation: Isolation;
  // null is the runner's default image.
  image: string | null;
  // A path on this machine, or for an external runner a path on the server and the header that opens it.
  checkout: { url: string; sha: string; authorization?: string };
  // What every step is told about the run.
  vars: Record<string, string>;
  // What expressions can see: github, inputs, matrix, needs and the job's secrets.
  context: Context;
  // The job's `outputs:`, filled in when its steps are done.
  outputs: Record<string, string>;
  // Values to keep out of the log.
  mask: string[];
  steps: RunnerStep[];
};

// "error" is a job that couldn't run its steps, "failure" one whose step failed.
export type JobResult = "success" | "failure" | "error" | "cancelled";

export type JobChannel = { log: (text: string) => void };

export type RunningJob = { done: Promise<JobResult>; stop: () => void; outputs: () => Record<string, string> };

// What goes over the wire to an external runner (see ../server/routes/runners.ts for the routes).
export const RESULTS: JobResult[] = ["success", "failure", "error", "cancelled"];
// A runner reports at least every heartbeatMs while it runs the job, or the server gives up on it.
export type Claim = { assignment: JobAssignment; token: string; heartbeatMs: number };
export type Progress = { stop: boolean };
