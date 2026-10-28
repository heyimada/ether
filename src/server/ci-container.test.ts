import { expect, test } from "bun:test";
import { createArgs, execArgs, IMAGE_RE, shellCommand } from "./ci-container";

test("containers are created locked down and idle, without mounting anything from the host", () => {
  const args = createArgs("ether-ci-1-2", "oven/bun:1");
  expect(args[0]).toBe("create");
  for (const flag of ["no-new-privileges", "NET_RAW", "--memory", "--cpus", "--pids-limit"]) expect(args).toContain(flag);
  for (const flag of ["-v", "--volume", "--mount", "--privileged", "--network=host", "--pid"]) expect(args).not.toContain(flag);
  expect(args.slice(-3)).toEqual(["oven/bun:1", "-f", "/dev/null"]);
});

test("image names can't smuggle in flags or odd characters", () => {
  for (const ok of ["alpine", "alpine:3.20", "ghcr.io/org/img:1.2", "debian@sha256:abc123"]) expect(IMAGE_RE.test(ok)).toBe(true);
  for (const bad of ["--privileged", "-v/:/host", "Alpine", "a b", "img;rm", ""]) {
    expect(IMAGE_RE.test(bad)).toBe(false);
    expect(() => createArgs("x", bad)).toThrow();
  }
});

test("variables are passed by name only, never with their values", () => {
  const args = execArgs("c1", ["CI", "DEPLOY_KEY"], ["sh", "-e", "-c", "echo hi"]);
  expect(args).toEqual(["exec", "--workdir", "/workspace", "--env", "CI", "--env", "DEPLOY_KEY", "c1", "sh", "-e", "-c", "echo hi"]);
  expect(args.join(" ")).not.toContain("=");
});

test("steps default to bash when the image has it, and Windows shells are refused", () => {
  expect(shellCommand(null, "echo $1").at(-1)).toBe("echo $1");
  expect(shellCommand("bash", "x")).toEqual(["bash", "-e", "-c", "x"]);
  expect(() => shellCommand("cmd", "x")).toThrow("isn't available in a container");
  expect(() => shellCommand("powershell", "x")).toThrow();
});
