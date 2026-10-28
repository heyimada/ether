import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArgs, envScript, execArgs, IMAGE_RE, shellCommand } from "./ci-container";

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

test("job variables never reach the CLI: exec carries no values and no --env", () => {
  const args = execArgs("c1", ["sh", "-e", "-c", "echo hi"]);
  expect(args).not.toContain("--env");
  expect(args.slice(0, 4)).toEqual(["exec", "--workdir", "/workspace", "c1"]);
  expect(args.slice(-4)).toEqual(["sh", "-e", "-c", "echo hi"]);
});

test("the variables file round-trips any value through a real shell, including quotes, $(…) and newlines", () => {
  const vars = { PLAIN: "x", QUOTES: `it's "quoted" \\ back`, SUBST: "$(touch /tmp/pwned) `id` $HOME", MULTI: "line one\nline two\n", EMPTY: "", DOCKER_HOST: "ssh://evil" };
  const dir = mkdtempSync(join(tmpdir(), "ether-env-test-"));
  const file = join(dir, "env");
  writeFileSync(file, envScript(vars));
  try {
    for (const [name, value] of Object.entries(vars)) {
      const out = spawnSync("sh", ["-c", `. "$0" && printf %s "$${name}"`, file], { encoding: "utf8", env: {} });
      expect(out.stdout).toBe(value);
    }
    expect(existsSync("/tmp/pwned")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(() => envScript({ "BAD NAME": "x" })).toThrow();
  expect(() => envScript({ NUL: "a\0b" })).toThrow("NUL");
});

test("steps default to bash when the image has it, and Windows shells are refused", () => {
  expect(shellCommand(null, "echo $1").at(-1)).toBe("echo $1");
  expect(shellCommand("bash", "x")).toEqual(["bash", "-e", "-c", "x"]);
  expect(() => shellCommand("cmd", "x")).toThrow("isn't available in a container");
  expect(() => shellCommand("powershell", "x")).toThrow();
});
