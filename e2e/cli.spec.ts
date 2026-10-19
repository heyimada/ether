import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseURL, createUser, loginAdmin, unique } from "./helpers";

const root = join(import.meta.dirname, "..");
const bin = join(root, "cli", "target", "release", process.platform === "win32" ? "ether.exe" : "ether");

// Isolated from the developer's own git and ether configuration.
function runner(configDir: string) {
  const emptyGitConfig = join(configDir, "empty.gitconfig");
  writeFileSync(emptyGitConfig, "");
  const env = {
    ...process.env,
    ETHER_CONFIG_DIR: configDir,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_AUTHOR_NAME: "CLI",
    GIT_AUTHOR_EMAIL: "cli@ether.test",
    GIT_COMMITTER_NAME: "CLI",
    GIT_COMMITTER_EMAIL: "cli@ether.test",
  };
  const ether = (args: string[], opts: { cwd?: string; input?: string } = {}) => {
    const r = spawnSync(bin, args, { cwd: opts.cwd ?? configDir, env, input: opts.input, encoding: "utf8" });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  const ok = (args: string[], opts: { cwd?: string; input?: string } = {}) => {
    const r = ether(args, opts);
    if (r.code !== 0) throw new Error(`ether ${args.join(" ")} failed (${r.code}):\n${r.err}${r.out}`);
    return r.out;
  };
  const gitOk = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr}`);
    return r.stdout;
  };
  return { ether, ok, gitOk };
}

test.beforeAll(async () => {
  test.setTimeout(15 * 60 * 1000);
  const build = spawnSync("cargo", ["build", "--release", "--quiet"], { cwd: join(root, "cli"), encoding: "utf8" });
  if (build.status !== 0) throw new Error(`cargo build failed:\n${build.stderr}`);
  expect(existsSync(bin)).toBe(true);
});

test("the ether CLI logs in, manages repositories, issues and pull requests, and works as a git credential helper", async () => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  const home = mkdtempSync(join(tmpdir(), "ether-cli-"));
  const { ether, ok, gitOk } = runner(home);

  // A wrong token is refused and nothing is saved.
  expect(ether(["auth", "login", "--host", baseURL(), "--with-token"], { input: "eth_not-a-real-token\n" }).code).not.toBe(0);
  expect(ether(["auth", "status"]).code).not.toBe(0);

  expect(ok(["auth", "login", "--host", baseURL(), "--with-token"], { input: `${me.token}\n` })).toContain(`Logged in to ${baseURL()} as ${me.username}`);
  expect(ok(["auth", "status"])).toContain(me.username);

  const repo = unique("cli");
  expect(ok(["repo", "create", repo, "--description", "made from the CLI", "--public"])).toContain(`${me.username}/${repo}`);
  expect(ok(["repo", "list"])).toContain(`${me.username}/${repo}`);
  const view = JSON.parse(ok(["repo", "view", `${me.username}/${repo}`, "--json"]));
  expect(view.repo).toMatchObject({ name: repo, description: "made from the CLI", visibility: "public" });

  // Clone sets up the credential helper, so plain git push works afterwards.
  const work = mkdtempSync(join(tmpdir(), "ether-cli-work-"));
  ok(["repo", "clone", `${me.username}/${repo}`, "w"], { cwd: work });
  const dir = join(work, "w");
  writeFileSync(join(dir, "README.md"), "# from the CLI\n");
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", "first"]);
  gitOk(dir, ["branch", "-M", "main"]);
  gitOk(dir, ["push", "-q", "origin", "main"]);

  // Issues, with the repository inferred from the clone's origin.
  expect(ok(["issue", "create", "--title", "Filed from the terminal", "--body", "It works"], { cwd: dir })).toMatch(/#1\b/);
  expect(ok(["issue", "list"], { cwd: dir })).toContain("Filed from the terminal");
  ok(["issue", "comment", "1", "--body", "Following up"], { cwd: dir });
  expect(ok(["issue", "view", "1"], { cwd: dir })).toContain("Following up");
  ok(["issue", "close", "1"], { cwd: dir });
  expect(ok(["issue", "list"], { cwd: dir })).not.toContain("Filed from the terminal");
  expect(ok(["issue", "list", "--state", "closed", "-R", `${me.username}/${repo}`])).toContain("Filed from the terminal");

  // A pull request from a pushed branch, merged from the CLI.
  gitOk(dir, ["checkout", "-q", "-b", "feature/cli"]);
  writeFileSync(join(dir, "feature.txt"), "feature\n");
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", "feature"]);
  gitOk(dir, ["push", "-q", "origin", "feature/cli"]);
  expect(ok(["pr", "create", "--base", "main", "--title", "Add the feature"], { cwd: dir })).toMatch(/#2\b/);
  expect(ok(["pr", "list"], { cwd: dir })).toContain("Add the feature");
  expect(ok(["pr", "view", "2"], { cwd: dir })).toContain("feature/cli");
  ok(["pr", "merge", "2"], { cwd: dir });
  expect(JSON.parse(ok(["pr", "view", "2", "--json"], { cwd: dir })).pull.state).toBe("merged");
  gitOk(dir, ["fetch", "-q", "origin"]);
  expect(gitOk(dir, ["show", "origin/main:feature.txt"])).toBe("feature\n");

  // Raw API access for anything else.
  expect(JSON.parse(ok(["api", "/api/me"])).user.username).toBe(me.username);

  ok(["auth", "logout"]);
  expect(ether(["auth", "status"]).code).not.toBe(0);
});
