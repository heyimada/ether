import { expect, test } from "bun:test";
import { parseWorkflow } from "./ci-workflow";

test("jobs may name an image, and job env is merged under step env", () => {
  const [job] = parseWorkflow(`jobs:
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
  const [job] = parseWorkflow("jobs:\n  t:\n    steps:\n      - run: echo hi\n");
  expect(job.image).toBeNull();
  expect(job.steps[0]).toEqual({ name: "echo hi", run: "echo hi", shell: null, timeoutMinutes: 10, env: {} });
});

test("secret references must be whole values with a valid name", () => {
  const bad = (env: string) => () => parseWorkflow(`jobs:\n  t:\n    env:\n      ${env}\n    steps:\n      - run: x\n`);
  expect(bad('URL: "https://\${{ secrets.HOST }}/x"')).toThrow("plain value or exactly");
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
