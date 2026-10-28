import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
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
  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync("git", args, { cwd, env: { ...env, ...extra }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

test("Settings shows the SSH host key fingerprint that ssh itself sees", async ({ page }) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  await uiLogin(page, me.username, me.password);
  await page.goto(`${baseURL()}/settings`);
  const shown = (await page.getByLabel("Host key fingerprint").textContent())?.trim();
  expect(shown).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  const scan = spawnSync("ssh-keyscan", ["-t", "ed25519", "-p", String(process.env.ETHER_SSH_PORT), "127.0.0.1"], { encoding: "utf8" });
  const listed = spawnSync("ssh-keygen", ["-lf", "-"], { input: scan.stdout, encoding: "utf8" });
  expect(listed.stdout).toContain(shown);
});

test("git over SSH speaks protocol v2 when asked and still serves v0", async () => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("sshv2"));
  const me = sshIdentity();
  await owner.ctx.post("/api/me/ssh-keys", { data: { title: "k", key: me.publicKey }, headers: headers() });
  const work = workdir();
  me.git(work, ["init", "-q", "-b", "main", "w"]);
  writeFileSync(join(work, "w", "a.txt"), "a\n");
  me.git(join(work, "w"), ["add", "-A"]);
  me.git(join(work, "w"), ["commit", "-q", "-m", "a"]);
  const pushed = me.git(join(work, "w"), ["push", "-q", sshUrl(owner.username, repo), "main"]);
  expect(pushed.code, pushed.err).toBe(0);

  const v2 = me.git(work, ["-c", "protocol.version=2", "ls-remote", sshUrl(owner.username, repo)], { GIT_TRACE_PACKET: "1" });
  expect(v2.code, v2.err).toBe(0);
  expect(v2.err).toContain("< version 2");
  const cloned = me.git(work, ["-c", "protocol.version=2", "clone", "-q", sshUrl(owner.username, repo), "v2"]);
  expect(cloned.code, cloned.err).toBe(0);
  expect(readFileSync(join(work, "v2", "a.txt"), "utf8")).toBe("a\n");

  const v0 = me.git(work, ["-c", "protocol.version=0", "ls-remote", sshUrl(owner.username, repo)], { GIT_TRACE_PACKET: "1" });
  expect(v0.code, v0.err).toBe(0);
  expect(v0.err).not.toContain("< version 2");
});

test("a large incompressible push and clone stream through SSH intact", async () => {
  test.setTimeout(10 * 60_000);
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("sshbig"));
  const me = sshIdentity();
  await owner.ctx.post("/api/me/ssh-keys", { data: { title: "k", key: me.publicKey }, headers: headers() });
  const src = workdir();
  me.git(src, ["init", "-q", "-b", "main"]);
  const fd = openSync(join(src, "blob.bin"), "w");
  const hash = createHash("sha256");
  for (let i = 0; i < 100; i++) {
    const chunk = randomBytes(1024 * 1024);
    hash.update(chunk);
    writeSync(fd, chunk);
  }
  closeSync(fd);
  me.git(src, ["add", "blob.bin"]);
  me.git(src, ["commit", "-q", "-m", "big"]);
  const pushed = me.git(src, ["push", "-q", sshUrl(owner.username, repo), "main"]);
  expect(pushed.code, pushed.err).toBe(0);

  const dst = workdir();
  const cloned = me.git(dst, ["clone", "-q", sshUrl(owner.username, repo), "out"]);
  expect(cloned.code, cloned.err).toBe(0);
  const actual = createHash("sha256");
  for await (const chunk of createReadStream(join(dst, "out", "blob.bin"))) actual.update(chunk);
  expect(actual.digest("hex")).toBe(hash.digest("hex"));
});

