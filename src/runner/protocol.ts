// What Ether and a runner say to each other about a job. The assignment holds everything the runner needs
// and it reports back through a channel, so a runner knows nothing of Ether's database or disk. Assignments
// are plain data, ready to go over the wire to a runner on another machine.

export type Shell = "bash" | "sh" | "pwsh" | "powershell" | "cmd";
export type Isolation = "container" | "host";

// A step's env has its secrets filled in already.
export type RunnerStep = { name: string; run: string; shell: Shell | null; timeoutMinutes: number; env: Record<string, string> };

export type JobAssignment = {
  jobId: number;
  runId: number;
  isolation: Isolation;
  // null is the runner's default image.
  image: string | null;
  checkout: { url: string; sha: string };
  // What every step is told about the run.
  vars: Record<string, string>;
  // Values to keep out of the log.
  mask: string[];
  steps: RunnerStep[];
};

// "error" is a job that couldn't run its steps, "failure" one whose step failed.
export type JobResult = "success" | "failure" | "error" | "cancelled";

export type JobChannel = { log: (text: string) => void };

export type RunningJob = { done: Promise<JobResult>; stop: () => void };
