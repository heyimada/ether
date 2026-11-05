import { expect, test } from "bun:test";
import { checkExpression, checkTemplate, evalExpression, evalTemplate, fillTemplate, holds, parseExpression, secretsIn, unwrap } from "./expr";
import { parseOutputs } from "./step-output";

const ctx = {
  github: { ref: "refs/heads/main", event_name: "push", count: 3 },
  matrix: { os: "linux", list: ["a", "b"] },
  inputs: { "dry-run": true },
  steps: { build: { outputs: { version: "1.2" }, outcome: "success" } },
};
const run = (s: string) => evalExpression(s, ctx);

test("contexts, indexes and missing values", () => {
  expect(run("github.ref")).toBe("refs/heads/main");
  expect(run("github['ref']")).toBe("refs/heads/main");
  expect(run("GITHUB.REF")).toBe("refs/heads/main");
  expect(run("inputs.dry-run")).toBe(true);
  expect(run("steps.build.outputs.version")).toBe("1.2");
  expect(run("matrix.list[1]")).toBe("b");
  expect(run("github.nope.deeper")).toBe(null);
  expect(run("nothing")).toBe(null);
});

test("only a context's own values can be reached", () => {
  expect(run("github.constructor")).toBe(null);
  expect(run("github['__proto__']")).toBe(null);
  expect(run("matrix.list.length")).toBe(null);
  expect(run("github.toString")).toBe(null);
});

test("comparisons work as on GitHub", () => {
  expect(run("github.ref == 'REFS/HEADS/MAIN'")).toBe(true);
  expect(run("github.event_name != 'push'")).toBe(false);
  expect(run("github.count >= 3 && github.count < 4")).toBe(true);
  expect(run("'' == 0")).toBe(true);
  expect(run("null == 0")).toBe(true);
  expect(run("true == 1")).toBe(true);
  expect(run("'abc' == 1")).toBe(false);
  expect(run("'abc' != 1")).toBe(true);
  expect(run("matrix == matrix")).toBe(true);
  expect(run("!github.count")).toBe(false);
  expect(run("!(1 == 2)")).toBe(true);
  expect(run("-1 < 0")).toBe(true);
});

test("&& and || give back one of their operands", () => {
  expect(run("github.nope || 'default'")).toBe("default");
  expect(run("github.ref && 'yes'")).toBe("yes");
  expect(run("false && nothing.at.all")).toBe(false);
  expect(run("github.event_name == 'push' && 'a' || 'b'")).toBe("a");
});

test("functions", () => {
  expect(run("contains(matrix.list, 'A')")).toBe(true);
  expect(run("contains('Hello', 'ell')")).toBe(true);
  expect(run("startsWith(github.ref, 'refs/heads/')")).toBe(true);
  expect(run("endsWith(github.ref, 'MAIN')")).toBe(true);
  expect(run("format('{0}-{1} {{x}}', 'a', 2)")).toBe("a-2 {x}");
  expect(run("join(matrix.list, '+')")).toBe("a+b");
  expect(run("join(matrix.list)")).toBe("a,b");
  expect(run("fromJSON('{\"a\": [1, 2]}').a[1]")).toBe(2);
  expect(run("toJSON(matrix.os)")).toBe('"linux"');
  expect(() => run("fromJSON('nope')")).toThrow("isn't JSON");
  expect(() => run("format('{3}', 'a')")).toThrow("wasn't given");
});

test("quotes, and what can't be read", () => {
  expect(run("'it''s'")).toBe("it's");
  for (const bad of ["1 ==", "(1", "'open", "nope()", "contains('a')", "a b", "a..b", "1 = 2", "a & b", ""]) expect(() => parseExpression(bad), bad).toThrow();
  expect(() => parseExpression("(".repeat(100) + "1" + ")".repeat(100))).toThrow("nesting");
  expect(() => parseExpression("!".repeat(100) + "1")).toThrow("nesting");
  expect(() => parseExpression("a".repeat(5000))).toThrow("at most");
});

