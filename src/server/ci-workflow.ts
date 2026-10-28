// Parsing .ether/ci.yml into jobs and steps. Pure, so it can be tested without a database.
import { parse as parseYaml } from "yaml";
import { IMAGE_RE } from "./ci-container";

export const WORKFLOW = ".ether/ci.yml";
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

// Validates the workflow and normalises it into jobs of steps; throws a readable message.
export function parseWorkflow(text: string): { name: string; image: string | null; steps: Step[] }[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`${WORKFLOW} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new Error(`${WORKFLOW} needs a "jobs" map`);
  const out = Object.entries(jobs as Record<string, unknown>).map(([name, job]) => {
    if (!NAME_RE.test(name)) throw new Error(`Job name "${name}" must be letters, digits, spaces, '.', '_' or '-'`);
    const { steps, image, env } = (job ?? {}) as { steps?: unknown; image?: unknown; env?: unknown };
    if (!Array.isArray(steps) || steps.length === 0) throw new Error(`Job "${name}" needs a list of steps`);
    if (image !== undefined && (typeof image !== "string" || !IMAGE_RE.test(image))) throw new Error(`Job "${name}": image must be a container image name such as alpine:3.20`);
    const jobEnv = parseEnv(env, `Job "${name}"`);
    return {
      name,
      image: (image as string | undefined) ?? null,
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
  if (out.length === 0 || out.length > 20) throw new Error(`${WORKFLOW} needs between 1 and 20 jobs`);
  return out;
}
