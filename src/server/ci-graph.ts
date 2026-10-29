// How a workflow's jobs relate: `needs:`, `if:` and `strategy.matrix`, as on GitHub. Pure, so it can be tested
// without a database.

export type Scalar = string | number | boolean;
export type MatrixValues = Record<string, string>;
export type Strategy = { combos: MatrixValues[]; failFast: boolean; maxParallel: number | null };

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const MAX_COMBOS = 256;

// ---------- if: ----------

// Until expressions arrive, `if:` takes one of GitHub's status functions, optionally negated and optionally in ${{ }}.
const CONDITIONS = ["success()", "failure()", "always()", "cancelled()"] as const;

export function parseCondition(raw: unknown, where: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" && typeof raw !== "boolean") throw new Error(`${where}: if must be a condition such as failure()`);
  let text = String(raw).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  const negated = text.startsWith("!");
  const fn = (negated ? text.slice(1) : text).trim();
  if (!CONDITIONS.includes(fn as (typeof CONDITIONS)[number]))
    throw new Error(`${where}: if can be ${CONDITIONS.join(", ")} or one of them negated with !; other expressions aren't supported yet`);
  return `${negated ? "!" : ""}${fn}`;
}

export type NeedStatus = "success" | "failure" | "error" | "cancelled" | "skipped";

// Whether a job whose needs have all finished should run. Without `if:` it runs only when every need succeeded,
// so a failed or skipped need skips everything after it unless that asks for always() or failure().
export function conditionHolds(condition: string | null, needs: NeedStatus[]): boolean {
  const c = condition ?? "success()";
  const negated = c.startsWith("!");
  const fn = negated ? c.slice(1) : c;
  const value =
    fn === "always()" ? true : fn === "failure()" ? needs.some((s) => s === "failure" || s === "error") : fn === "cancelled()" ? false : needs.every((s) => s === "success");
  return negated ? !value : value;
}

// ---------- needs: ----------

export function parseNeeds(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.some((n) => typeof n !== "string")) throw new Error(`${where}: needs must be a job name or a list of them`);
  return [...new Set(list as string[])];
}

// Every need names another job, and nothing depends on itself, directly or around a loop.
export function checkGraph(needs: Map<string, string[]>) {
  for (const [job, deps] of needs) for (const d of deps) if (!needs.has(d)) throw new Error(`Job "${job}" needs "${d}", which isn't a job in this workflow`);
  const state = new Map<string, "visiting" | "done">();
  const visit = (job: string, path: string[]) => {
    if (state.get(job) === "done") return;
    if (state.get(job) === "visiting") throw new Error(`Jobs can't need each other in a loop: ${[...path.slice(path.indexOf(job)), job].join(" → ")}`);
    state.set(job, "visiting");
    for (const d of needs.get(job)!) visit(d, [...path, job]);
    state.set(job, "done");
  };
  for (const job of needs.keys()) visit(job, []);
}

// ---------- strategy.matrix ----------

const scalar = (v: unknown, where: string): string => {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new Error(`${where}: matrix values must be strings, numbers or booleans`);
  return String(v);
};

function entries(raw: unknown, where: string): MatrixValues[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((e) => !e || typeof e !== "object" || Array.isArray(e))) throw new Error(`${where} must be a list of maps`);
  return (raw as Record<string, unknown>[]).map((e) =>
    Object.fromEntries(
      Object.entries(e).map(([k, v]) => {
        if (!KEY_RE.test(k)) throw new Error(`${where}: "${k}" isn't a valid matrix key`);
        return [k, scalar(v, where)];
      }),
    ),
  );
}

const fits = (combo: MatrixValues, partial: MatrixValues) => Object.entries(partial).every(([k, v]) => combo[k] === v);

// The combinations a job runs with, following GitHub: the product of the lists, minus what `exclude` matches,
// then each `include` entry is added to every combination whose original values it doesn't change, or becomes
// a combination of its own when it fits none.
export function parseStrategy(raw: unknown, where: string): Strategy | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: strategy must be a map`);
  const s = raw as { matrix?: unknown; "fail-fast"?: unknown; "max-parallel"?: unknown };
  if (s["fail-fast"] !== undefined && typeof s["fail-fast"] !== "boolean") throw new Error(`${where}: fail-fast must be true or false`);
  const maxParallel = s["max-parallel"];
  if (maxParallel !== undefined && (!Number.isInteger(maxParallel) || (maxParallel as number) < 1)) throw new Error(`${where}: max-parallel must be a whole number of at least 1`);
  if (!s.matrix || typeof s.matrix !== "object" || Array.isArray(s.matrix)) throw new Error(`${where}: strategy needs a matrix map`);
  const { include, exclude, ...lists } = s.matrix as Record<string, unknown>;
  let combos: MatrixValues[] = [{}];
  for (const [key, values] of Object.entries(lists)) {
    if (!KEY_RE.test(key)) throw new Error(`${where}: "${key}" isn't a valid matrix key (letters, digits, _ or -)`);
    if (!Array.isArray(values) || values.length === 0) throw new Error(`${where}: matrix.${key} must be a non-empty list`);
    const vals = values.map((v) => scalar(v, `${where}: matrix.${key}`));
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [key]: v })));
    if (combos.length > MAX_COMBOS) throw new Error(`${where}: a matrix can have at most ${MAX_COMBOS} combinations`);
  }
  const base = Object.keys(lists);
  const excluded = entries(exclude, `${where}: matrix.exclude`);
  combos = base.length ? combos.filter((c) => !excluded.some((e) => fits(c, e))) : [];
  // Includes extend the combinations from the lists, never the ones earlier includes added.
  const originals = combos.map((c) => ({ ...c }));
  const added: MatrixValues[] = [];
  for (const inc of entries(include, `${where}: matrix.include`)) {
    let matched = false;
    originals.forEach((o, i) => {
      // An include may not change a value that came from the lists; values it added earlier it may.
      if (!base.every((k) => !(k in inc) || inc[k] === o[k])) return;
      matched = true;
      Object.assign(combos[i], inc);
    });
    if (!matched) added.push({ ...inc });
  }
  combos = [...combos, ...added];
  if (combos.length === 0) throw new Error(`${where}: the matrix leaves no combinations`);
  const envNames = new Map<string, string>();
  for (const key of new Set(combos.flatMap((c) => Object.keys(c)))) {
    const other = envNames.get(matrixEnvName(key));
    if (other) throw new Error(`${where}: matrix keys "${other}" and "${key}" both become ${matrixEnvName(key)}`);
    envNames.set(matrixEnvName(key), key);
  }
  if (combos.length > MAX_COMBOS) throw new Error(`${where}: a matrix can have at most ${MAX_COMBOS} combinations`);
  return { combos, failFast: s["fail-fast"] !== false, maxParallel: (maxParallel as number | undefined) ?? null };
}

export const matrixEnvName = (key: string) => `CI_MATRIX_${key.toUpperCase().replace(/-/g, "_")}`;

// "test (1.4, linux)", as GitHub names matrix jobs.
export const comboName = (name: string, combo: MatrixValues) => {
  const values = Object.values(combo);
  return (values.length ? `${name} (${values.join(", ")})` : name).slice(0, 100);
};
