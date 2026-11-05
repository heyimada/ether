// GitHub's `${{ }}` expression language, as workflows use it in `if:`, `run:`, `env:` and more. Pure, and used by
// both the server and runners: jobs' conditions are decided on the server, steps' on the runner that has their
// outputs. It only ever reads what it's given: no code runs, and own properties are all it can see.

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type Context = Record<string, Value>;
// The status functions, which depend on where an expression runs.
export type Status = { success: boolean; failure: boolean; cancelled: boolean };

type Node =
  | { kind: "literal"; value: Value }
  | { kind: "context"; name: string }
  | { kind: "index"; target: Node; key: Node }
  | { kind: "not"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

const MAX_SOURCE = 4096;
const MAX_DEPTH = 64;
// How many characters one evaluation may produce, all its functions together. The source's length doesn't bound
// this: format('{0}{0}…', format('{0}{0}…', …)) multiplies at every level, so without it a workflow could make
// the server build gigabytes on its event loop. Step outputs can be 1 MiB, so there is room to pass a few on.
export const MAX_PRODUCED = 8 * 1024 * 1024;
const STATUS = new Set(["success", "failure", "always", "cancelled"]);
const ARITY: Record<string, [number, number]> = { success: [0, 0], failure: [0, 0], always: [0, 0], cancelled: [0, 0], contains: [2, 2], startswith: [2, 2], endswith: [2, 2], format: [1, 64], join: [1, 2], tojson: [1, 1], fromjson: [1, 1] };

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isId = (c: string) => /[A-Za-z0-9_-]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

export function parseExpression(source: string): Node {
  if (source.length > MAX_SOURCE) throw new Error(`An expression can be at most ${MAX_SOURCE} characters`);
  let at = 0;
  let depth = 0;
  const skip = () => {
    while (at < source.length && /\s/.test(source[at])) at++;
  };
  const fail = (what: string): never => {
    throw new Error(`${what} in the expression "${source.trim()}"`);
  };
  const take = (text: string) => {
    skip();
    if (!source.startsWith(text, at)) return false;
    at += text.length;
    return true;
  };
  const nested = <T>(fn: () => T): T => {
    if (++depth > MAX_DEPTH) fail("Too much nesting");
    const out = fn();
    depth--;
    return out;
  };
  const binary = (ops: string[], next: () => Node) => (): Node => {
    let left = next();
    for (;;) {
      const op = ops.find((o) => take(o));
      if (!op) return left;
      left = { kind: "binary", op, left, right: next() };
    }
  };
  const primary = (): Node => {
    skip();
    const c = source[at];
    if (c === undefined) return fail("Something is missing at the end");
    if (c === "(") {
      at++;
      const inner = nested(or);
      if (!take(")")) fail("A closing ) is missing");
      return inner;
    }
    if (c === "'") {
      let value = "";
      for (at++; ; at++) {
        if (at >= source.length) fail("A closing ' is missing");
        if (source[at] !== "'") value += source[at];
        else if (source[at + 1] === "'") (value += "'"), at++;
        else break;
      }
      at++;
      return { kind: "literal", value };
    }
    if (isDigit(c) || (c === "-" && isDigit(source[at + 1] ?? ""))) {
      const start = at++;
      while (at < source.length && (isDigit(source[at]) || source[at] === ".")) at++;
      const value = Number(source.slice(start, at));
      if (!Number.isFinite(value)) fail("That isn't a number");
      return { kind: "literal", value };
    }
    if (!isIdStart(c)) return fail(`Unexpected "${c}"`);
    const start = at;
    while (at < source.length && isId(source[at])) at++;
    const word = source.slice(start, at);
    if (word === "true" || word === "false") return { kind: "literal", value: word === "true" };
    if (word === "null") return { kind: "literal", value: null };
    if (take("(")) {
      const name = word.toLowerCase();
      const arity = ARITY[name];
      if (!arity) fail(`There's no function ${word}()`);
      const args: Node[] = [];
      if (!take(")")) {
        do args.push(nested(or));
        while (take(","));
        if (!take(")")) fail("A closing ) is missing");
      }
      if (args.length < arity[0] || args.length > arity[1]) fail(`${word}() can't take ${args.length} arguments`);
      return { kind: "call", name, args };
    }
    return { kind: "context", name: word };
  };
  const postfix = (): Node => {
    let node = primary();
    for (;;) {
      if (take(".")) {
        skip();
        const start = at;
        while (at < source.length && isId(source[at])) at++;
        if (at === start) fail("A name is missing after .");
        node = { kind: "index", target: node, key: { kind: "literal", value: source.slice(start, at) } };
      } else if (take("[")) {
        const key = nested(or);
        if (!take("]")) fail("A closing ] is missing");
        node = { kind: "index", target: node, key };
      } else return node;
    }
  };
  const unary = (): Node => {
    skip();
    if (source[at] === "!" && source[at + 1] !== "=") {
      at++;
      return { kind: "not", operand: nested(unary) };
    }
    return postfix();
  };
  const compare = binary(["<=", ">=", "==", "!=", "<", ">"], unary);
  const and = binary(["&&"], compare);
  const or = binary(["||"], and);
  const node = or();
  skip();
  if (at < source.length) fail(`Unexpected "${source[at]}"`);
  return node;
}

const walk = (node: Node, visit: (n: Node) => void) => {
  visit(node);
  if (node.kind === "index") walk(node.target, visit), walk(node.key, visit);
  else if (node.kind === "not") walk(node.operand, visit);
  else if (node.kind === "binary") walk(node.left, visit), walk(node.right, visit);
  else if (node.kind === "call") node.args.forEach((a) => walk(a, visit));
};

// `${{ … }}` parts of a text, each with where it sits. A `}}` inside a quoted string doesn't end one.
function templates(text: string): { start: number; end: number; source: string }[] {
  const out: { start: number; end: number; source: string }[] = [];
  for (let at = text.indexOf("${{"); at !== -1; at = text.indexOf("${{", at)) {
    let i = at + 3;
    let quoted = false;
    for (; i < text.length; i++) {
      if (text[i] === "'") quoted = !quoted;
      else if (!quoted && text.startsWith("}}", i)) break;
    }
    if (i >= text.length) throw new Error(`A closing }} is missing in "${text.slice(at, at + 60)}"`);
    out.push({ start: at, end: i + 2, source: text.slice(at + 3, i) });
    at = i + 2;
  }
  return out;
}

export const hasTemplate = (text: string) => text.includes("${{");
// An `if:` may be written with or without ${{ }}.
export function unwrap(text: string) {
  const trimmed = text.trim();
  const parts = templates(trimmed);
  return parts.length === 1 && parts[0].start === 0 && parts[0].end === trimmed.length ? parts[0].source.trim() : trimmed;
}

// Refuses what can't work, when the workflow is read rather than when it runs. `secrets` must be followed by a
// name, so which secrets a job needs is known before it gets any.
function check(node: Node, contexts: string[]) {
  walk(node, (n) => {
    if (n.kind === "context" && !contexts.includes(n.name.toLowerCase())) throw new Error(`The context "${n.name}" isn't available here; these are: ${contexts.join(", ")}`);
    if (n.kind === "call" && STATUS.has(n.name) && !contexts.includes("needs") && !contexts.includes("steps")) throw new Error(`${n.name}() isn't available here`);
  });
  const named = (n: Node, parent: Node | null): void => {
    if (n.kind === "context" && n.name.toLowerCase() === "secrets") {
      if (parent?.kind !== "index" || parent.target !== n || parent.key.kind !== "literal") throw new Error("Secrets have to be named, as in secrets.NAME");
    }
    if (n.kind === "index") named(n.target, n), named(n.key, n);
    else if (n.kind === "not") named(n.operand, n);
    else if (n.kind === "binary") named(n.left, n), named(n.right, n);
    else if (n.kind === "call") n.args.forEach((a) => named(a, n));
  };
  named(node, null);
}

export const checkExpression = (source: string, contexts: string[]) => check(parseExpression(source), contexts);
export function checkTemplate(text: string, contexts: string[]) {
  for (const t of templates(text)) checkExpression(t.source, contexts);
}

// The secrets a text refers to.
export function secretsIn(text: string, isExpression = false): string[] {
  const names = new Set<string>();
  for (const source of isExpression ? [text] : templates(text).map((t) => t.source))
    walk(parseExpression(source), (n) => {
      if (n.kind === "index" && n.target.kind === "context" && n.target.name.toLowerCase() === "secrets" && n.key.kind === "literal") names.add(String(n.key.value));
    });
  return [...names];
}

export function toText(v: Value): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return Array.isArray(v) ? "Array" : "Object";
}

