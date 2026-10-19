import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { baseURL, createRepo, createUser, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

// A throwaway key pair on disk, and a git that uses only it over Ether's SSH port.
function sshIdentity() {
  const dir = mkdtempSync(join(tmpdir(), "ether-ssh-"));
  const keys = ssh2.utils.generateKeyPairSync("ed25519");
  const keyFile = join(dir, "id_ed25519");
  writeFileSync(keyFile, keys.private, { mode: 0o600 });
  const empty = join(dir, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "SSH",
    GIT_AUTHOR_EMAIL: "ssh@ether.test",
    GIT_COMMITTER_NAME: "SSH",
    GIT_COMMITTER_EMAIL: "ssh@ether.test",
    GIT_SSH_COMMAND: `ssh -i "${keyFile.replace(/\\/g, "/")}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR`,
  };
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    return { code: r.status ?? -1, err: r.stderr };
  };
  return { publicKey: keys.public, git };
}

const sshUrl = (owner: string, repo: string) => `ssh://git@127.0.0.1:${process.env.ETHER_SSH_PORT}/${owner}/${repo}.git`;

test("people add SSH keys in Settings and use git over SSH with their repository permissions", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const reader = await createUser(admin);
  const stranger = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("ssh"));
  await owner.ctx.put(`/api/repos/${owner.username}/${repo}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });

  const mine = sshIdentity();
  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/settings`);
  await page.getByLabel("Key title").fill("Laptop");
  await page.getByLabel("Public key").fill(mine.publicKey);
  await page.getByRole("button", { name: "Add SSH key" }).click();
  const keys = page.getByRole("list", { name: "SSH keys" });
  await expect(keys).toContainText("Laptop");
  await expect(keys).toContainText("SHA256:");
  await info.attach("ssh-keys", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // The repository page offers the SSH clone URL.
  await page.goto(`${baseURL()}/${owner.username}/${repo}`);
  await page.getByRole("tab", { name: "SSH" }).click();
  await expect(page.getByRole("textbox", { name: "Clone URL" })).toHaveValue(sshUrl(owner.username, repo));

  // Clone, commit and push over SSH.
  const work = workdir();
  const cloned = mine.git(work, ["clone", "-q", sshUrl(owner.username, repo), "w"]);
  expect(cloned.code, cloned.err).toBe(0);
  const dir = join(work, "w");
  writeFileSync(join(dir, "hello.txt"), "over ssh\n");
  mine.git(dir, ["add", "-A"]);
  mine.git(dir, ["commit", "-q", "-m", "first over ssh"]);
  const pushed = mine.git(dir, ["push", "-q", "origin", "HEAD:main"]);
  expect(pushed.code, pushed.err).toBe(0);
  const tree = await (await owner.ctx.get(`/api/repos/${owner.username}/${repo}/tree?ref=main`)).json();
  expect(tree.entries.map((e: { name: string }) => e.name)).toContain("hello.txt");

  // A reader's key can fetch but not push; a stranger's key sees nothing.
  const theirs = sshIdentity();
  expect((await reader.ctx.post("/api/me/ssh-keys", { data: { title: "r", key: theirs.publicKey }, headers: headers() })).ok()).toBe(true);
  const rwork = workdir();
  expect(theirs.git(rwork, ["clone", "-q", sshUrl(owner.username, repo), "w"]).code).toBe(0);
  writeFileSync(join(rwork, "w", "x.txt"), "x\n");
  theirs.git(join(rwork, "w"), ["add", "-A"]);
  theirs.git(join(rwork, "w"), ["commit", "-q", "-m", "x"]);
  expect(theirs.git(join(rwork, "w"), ["push", "-q", "origin", "HEAD:main"]).code).not.toBe(0);
  const outsider = sshIdentity();
  await stranger.ctx.post("/api/me/ssh-keys", { data: { title: "s", key: outsider.publicKey }, headers: headers() });
  expect(outsider.git(workdir(), ["clone", "-q", sshUrl(owner.username, repo), "w"]).code).not.toBe(0);
  // Unregistered keys are refused, and a key can belong to one account only.
  expect(sshIdentity().git(workdir(), ["clone", "-q", sshUrl(owner.username, repo), "w"]).code).not.toBe(0);
  expect((await stranger.ctx.post("/api/me/ssh-keys", { data: { title: "dup", key: mine.publicKey }, headers: headers() })).status()).toBe(409);
  expect((await stranger.ctx.post("/api/me/ssh-keys", { data: { title: "junk", key: "ssh-rsa not-a-key" }, headers: headers() })).status()).toBe(400);

  // Removing the key cuts access.
  await page.goto(`${baseURL()}/settings`);
  await page.getByRole("list", { name: "SSH keys" }).getByRole("button", { name: "Remove Laptop" }).click();
  await expect(page.getByRole("list", { name: "SSH keys" })).toHaveCount(0);
  expect(mine.git(workdir(), ["clone", "-q", sshUrl(owner.username, repo), "again"]).code).not.toBe(0);
  expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("over ssh\n");
});
