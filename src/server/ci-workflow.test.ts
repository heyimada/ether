import { expect, test } from "bun:test";
import { parseWorkflow } from "./ci-workflow";

test("jobs may name an image, and job env is merged under step env", () => {
  const {
    jobs: [job],
  } = parseWorkflow(`jobs:
  deploy:
    image: ghcr.io/org/tools:1.2
    env:
      TARGET: staging
      DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}
    steps:
      - run: ./deploy
        env:
          TARGET: production
          RETRIES: 3
`);
  expect(job.image).toBe("ghcr.io/org/tools:1.2");
  expect(job.steps[0].env).toEqual({ TARGET: "production", DEPLOY_KEY: { secret: "DEPLOY_KEY" }, RETRIES: "3" });
});

test("a job without image or env still parses as before", () => {
  const [job] = parseWorkflow("jobs:\n  t:\n    steps:\n      - run: echo hi\n").jobs;
  expect(job.image).toBeNull();
  expect(job.steps[0]).toEqual({ id: null, name: "echo hi", run: "echo hi", shell: null, timeoutMinutes: 10, env: {}, if: null, continueOnError: false });
});

test("secret references need a valid name, wherever they are in a value", () => {
  const bad = (env: string) => () => parseWorkflow(`jobs:\n  t:\n    env:\n      ${env}\n    steps:\n      - run: x\n`);
  expect(bad('URL: "https://\${{ secrets.HOST }}/x"')).not.toThrow();
  expect(bad('URL: "https://\${{ secrets }}/x"')).toThrow("have to be named");
  expect(bad('URL: "\${{ secrets.lower-case }}"')).toThrow();
  expect(bad("K: ${{ secrets.lower }}")).toThrow("isn't a valid secret name");
  expect(bad("K: ${{ secrets.CI_TOKEN }}")).toThrow("isn't a valid secret name");
  expect(bad("K: ${{secrets.OK}}")).not.toThrow();
});

test("variables can't shadow what Ether sets, and values must be scalars", () => {
  const bad = (env: string) => () => parseWorkflow(`jobs:\n  t:\n    steps:\n      - run: x\n        env:\n          ${env}\n`);
  expect(bad("CI: false")).toThrow("CI and CI_*");
  expect(bad("CI_REF: main")).toThrow("CI and CI_*");
  expect(bad("1BAD: x")).toThrow("valid variable name");
  expect(bad("LIST: [1, 2]")).toThrow("string, number or boolean");
});

test("image names that could be read as CLI flags are refused", () => {
  const img = (image: string) => () => parseWorkflow(`jobs:\n  t:\n    image: "${image}"\n    steps:\n      - run: x\n`);
  expect(img("--privileged")).toThrow("container image name");
  expect(img("-v /:/host")).toThrow();
  expect(img("alpine:3.20")).not.toThrow();
});

test("jobs may name an environment, alone or with a url", () => {
  const { jobs } = parseWorkflow(`jobs:
  staging:
    environment: staging
    steps: [{ run: ./deploy }]
  prod:
    environment:
      name: production
      url: https://example.com
    steps: [{ run: ./deploy }]
  build:
    steps: [{ run: make }]
`);
  expect(jobs.map((j) => j.environment)).toEqual([{ name: "staging", url: null }, { name: "production", url: "https://example.com" }, null]);
});

test("environment names and urls are checked", () => {
  const env = (e: string) => () => parseWorkflow(`jobs:\n  t:\n    environment: ${e}\n    steps: [{ run: x }]\n`);
  expect(env('"prod env"')).toThrow("environment must be a name");
  expect(env("{ name: prod, url: javascript:alert(1) }")).toThrow("http(s) address");
  expect(env("{ name: prod, url: ftp://x }")).toThrow("http(s) address");
  expect(env("{ url: https://x }")).toThrow("environment must be a name");
  expect(env("prod.eu-1")).not.toThrow();
});