test("deploy keys reach one repository with their own role, managed by its owners", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const writer = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("deploy"));
  const other = await createRepo(owner.ctx, unique("other"));
  await owner.ctx.put(`/api/repos/${owner.username}/${repo}/collaborators/${writer.username}`, { data: { role: "write" }, headers: headers() });

  // Seed the repository with a personal key.
  const mine = sshIdentity();
  await owner.ctx.post("/api/me/ssh-keys", { data: { title: "me", key: mine.publicKey }, headers: headers() });
  const seed = workdir();
  mine.git(seed, ["init", "-q", "-b", "main", "w"]);
  writeFileSync(join(seed, "w", "a.txt"), "a\n");
  mine.git(join(seed, "w"), ["add", "-A"]);
  mine.git(join(seed, "w"), ["commit", "-q", "-m", "a"]);
  expect(mine.git(join(seed, "w"), ["push", "-q", sshUrl(owner.username, repo), "main"]).code).toBe(0);

  // The owner adds a read-only deploy key in the repository's Settings.
  const reader = sshIdentity();
  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}/settings`);
  await page.getByLabel("Deploy key title").fill("Build server");
  await page.getByLabel("Deploy public key").fill(reader.publicKey);
  await page.getByRole("button", { name: "Add deploy key" }).click();
  const list = page.getByRole("list", { name: "Deploy keys" });
  await expect(list).toContainText("Build server");
  await expect(list).toContainText("SHA256:");
  await expect(list.getByText("read", { exact: true })).toBeVisible();
  await info.attach("deploy-keys", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // It clones this repository, can't push to it, and sees no other repository.
  const work = workdir();
  const cloned = reader.git(work, ["clone", "-q", sshUrl(owner.username, repo), "w"]);
  expect(cloned.code, cloned.err).toBe(0);
  writeFileSync(join(work, "w", "b.txt"), "b\n");
  reader.git(join(work, "w"), ["add", "-A"]);
  reader.git(join(work, "w"), ["commit", "-q", "-m", "b"]);
  const refused = reader.git(join(work, "w"), ["push", "-q", "origin", "HEAD:main"]);
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("you need write access");
  expect(reader.git(workdir(), ["clone", "-q", sshUrl(owner.username, other), "o"]).code).not.toBe(0);

  // A key with write access pushes.
  const pusher = sshIdentity();
  expect((await owner.ctx.post(`/api/repos/${owner.username}/${repo}/deploy-keys`, { data: { title: "Release bot", key: pusher.publicKey, write: true }, headers: headers() })).ok()).toBe(true);
  const pwork = workdir();
  expect(pusher.git(pwork, ["clone", "-q", sshUrl(owner.username, repo), "w"]).code).toBe(0);
  writeFileSync(join(pwork, "w", "c.txt"), "c\n");
  pusher.git(join(pwork, "w"), ["add", "-A"]);
  pusher.git(join(pwork, "w"), ["commit", "-q", "-m", "c"]);
  const pushed = pusher.git(join(pwork, "w"), ["push", "-q", "origin", "HEAD:main"]);
  expect(pushed.code, pushed.err).toBe(0);
  const tree = await (await owner.ctx.get(`/api/repos/${owner.username}/${repo}/tree?ref=main`)).json();
  expect(tree.entries.map((e: { name: string }) => e.name)).toContain("c.txt");
  // The feed shows the push as made by whoever added the key.
  const { events } = await (await owner.ctx.get("/api/feed")).json();
  const push = events.find((e: { repo: string; kind: string; payload: { shown: { subject: string }[] } }) => e.repo === repo && e.kind === "push" && e.payload.shown.some((c) => c.subject === "c"));
  expect(push?.actor).toBe(owner.username);

  // Keys are unique across accounts and repositories, and only owners manage deploy keys.
  expect((await owner.ctx.post(`/api/repos/${owner.username}/${other}/deploy-keys`, { data: { title: "again", key: reader.publicKey }, headers: headers() })).status()).toBe(409);
  expect((await writer.ctx.post("/api/me/ssh-keys", { data: { title: "stolen", key: reader.publicKey }, headers: headers() })).status()).toBe(409);
  expect((await owner.ctx.post(`/api/repos/${owner.username}/${repo}/deploy-keys`, { data: { title: "mine", key: mine.publicKey }, headers: headers() })).status()).toBe(409);
  expect((await writer.ctx.get(`/api/repos/${owner.username}/${repo}/deploy-keys`)).status()).toBe(403);
  expect((await writer.ctx.post(`/api/repos/${owner.username}/${repo}/deploy-keys`, { data: { title: "w", key: sshIdentity().publicKey }, headers: headers() })).status()).toBe(403);

  // Removing a deploy key cuts its access.
  await page.reload();
  await page.getByRole("list", { name: "Deploy keys" }).getByRole("button", { name: "Remove Build server" }).click();
  await expect(page.getByRole("list", { name: "Deploy keys" })).not.toContainText("Build server");
  expect(reader.git(workdir(), ["clone", "-q", sshUrl(owner.username, repo), "again"]).code).not.toBe(0);
});
