import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chownWorkspaceArgs, collect, createArgs, envScript, execArgs, IMAGE_RE, instanceLabel, shellCommand } from "./ci-container";

test("containers are created locked down and idle, without mounting anything from the host", () => {
  const args = createArgs("ether-ci-1-2", "oven/bun:1", "abc123");
  expect(args[0]).toBe("create");
  for (const flag of ["no-new-privileges", "NET_RAW", "--memory", "--cpus", "--pids-limit"]) expect(args).toContain(flag);
  for (const flag of ["-v", "--volume", "--mount", "--privileged", "--network=host", "--pid"]) expect(args).not.toContain(flag);
  expect(args.slice(-3)).toEqual(["oven/bun:1", "-f", "/dev/null"]);
  expect(args).toContain("ether.ci.instance=abc123");
});

test("each data folder gets its own stable instance label", () => {
  expect(instanceLabel("/srv/ether/prod")).toBe(instanceLabel("/srv/ether/prod"));
  expect(instanceLabel("/srv/ether/prod")).not.toBe(instanceLabel("/srv/ether/staging"));
  expect(instanceLabel("/x")).toMatch(/^[0-9a-f]{16}$/);
});

test("image names can't smuggle in flags or odd characters", () => {
  for (const ok of ["alpine", "alpine:3.20", "ghcr.io/org/img:1.2", "debian@sha256:abc123"]) expect(IMAGE_RE.test(ok)).toBe(true);
  for (const bad of ["--privileged", "-v/:/host", "Alpine", "a b", "img;rm", ""]) {
    expect(IMAGE_RE.test(bad)).toBe(false);
    expect(() => createArgs("x", bad, "abc123")).toThrow();
  }
});

test("job variables never reach the CLI: exec carries no values and no --env, only stdin", () => {
  const args = execArgs("c1", ["sh", "-e", "-c", "echo hi"]);
  expect(args).not.toContain("--env");
  expect(args.slice(0, 5)).toEqual(["exec", "--interactive", "--workdir", "/workspace", "c1"]);
  expect(args.slice(-4)).toEqual(["sh", "-e", "-c", "echo hi"]);
});

test("the exec wrapper evaluates the variables from stdin and gives the step an empty stdin", () => {
  const args = execArgs("c1", ["sh", "-c", 'printf "%s|" "$TOKEN" "$MULTI"; cat; echo end']);
  const wrapper = args.slice(args.indexOf("c1") + 1);
  const out = spawnSync(wrapper[0], wrapper.slice(1), { input: envScript({ TOKEN: "t'o$k", MULTI: "a\nb" }), encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(out.stdout).toBe("t'o$k|a\nb|end\n");
});

test("the checkout is handed to the image's user as root, inside the container only", () => {
  expect(chownWorkspaceArgs("c1", "101:101")).toEqual(["exec", "--user", "0", "c1", "chown", "-R", "101:101", "/workspace"]);
});

test("the variables script round-trips any value through a real shell, including quotes, $(…) and newlines", () => {
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

// sh stands in for docker here: what matters is how the call treats a command it can't trust.
test("a container call that never returns is killed at its timeout without blocking the event loop", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const started = Date.now();
  const res = await collect("sh", ["-c", "sleep 30"], 300);
  clearInterval(timer);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(res.code).not.toBe(0);
  expect(ticks).toBeGreaterThan(5);
});

test("endless output is drained and capped instead of stalling the call", async () => {
  const res = await collect("sh", ["-c", "yes ether"], 500, 1000);
  expect(res.output.length).toBe(1000);
  expect(res.code).not.toBe(0);
  expect(await collect("sh", ["-c", "echo 101:101; echo noise >&2"], 5000)).toEqual({ code: 0, output: expect.stringContaining("101:101") });
});

