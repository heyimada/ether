import { expect, test } from "bun:test";
import { conditionHolds, parseCondition, parseStrategy } from "./ci-graph";
import { parseWorkflow } from "./ci-workflow";

const wf = (jobs: string) => parseWorkflow(`on: push\njobs:\n${jobs}`, ".ether/workflows/t.yml");

test("needs must name jobs of the workflow, without loops", () => {
  const { jobs } = wf("  build:\n    steps: [{ run: make }]\n  test:\n    needs: build\n    steps: [{ run: make test }]\n  ship:\n    needs: [build, test]\n    steps: [{ run: ship }]\n");
  expect(jobs.map((j) => [j.key, j.needs])).toEqual([["build", []], ["test", ["build"]], ["ship", ["build", "test"]]]);
  expect(() => wf("  a:\n    needs: nope\n    steps: [{ run: x }]\n")).toThrow('needs "nope", which isn\'t a job');
  expect(() => wf("  a:\n    needs: b\n    steps: [{ run: x }]\n  b:\n    needs: c\n    steps: [{ run: x }]\n  c:\n    needs: a\n    steps: [{ run: x }]\n")).toThrow("a → b → c → a");
  expect(() => wf("  a:\n    needs: a\n    steps: [{ run: x }]\n")).toThrow("loop");
});

test("if takes the status functions, plain, negated or in ${{ }}", () => {
  expect(parseCondition("always()", "j")).toBe("always()");
  expect(parseCondition("${{ !cancelled() }}", "j")).toBe("!cancelled()");
  expect(parseCondition(" failure() ", "j")).toBe("failure()");
  expect(() => parseCondition("github.ref == 'refs/heads/main'", "j")).toThrow("aren't supported yet");
  expect(() => parseCondition("success() && failure()", "j")).toThrow("aren't supported yet");
});

test("without if a job runs only when all its needs succeeded", () => {
  expect(conditionHolds(null, [])).toBe(true);
  expect(conditionHolds(null, ["success", "success"])).toBe(true);
  expect(conditionHolds(null, ["success", "skipped"])).toBe(false);
  expect(conditionHolds(null, ["failure"])).toBe(false);
  expect(conditionHolds("failure()", ["success", "error"])).toBe(true);
  expect(conditionHolds("failure()", ["success", "cancelled"])).toBe(false);
  expect(conditionHolds("always()", ["failure", "cancelled"])).toBe(true);
  expect(conditionHolds("!cancelled()", ["failure"])).toBe(true);
  expect(conditionHolds("!failure()", ["failure"])).toBe(false);
});

test("a matrix is the product of its lists, minus excludes, plus includes", () => {
  const s = parseStrategy(
    {
      matrix: {
        os: ["linux", "windows"],
        bun: ["1.3", 1.4],
        exclude: [{ os: "windows", bun: "1.3" }],
        include: [{ os: "linux", experimental: true }, { os: "mac", bun: "1.4" }],
      },
    },
    "j",
  )!;
  expect(s.combos).toEqual([
    { os: "linux", bun: "1.3", experimental: "true" },
    { os: "linux", bun: "1.4", experimental: "true" },
    { os: "windows", bun: "1.4" },
    { os: "mac", bun: "1.4" },
  ]);
  expect(s.failFast).toBe(true);
  expect(parseStrategy({ matrix: { include: [{ a: 1 }, { a: 2 }] }, "fail-fast": false, "max-parallel": 1 }, "j")).toEqual({ combos: [{ a: "1" }, { a: "2" }], failFast: false, maxParallel: 1 });
  expect(() => parseStrategy({ matrix: { a: [] } }, "j")).toThrow("non-empty list");
  expect(() => parseStrategy({ matrix: { a: [{ x: 1 }] } }, "j")).toThrow("strings, numbers or booleans");
  expect(() => parseStrategy({ matrix: { a: [1], exclude: [{ a: 1 }] } }, "j")).toThrow("no combinations");
  expect(() => parseStrategy({ matrix: { a: Array.from({ length: 20 }, (_, i) => i), b: Array.from({ length: 20 }, (_, i) => i) } }, "j")).toThrow("at most 256");
  expect(() => parseStrategy({ matrix: { "a-b": [1], a_b: [2] } }, "j")).toThrow("both become CI_MATRIX_A_B");
});

test("matrix jobs are named by their values and share their workflow key", () => {
  const { jobs } = wf("  test:\n    name: Unit\n    strategy:\n      matrix:\n        bun: ['1.3', '1.4']\n    steps: [{ run: bun test }]\n  lint:\n    needs: test\n    steps: [{ run: x }]\n");
  expect(jobs.map((j) => [j.key, j.name, j.matrix])).toEqual([
    ["test", "Unit (1.3)", { bun: "1.3" }],
    ["test", "Unit (1.4)", { bun: "1.4" }],
    ["lint", "lint", {}],
  ]);
  expect(() => wf(`  t:\n    strategy:\n      matrix:\n        a: [${Array.from({ length: 101 }, (_, i) => i).join(", ")}]\n    steps: [{ run: x }]\n`)).toThrow("a run can have at most 100");
});