export const truthy = (v: Value) => !(v === null || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));

function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return NaN;
}

// Strings compare without regard to case; different types compare as numbers; arrays and objects only with themselves.
function compare(op: string, a: Value, b: Value): boolean {
  let order: number;
  if (typeof a === "string" && typeof b === "string") {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    order = x === y ? 0 : x < y ? -1 : 1;
  } else if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    if (op === "==") return a === b;
    if (op === "!=") return a !== b;
    return false;
  } else {
    const [x, y] = [toNumber(a), toNumber(b)];
    if (Number.isNaN(x) || Number.isNaN(y)) return op === "!=";
    order = x === y ? 0 : x < y ? -1 : 1;
  }
  return { "==": order === 0, "!=": order !== 0, "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0 }[op]!;
}

type Budget = { left: number };
const charge = (budget: Budget, chars: number) => {
  budget.left -= chars;
  if (budget.left < 0) throw new Error(`An expression can produce at most ${MAX_PRODUCED} characters`);
};

// How deeply arrays and objects nest. toJSON indents every level, so its output grows with the square of this.
const MAX_NESTING = 64;
function shallow(v: Value, depth = 0): Value {
  if (v !== null && typeof v === "object") {
    if (depth >= MAX_NESTING) throw new Error(`A value can nest at most ${MAX_NESTING} levels deep`);
    for (const inner of Object.values(v)) shallow(inner, depth + 1);
  }
  return v;
}