test("templates fill in text, and one that's nothing else keeps its value", () => {
  expect(fillTemplate("on ${{ matrix.os }}/${{ github.count }}!", ctx)).toBe("on linux/3!");
  expect(evalTemplate("${{ github.count }}", ctx)).toBe(3);
  expect(fillTemplate("no expressions $ {{ here }}", ctx)).toBe("no expressions $ {{ here }}");
  expect(fillTemplate("${{ '}}' }}", ctx)).toBe("}}");
  expect(fillTemplate("${{ nothing }}x", ctx)).toBe("x");
  expect(() => fillTemplate("${{ open", ctx)).toThrow("closing }}");
  expect(unwrap(" ${{ always() }} ")).toBe("always()");
  expect(unwrap("${{ a }} && ${{ b }}")).toBe("${{ a }} && ${{ b }}");
});

test("contexts are checked when a workflow is read, and secrets have to be named", () => {
  expect(() => checkExpression("steps.a.outputs.b", ["github", "needs"])).toThrow('"steps" isn\'t available here');
  expect(() => checkTemplate("x ${{ secrets }}", ["secrets"])).toThrow("have to be named");
  expect(() => checkTemplate("${{ toJSON(secrets) }}", ["secrets"])).toThrow("have to be named");
  expect(() => checkTemplate("${{ secrets[matrix.name] }}", ["secrets", "matrix"])).toThrow("have to be named");
  expect(() => checkExpression("success()", ["github", "matrix"])).toThrow("isn't available here");
  expect(() => checkTemplate("${{ secrets.TOKEN }} ${{ matrix.os }}", ["secrets", "matrix"])).not.toThrow();
  expect(secretsIn("a ${{ secrets.ONE }} b ${{ format('{0}', secrets['TWO']) }} ${{ matrix.os }}").sort()).toEqual(["ONE", "TWO"]);
  expect(secretsIn("secrets.THREE == 'x'", true)).toEqual(["THREE"]);
});

test("an if: without a status function only counts while nothing failed", () => {
  const ok = { success: true, failure: false, cancelled: false };
  const failed = { success: false, failure: true, cancelled: false };
  expect(holds(null, ctx, ok)).toBe(true);
  expect(holds(null, ctx, failed)).toBe(false);
  expect(holds("github.event_name == 'push'", ctx, ok)).toBe(true);
  expect(holds("github.event_name == 'push'", ctx, failed)).toBe(false);
  expect(holds("github.event_name == 'tag'", ctx, ok)).toBe(false);
  expect(holds("always()", ctx, failed)).toBe(true);
  expect(holds("failure()", ctx, failed)).toBe(true);
  expect(holds("failure() && github.event_name == 'push'", ctx, failed)).toBe(true);
  expect(holds("!cancelled()", ctx, failed)).toBe(true);
  expect(holds("success() || github.count == 3", ctx, failed)).toBe(true);
});

test("step outputs", () => {
  expect(parseOutputs("a=1\nb=x=y\n\nbad line\n1no=x\n")).toEqual({ a: "1", b: "x=y" });
  expect(parseOutputs("long<<EOF\none\ntwo\nEOF\nc=3\n")).toEqual({ long: "one\ntwo", c: "3" });
  expect(parseOutputs("open<<EOF\none\n")).toEqual({});
  expect(parseOutputs("value=a<<b")).toEqual({ value: "a<<b" });
});

test("an expression can't produce more than a few megabytes, however it nests", () => {
  const level = (inner: string) => `format('${"{0}".repeat(300)}', ${inner})`;
  const bomb = `contains(${level(level(level("'xxxxxxxx'")))}, 'y')`;
  expect(bomb.length).toBeLessThan(4096);
  const started = Date.now();
  expect(() => run(bomb)).toThrow("at most");
  expect(() => holds(bomb, ctx, { success: true, failure: false, cancelled: false })).toThrow("at most");
  // Each part alone fits; the parts of one text share the allowance.
  const part = `\${{ ${level(level(`'${"x".repeat(64)}'`))} }}`;
  expect(fillTemplate(part, ctx).length).toBe(300 * 300 * 64);
  expect(() => evalTemplate(part + part, ctx)).toThrow("at most");
  expect(Date.now() - started).toBeLessThan(2000);
  // join and toJSON count too, and toJSON can't be made to indent without end.
  expect(() => run(`join(fromJSON('[${'"x",'.repeat(500)}"x"]'), ${level(level("' '"))})`)).toThrow("at most");
  expect(() => run(`toJSON(fromJSON('${"[".repeat(100)}${"]".repeat(100)}'))`)).toThrow("nest");
  // What workflows actually do still works.
  expect(run(`format('{0}-{1}', 'a', 'b')`)).toBe("a-b");
  expect(run(`join(matrix.list, ', ')`)).toBe("a, b");
});
