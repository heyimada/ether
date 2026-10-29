// Parsing workflow files into triggers, jobs and steps. Pure, so it can be tested without a database.
import { parse as parseYaml } from "yaml";
import { IMAGE_RE } from "./ci-container";
import { checkGraph, comboName, parseCondition, parseNeeds, parseStrategy, type MatrixValues } from "./ci-graph";
import { LEGACY_TRIGGERS, parseOn, type Triggers } from "./ci-triggers";

// Workflows live in .ether/workflows/*.yml, each with its own `on:`. The older single .ether/ci.yml still
// works and runs on every push to a branch unless it says otherwise.
export const WORKFLOW = ".ether/ci.yml";
export const WORKFLOW_DIR = ".ether/workflows";
export const MAX_WORKFLOWS = 20;
export const isWorkflowFile = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/.test(name);
// The name a workflow goes by when it doesn't give one.
export const defaultWorkflowName = (path: string) => (path === WORKFLOW ? "CI" : path.slice(path.lastIndexOf("/") + 1).replace(/\.ya?ml$/, ""));
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const SHELLS = ["bash", "sh", "pwsh", "powershell", "cmd"] as const;
export type Shell = (typeof SHELLS)[number];
// A secret is stored by name; its value is only looked up when the job starts.
export type EnvValue = string | { secret: string };
export type Step = { name: string; run: string; shell: Shell | null; timeoutMinutes: number; env: Record<string, EnvValue> };

// Upper case like environment variables, and nothing that would shadow what Ether sets itself (CI, CI_*).
export const SECRET_NAME_RE = /^(?!CI$|CI_)[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_NAME_RE = /^(?!CI$|CI_)[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_REF_RE = /^\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$/;

// An env map from the workflow: literal values, or exactly `${{ secrets.NAME }}`.
function parseEnv(raw: unknown, where: string): Record<string, EnvValue> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: env must be a map of NAME: value`);
  const out: Record<string, EnvValue> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`${where}: "${name}" isn't a valid variable name (CI and CI_* are set by Ether)`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`${where}: ${name} must be a string, number or boolean`);
    const text = String(value);
    const ref = SECRET_REF_RE.exec(text);
    if (ref) {
      if (!SECRET_NAME_RE.test(ref[1])) throw new Error(`${where}: "${ref[1]}" isn't a valid secret name`);
      out[name] = { secret: ref[1] };
    } else if (text.includes("${{")) throw new Error(`${where}: ${name} can only be a plain value or exactly \${{ secrets.NAME }}`);
    else out[name] = text;
  }
  return out;
}

export const ENVIRONMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// `environment: production` or `environment: { name: production, url: https://… }`, as on GitHub.
function parseEnvironment(raw: unknown, job: string): { name: string; url: string | null } | null {
  if (raw === undefined || raw === null) return null;
  const { name, url } = (typeof raw === "string" ? { name: raw } : raw) as { name?: unknown; url?: unknown };
  if (typeof name !== "string" || !ENVIRONMENT_RE.test(name)) throw new Error(`Job "${job}": environment must be a name such as production (letters, digits, '.', '_' or '-')`);
  if (url === undefined || url === null) return { name, url: null };
  if (typeof url !== "string" || url.length > 500 || !/^https?:\/\/\S+$/.test(url)) throw new Error(`Job "${job}": environment url must be an http(s) address`);
  return { name, url };
}

// One job to run: a job of the workflow, or one combination of its matrix. `key` is its id in the workflow, which
// `needs` refers to; `name` is what people see.
export type ParsedJob = {
  key: string;
  name: string;
  image: string | null;
  environment: { name: string; url: string | null } | null;
  steps: Step[];
  needs: string[];
  condition: string | null;
  matrix: MatrixValues;
  failFast: boolean;
  maxParallel: number | null;
};
// Matrices multiply jobs; a run is kept to this many.
export const MAX_RUN_JOBS = 100;
export type ParsedWorkflow = { name: string; on: Triggers; jobs: ParsedJob[] };