function format(template: string, args: string[], budget: Budget) {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if ((c === "{" || c === "}") && template[i + 1] === c) {
      out += c;
      i++;
    } else if (c === "{") {
      const end = template.indexOf("}", i);
      const n = end === -1 ? NaN : Number(template.slice(i + 1, end));
      if (!Number.isInteger(n) || n < 0 || n >= args.length) throw new Error(`format(): "${template}" refers to an argument it wasn't given`);
      if (out.length + args[n].length > budget.left) charge(budget, out.length + args[n].length);
      out += args[n];
      i = end;
    } else out += c;
  }
  charge(budget, out.length);
  return out;
}

const own = (target: { [key: string]: Value }, key: string): Value => {
  if (Object.hasOwn(target, key)) return target[key];
  const lower = key.toLowerCase();
  const found = Object.keys(target).find((k) => k.toLowerCase() === lower);
  return found === undefined ? null : target[found];
};

function evaluate(node: Node, ctx: Context, status: Status, budget: Budget): Value {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "context":
      return own(ctx, node.name);
    case "index": {
      const target = evaluate(node.target, ctx, status, budget);
      const key = evaluate(node.key, ctx, status, budget);
      if (Array.isArray(target)) return typeof key === "number" && Number.isInteger(key) ? (target[key] ?? null) : null;
      return target !== null && typeof target === "object" ? own(target, toText(key)) : null;
    }
    case "not":
      return !truthy(evaluate(node.operand, ctx, status, budget));
    case "binary": {
      const left = evaluate(node.left, ctx, status, budget);
      if (node.op === "&&") return truthy(left) ? evaluate(node.right, ctx, status, budget) : left;
      if (node.op === "||") return truthy(left) ? left : evaluate(node.right, ctx, status, budget);
      return compare(node.op, left, evaluate(node.right, ctx, status, budget));
    }
    case "call": {
      if (node.name === "success") return status.success;
      if (node.name === "failure") return status.failure;
      if (node.name === "cancelled") return status.cancelled;
      if (node.name === "always") return true;
      const args = node.args.map((a) => evaluate(a, ctx, status, budget));
      switch (node.name) {
        case "contains": {
          const [hay, needle] = args;
          if (Array.isArray(hay)) return hay.some((v) => compare("==", v, needle));
          return toText(hay).toLowerCase().includes(toText(needle).toLowerCase());
        }
        case "startswith":
          return toText(args[0]).toLowerCase().startsWith(toText(args[1]).toLowerCase());
        case "endswith":
          return toText(args[0]).toLowerCase().endsWith(toText(args[1]).toLowerCase());
        case "format":
          return format(toText(args[0]), args.slice(1).map(toText), budget);
        case "join": {
          if (!Array.isArray(args[0])) return toText(args[0]);
          const parts = args[0].map(toText);
          const separator = args.length > 1 ? toText(args[1]) : ",";
          charge(budget, parts.reduce((n, p) => n + p.length, 0) + separator.length * Math.max(0, parts.length - 1));
          return parts.join(separator);
        }
        case "tojson": {
          const text = JSON.stringify(shallow(args[0]), null, 2) ?? "null";
          charge(budget, text.length);
          return text;
        }
        case "fromjson": {
          let parsed: Value;
          try {
            parsed = JSON.parse(toText(args[0])) as Value;
          } catch {
            throw new Error(`fromJSON(): that isn't JSON`);
          }
          return shallow(parsed);
        }
      }
      throw new Error(`There's no function ${node.name}()`);
    }
  }
}

const NO_STATUS: Status = { success: true, failure: false, cancelled: false };

const fresh = (): Budget => ({ left: MAX_PRODUCED });

export const evalExpression = (source: string, ctx: Context, status: Status = NO_STATUS, budget = fresh()) => evaluate(parseExpression(source), ctx, status, budget);

// The text with its `${{ }}` parts filled in. A text that's nothing but one part keeps that part's value.
export function evalTemplate(text: string, ctx: Context, status: Status = NO_STATUS): Value {
  const parts = templates(text);
  const budget = fresh();
  if (parts.length === 1 && parts[0].start === 0 && parts[0].end === text.length) return evalExpression(parts[0].source, ctx, status, budget);
  let out = "";
  let from = 0;
  for (const p of parts) {
    const filled = text.slice(from, p.start) + toText(evalExpression(p.source, ctx, status, budget));
    charge(budget, filled.length);
    out += filled;
    from = p.end;
  }
  return out + text.slice(from);
}

export const fillTemplate = (text: string, ctx: Context, status: Status = NO_STATUS) => toText(evalTemplate(text, ctx, status));

// An `if:`. As on GitHub, one that names no status function only counts while everything before it succeeded.
export function holds(condition: string | null, ctx: Context, status: Status): boolean {
  if (condition === null) return status.success;
  const node = parseExpression(condition);
  let named = false;
  walk(node, (n) => {
    if (n.kind === "call" && STATUS.has(n.name)) named = true;
  });
  return (named || status.success) && truthy(evaluate(node, ctx, status, fresh()));
}
