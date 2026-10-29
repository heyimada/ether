// A workflow's `on:` and whether an event starts it, as on GitHub. Pure, so it can be tested without a database.
import { matches, patternProblem } from "./branch-rules";

export const EVENTS = ["push", "pull_request", "workflow_dispatch"] as const;
export type EventName = (typeof EVENTS)[number];
export const PULL_ACTIONS = ["opened", "synchronize", "reopened"] as const;
export type PullAction = (typeof PULL_ACTIONS)[number];

// `branches:` (an ordered list where a later `!pattern` takes a match back) or `branches-ignore:`.
export type Filter = { ignore: boolean; patterns: string[] };
export type InputType = "string" | "boolean" | "choice" | "number";
export type Input = { name: string; description: string; type: InputType; required: boolean; default: string | null; options: string[] };
export type Triggers = {
  push: { branches: Filter | null; tags: Filter | null; paths: Filter | null } | null;
  pull_request: { branches: Filter | null; paths: Filter | null; types: PullAction[] } | null;
  workflow_dispatch: { inputs: Input[] } | null;
};

// What happened. `changed` is null when the changed files aren't known (or are too many), and then path filters let everything through.
export type Trigger =
  | { event: "push"; refType: "branch" | "tag"; ref: string; changed: string[] | null }
  | { event: "pull_request"; action: PullAction; base: string; changed: string[] | null }
  | { event: "workflow_dispatch" };

// The trigger of `.ether/ci.yml`, which predates `on:`: every push to a branch.
export const LEGACY_TRIGGERS: Triggers = { push: { branches: { ignore: false, patterns: ["**"] }, tags: null, paths: null }, pull_request: null, workflow_dispatch: null };

const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_INPUTS = 25;
export const MAX_INPUT_VALUE = 4096;

const list = (raw: unknown, what: string): string[] => {
  const items = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(items) || items.length === 0 || items.length > 50 || items.some((p) => typeof p !== "string" || !p.trim() || p.length > 200))
    throw new Error(`${what} must be a list of patterns`);
  return items.map((p: string) => p.trim());
};

// `x` and `x-ignore` can't both be given, as on GitHub. Branch and tag patterns are matched like protected
// branches, so they're held to the same glob syntax; anything else would end up in a regular expression.
function filter(spec: Record<string, unknown>, key: "branches" | "tags" | "paths", where: string): Filter | null {
  const plain = spec[key];
  const ignored = spec[`${key}-ignore`];
  if (plain !== undefined && ignored !== undefined) throw new Error(`${where}: use either ${key} or ${key}-ignore, not both`);
  if (plain === undefined && ignored === undefined) return null;
  const name = plain !== undefined ? key : `${key}-ignore`;
  const patterns = list(plain ?? ignored, `${where}: ${name}`);
  if (key !== "paths")
    for (const p of patterns) {
      const problem = patternProblem(plain !== undefined && p.startsWith("!") ? p.slice(1) : p);
      if (problem) throw new Error(`${where}: ${name}: "${p}": ${problem}`);
    }
  return { ignore: plain === undefined, patterns };
}

function eventSpec(raw: unknown, event: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`on.${event} must be a map`);
  return raw as Record<string, unknown>;
}

function parseInputs(raw: unknown): Input[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("on.workflow_dispatch.inputs must be a map");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_INPUTS) throw new Error(`A workflow can have at most ${MAX_INPUTS} inputs`);
  const envNames = new Set<string>();
  return entries.map(([name, spec]) => {
    if (!INPUT_NAME_RE.test(name)) throw new Error(`Input "${name}" must be letters, digits, '_' or '-', starting with a letter or '_'`);
    // Steps see it as CI_INPUT_<NAME>, so two names that only differ in case or - and _ would clash.
    const env = inputEnvName(name);
    if (envNames.has(env)) throw new Error(`Inputs "${name}" and another one both become ${env}`);
    envNames.add(env);
    const s = (spec ?? {}) as { description?: unknown; type?: unknown; required?: unknown; default?: unknown; options?: unknown };
    const type = (s.type ?? "string") as InputType;
    if (!["string", "boolean", "choice", "number"].includes(type)) throw new Error(`Input "${name}": type must be string, boolean, choice or number`);
    const options = type === "choice" ? list(s.options, `Input "${name}": options`) : [];
    const input: Input = {
      name,
      description: typeof s.description === "string" ? s.description.slice(0, 500) : "",
      type,
      required: s.required === true,
      default: s.default === undefined || s.default === null ? null : String(s.default),
      options,
    };
    if (input.default !== null) checkValue(input, input.default, "its default");
    return input;
  });
}