test("workflows have a name, and only the older .ether/ci.yml may leave out on:", () => {
  const legacy = parseWorkflow("jobs:\n  t:\n    steps: [{ run: x }]\n");
  expect(legacy.name).toBe("CI");
  expect(legacy.on.push?.branches).toEqual({ ignore: false, patterns: ["**"] });
  expect(() => parseWorkflow("jobs:\n  t:\n    steps: [{ run: x }]\n", ".ether/workflows/test.yml")).toThrow('needs "on"');
  const named = parseWorkflow("name: Tests\non: [push, pull_request]\njobs:\n  t:\n    steps: [{ run: x }]\n", ".ether/workflows/test.yml");
  expect(named.name).toBe("Tests");
  expect(named.on.pull_request?.types).toEqual(["opened", "synchronize", "reopened"]);
  expect(parseWorkflow("on: push\njobs:\n  t:\n    steps: [{ run: x }]\n", ".ether/workflows/lint.yaml").name).toBe("lint");
  expect(() => parseWorkflow("on: schedule\njobs:\n  t:\n    steps: [{ run: x }]\n", ".ether/workflows/x.yml")).toThrow('.ether/workflows/x.yml: on: "schedule" isn\'t supported');
});

test("runs-on takes a label or a list of them", () => {
  const wf = (runsOn: string) => parseWorkflow(`on: push\njobs:\n  a:\n    runs-on: ${runsOn}\n    steps: [{ run: x }]\n`, ".ether/workflows/t.yml").jobs[0].runsOn;
  expect(wf("gpu")).toEqual(["gpu"]);
  expect(wf("[linux, gpu, linux]")).toEqual(["linux", "gpu"]);
  expect(parseWorkflow("on: push\njobs:\n  a:\n    steps: [{ run: x }]\n", ".ether/workflows/t.yml").jobs[0].runsOn).toEqual([]);
  expect(wf("'${{ matrix.os }}'")).toEqual(["${{ matrix.os }}"]);
  expect(() => wf("'${{ steps.a.outputs.b }}'")).toThrow('"steps" isn\'t available here');
  expect(() => wf("'${{ secrets.A }}'")).toThrow('"secrets" isn\'t available here');
  expect(() => wf("[a b]")).toThrow("runs-on must be");
});

test("steps and outputs are checked when the workflow is read", () => {
  const wf = (steps: string, more = "") => parseWorkflow(`on: push\njobs:\n  a:\n${more}    steps:\n${steps}`, ".ether/workflows/t.yml").jobs[0];
  const job = wf("      - id: build\n        name: on ${{ matrix.os }}\n        if: ${{ github.ref == 'x' }}\n        continue-on-error: true\n        run: echo ${{ github.sha }}\n");
  expect(job.steps[0]).toMatchObject({ id: "build", name: "on ${{ matrix.os }}", if: "github.ref == 'x'", continueOnError: true, run: "echo ${{ github.sha }}" });
  expect(wf("      - run: echo ${{ github.sha }} and more\n").steps[0].name).toBe("echo … and more");
  expect(wf("      - run: x\n", "    outputs:\n      v: ${{ steps.b.outputs.v }}\n").outputs).toEqual({ v: "${{ steps.b.outputs.v }}" });
  expect(() => wf("      - run: echo ${{ nope.x }}\n")).toThrow('"nope" isn\'t available here');
  expect(() => wf("      - run: echo ${{ 1 == }}\n")).toThrow("Step 1 of");
  expect(() => wf("      - run: x\n        if: 1 ==\n")).toThrow("if:");
  expect(() => wf("      - run: x\n        id: a b\n")).toThrow("id must be");
  expect(() => wf("      - run: x\n        id: a\n      - run: y\n        id: a\n")).toThrow("already a step");
  expect(() => wf("      - run: x\n", "    outputs:\n      a b: x\n")).toThrow("isn't a valid output name");
});