// Validates the workflow and normalises it into its name, triggers and jobs of steps; throws a readable message.
export function parseWorkflow(text: string, path = WORKFLOW): ParsedWorkflow {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`${path} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const { jobs, name, on } = (doc ?? {}) as { jobs?: unknown; name?: unknown; on?: unknown };
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 100)) throw new Error(`${path}: name must be text of up to 100 characters`);
  // Only the older file may leave out `on:`; a new one that forgot it shouldn't run on every push by surprise.
  if (on === undefined && path !== WORKFLOW) throw new Error(`${path} needs "on" to say when it runs, e.g. on: push`);
  let triggers: Triggers;
  try {
    triggers = on === undefined ? LEGACY_TRIGGERS : parseOn(on);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new Error(`${path} needs a "jobs" map`);
  const defs = Object.entries(jobs as Record<string, unknown>);
  if (defs.length === 0 || defs.length > 20) throw new Error(`${path} needs between 1 and 20 jobs`);
  const parsed = defs.map(([name, job]) => {
    if (!NAME_RE.test(name)) throw new Error(`Job name "${name}" must be letters, digits, spaces, '.', '_' or '-'`);
    const spec = (job ?? {}) as { steps?: unknown; image?: unknown; env?: unknown; environment?: unknown; name?: unknown; needs?: unknown; if?: unknown; strategy?: unknown };
    const { steps, image, env, environment } = spec;
    if (spec.name !== undefined && (typeof spec.name !== "string" || !spec.name.trim() || spec.name.length > 100)) throw new Error(`Job "${name}": name must be text of up to 100 characters`);
    if (!Array.isArray(steps) || steps.length === 0) throw new Error(`Job "${name}" needs a list of steps`);
    if (image !== undefined && (typeof image !== "string" || !IMAGE_RE.test(image))) throw new Error(`Job "${name}": image must be a container image name such as alpine:3.20`);
    const jobEnv = parseEnv(env, `Job "${name}"`);
    return {
      key: name,
      title: typeof spec.name === "string" ? spec.name.trim() : name,
      needs: parseNeeds(spec.needs, `Job "${name}"`),
      condition: parseCondition(spec.if, `Job "${name}"`),
      strategy: parseStrategy(spec.strategy, `Job "${name}"`),
      image: (image as string | undefined) ?? null,
      environment: parseEnvironment(environment, name),
      steps: steps.map((s, i): Step => {
        const step = s as { name?: unknown; run?: unknown; shell?: unknown; "timeout-minutes"?: unknown; env?: unknown };
        if (typeof step?.run !== "string" || !step.run.trim()) throw new Error(`Step ${i + 1} of "${name}" needs a "run" command`);
        if (step.shell !== undefined && !SHELLS.includes(step.shell as Shell)) throw new Error(`Step ${i + 1} of "${name}": shell must be one of ${SHELLS.join(", ")}`);
        const minutes = Number(step["timeout-minutes"] ?? 10);
        return {
          name: typeof step.name === "string" && step.name.trim() ? step.name.trim().slice(0, 100) : step.run.split("\n")[0].slice(0, 100),
          run: step.run,
          shell: (step.shell as Shell | undefined) ?? null,
          timeoutMinutes: Math.min(60, Math.max(1, Number.isFinite(minutes) ? minutes : 10)),
          env: { ...jobEnv, ...parseEnv(step.env, `Step ${i + 1} of "${name}"`) },
        };
      }),
    };
  });
  checkGraph(new Map(parsed.map((j) => [j.key, j.needs])));
  const out = parsed.flatMap(({ key, title, needs, condition, strategy, image, environment, steps }): ParsedJob[] =>
    (strategy?.combos ?? [{}]).map((matrix) => ({
      key,
      name: comboName(title, matrix),
      image,
      environment,
      steps,
      needs,
      condition,
      matrix,
      failFast: strategy?.failFast ?? true,
      maxParallel: strategy?.maxParallel ?? null,
    })),
  );
  if (out.length > MAX_RUN_JOBS) throw new Error(`${path}: its matrices make ${out.length} jobs; a run can have at most ${MAX_RUN_JOBS}`);
  return { name: typeof name === "string" ? name.trim() : defaultWorkflowName(path), on: triggers, jobs: out };
}