// Normalises `on:` (a name, a list of names or a map of names to settings); throws a readable message.
export function parseOn(raw: unknown): Triggers {
  const map: Record<string, unknown> =
    typeof raw === "string"
      ? { [raw]: null }
      : Array.isArray(raw)
        ? Object.fromEntries(raw.map((e) => [String(e), null]))
        : raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : (() => {
              throw new Error(`"on" must name the events that start the workflow, e.g. on: push`);
            })();
  const names = Object.keys(map);
  if (names.length === 0) throw new Error(`"on" must name at least one event`);
  for (const n of names) if (!EVENTS.includes(n as EventName)) throw new Error(`on: "${n}" isn't supported; Ether starts workflows on ${EVENTS.join(", ")}`);
  const triggers: Triggers = { push: null, pull_request: null, workflow_dispatch: null };
  if ("push" in map) {
    const s = eventSpec(map.push, "push");
    triggers.push = { branches: filter(s, "branches", "on.push"), tags: filter(s, "tags", "on.push"), paths: filter(s, "paths", "on.push") };
  }
  if ("pull_request" in map) {
    const s = eventSpec(map.pull_request, "pull_request");
    const types = s.types === undefined ? [...PULL_ACTIONS] : list(s.types, "on.pull_request.types");
    for (const t of types) if (!PULL_ACTIONS.includes(t as PullAction)) throw new Error(`on.pull_request.types: "${t}" isn't supported; use ${PULL_ACTIONS.join(", ")}`);
    triggers.pull_request = { branches: filter(s, "branches", "on.pull_request"), paths: filter(s, "paths", "on.pull_request"), types: types as PullAction[] };
  }
  if ("workflow_dispatch" in map) triggers.workflow_dispatch = { inputs: parseInputs(eventSpec(map.workflow_dispatch, "workflow_dispatch").inputs) };
  return triggers;
}

// In an ordered list the last pattern that matches decides, so `!` can take a match back; an ignore list excludes whatever matches.
function passes(f: Filter, value: string, match: (pattern: string, value: string) => boolean): boolean {
  if (f.ignore) return !f.patterns.some((p) => match(p, value));
  let hit = false;
  for (const p of f.patterns) if (p.startsWith("!") ? match(p.slice(1), value) : match(p, value)) hit = !p.startsWith("!");
  return hit;
}

// Paths are case-sensitive, unlike branch names; * stays within a directory, ** crosses them.
function pathMatches(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    // `**/` also matches no directory at all, so src/**/*.ts covers src/a.ts.
    if (c === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") (re += "(?:.*/)?"), (i += 2);
    else if (c === "*" && pattern[i + 1] === "*") (re += ".*"), i++;
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

// `paths`: some changed file is included. `paths-ignore`: some changed file isn't ignored.
function pathsPass(f: Filter | null, changed: string[] | null): boolean {
  if (!f || changed === null) return true;
  return changed.some((file) => passes(f, file, pathMatches));
}

export function starts(t: Triggers, e: Trigger): boolean {
  switch (e.event) {
    case "push": {
      const p = t.push;
      if (!p) return false;
      // Naming only branches leaves tags out and the other way round; naming neither takes both.
      if (!p.branches && !p.tags) return e.refType === "tag" || pathsPass(p.paths, e.changed);
      const f = e.refType === "branch" ? p.branches : p.tags;
      if (!f || !passes(f, e.ref, matches)) return false;
      // Path filters don't apply to tags, which point at a commit rather than change anything.
      return e.refType === "tag" || pathsPass(p.paths, e.changed);
    }
    case "pull_request": {
      const p = t.pull_request;
      if (!p || !p.types.includes(e.action)) return false;
      // Branch filters look at the branch the pull request goes into.
      if (p.branches && !passes(p.branches, e.base, matches)) return false;
      return pathsPass(p.paths, e.changed);
    }
    case "workflow_dispatch":
      return !!t.workflow_dispatch;
  }
}

export const inputEnvName = (name: string) => `CI_INPUT_${name.toUpperCase().replace(/-/g, "_")}`;

function checkValue(input: Input, value: string, what: string) {
  if (value.length > MAX_INPUT_VALUE) throw new Error(`Input "${input.name}": ${what} can be at most ${MAX_INPUT_VALUE} characters`);
  if (input.type === "boolean" && value !== "true" && value !== "false") throw new Error(`Input "${input.name}": ${what} must be true or false`);
  if (input.type === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) throw new Error(`Input "${input.name}": ${what} must be a number`);
  if (input.type === "choice" && !input.options.includes(value)) throw new Error(`Input "${input.name}": ${what} must be one of ${input.options.join(", ")}`);
}

// The values a manual run gets: what was given, else the default; booleans default to false as on GitHub.
export function resolveInputs(inputs: Input[], given: Record<string, unknown>): Record<string, string> {
  for (const name of Object.keys(given)) if (!inputs.some((i) => i.name === name)) throw new Error(`This workflow has no input "${name}"`);
  const out: Record<string, string> = {};
  for (const input of inputs) {
    const raw = given[input.name];
    if (raw !== undefined && raw !== null && typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") throw new Error(`Input "${input.name}" must be a single value`);
    const value = raw === undefined || raw === null || raw === "" ? (input.default ?? (input.type === "boolean" ? "false" : null)) : String(raw);
    if (value === null) {
      if (input.required) throw new Error(`Input "${input.name}" is required`);
      out[input.name] = "";
      continue;
    }
    checkValue(input, value, "the value");
    out[input.name] = value;
  }
  return out;
}
