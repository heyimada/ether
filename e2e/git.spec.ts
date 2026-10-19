import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, openSync, readFileSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ADMIN, baseURL, cloneUrl, createRepo, createToken, createUser, git, gitOk, loginAdmin, unique, workdir } from "./helpers";

async function adminWithToken() {
  const ctx = await loginAdmin();
  return { ctx, auth: { username: ADMIN.username, token: await createToken(ctx) } };
}

function seed(dir: string, files: Record<string, string>) {
  gitOk(dir, ["init", "-q"]);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", "initial commit"]);
}

test("push then clone round-trips repository contents", async () => {
  const { ctx, auth } = await adminWithToken();
  const repo = await createRepo(ctx);
  const src = workdir();
  seed(src, { "README.md": "# round trip\n", "data.txt": "line one\nline two\n" });
  gitOk(src, ["push", cloneUrl("admin", repo), "main"], auth);

  const dst = workdir();
  gitOk(dst, ["clone", "-q", cloneUrl("admin", repo), "out"], auth);
  expect(readFileSync(join(dst, "out", "data.txt"), "utf8")).toBe("line one\nline two\n");
  expect(gitOk(join(dst, "out"), ["rev-parse", "HEAD"])).toBe(gitOk(src, ["rev-parse", "HEAD"]));

  // Incremental fetch after a second push exercises negotiation with existing haves.
  writeFileSync(join(src, "data.txt"), "line one\nline two\nline three\n");
  gitOk(src, ["commit", "-qam", "second"]);
  gitOk(src, ["push", cloneUrl("admin", repo), "main"], auth);
  gitOk(join(dst, "out"), ["pull", "-q", "origin", "main"], auth);
  expect(readFileSync(join(dst, "out", "data.txt"), "utf8")).toContain("line three");
});

test("a first push of a non-main branch becomes the default branch", async () => {
  const { ctx, auth } = await adminWithToken();
  const repo = await createRepo(ctx);
  const src = workdir();
  seed(src, { "a.txt": "a\n" });
  gitOk(src, ["branch", "-m", "trunk"]);
  gitOk(src, ["push", cloneUrl("admin", repo), "trunk"], auth);

  const info = await (await ctx.get(`/api/repos/admin/${repo}`)).json();
  expect(info.repo.defaultBranch).toBe("trunk");
  const dst = workdir();
  gitOk(dst, ["clone", "-q", cloneUrl("admin", repo), "out"], auth);
  expect(existsSync(join(dst, "out", "a.txt"))).toBe(true);
});

test("a large incompressible push streams through and clones back intact", async () => {
  test.setTimeout(10 * 60_000);
  const { ctx, auth } = await adminWithToken();
  const repo = await createRepo(ctx);
  const src = workdir();
  gitOk(src, ["init", "-q"]);

  // 200 MiB is above Bun's default 128 MiB request body cap.
  const fd = openSync(join(src, "blob.bin"), "w");
  const hash = createHash("sha256");
  for (let i = 0; i < 200; i++) {
    const chunk = randomBytes(1024 * 1024);
    hash.update(chunk);
    writeSync(fd, chunk);
  }
  closeSync(fd);
  const expected = hash.digest("hex");
  gitOk(src, ["add", "blob.bin"]);
  gitOk(src, ["commit", "-q", "-m", "big"]);
  gitOk(src, ["push", cloneUrl("admin", repo), "main"], auth);

  const dst = workdir();
  gitOk(dst, ["clone", "-q", cloneUrl("admin", repo), "out"], auth);
  const actual = createHash("sha256");
  for await (const chunk of createReadStream(join(dst, "out", "blob.bin"))) actual.update(chunk);
  expect(actual.digest("hex")).toBe(expected);
});

test("anonymous clone is challenged for credentials", async () => {
  const { ctx } = await adminWithToken();
  const repo = await createRepo(ctx);

  const res = await fetch(`${cloneUrl("admin", repo)}/info/refs?service=git-upload-pack`);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);

  const dst = workdir();
  expect(git(dst, ["clone", "-q", cloneUrl("admin", repo), "out"]).code).not.toBe(0);
});

test("a bad token is rejected and account passwords are not accepted for git", async () => {
  const { ctx } = await adminWithToken();
  const repo = await createRepo(ctx);
  const dst = workdir();
  expect(git(dst, ["clone", "-q", cloneUrl("admin", repo), "a"], { username: "admin", token: "eth_bogus" }).code).not.toBe(0);
  expect(git(dst, ["clone", "-q", cloneUrl("admin", repo), "b"], { username: "admin", token: ADMIN.password }).code).not.toBe(0);
});

test("collaborator roles control clone and push", async () => {
  const { ctx, auth } = await adminWithToken();
  const repo = await createRepo(ctx);
  const src = workdir();
  seed(src, { "f.txt": "v1\n" });
  gitOk(src, ["push", cloneUrl("admin", repo), "main"], auth);

  const outsider = await createUser(ctx);
  const reader = await createUser(ctx);
  const writer = await createUser(ctx);
  await ctx.put(`/api/repos/admin/${repo}/collaborators/${reader.username}`, { data: { role: "read" } });
  await ctx.put(`/api/repos/admin/${repo}/collaborators/${writer.username}`, { data: { role: "write" } });

  const dir = workdir();
  expect(git(dir, ["clone", "-q", cloneUrl("admin", repo), "outsider"], outsider).code).not.toBe(0);

  gitOk(dir, ["clone", "-q", cloneUrl("admin", repo), "reader"], reader);
  writeFileSync(join(dir, "reader", "f.txt"), "reader edit\n");
  gitOk(join(dir, "reader"), ["commit", "-qam", "reader edit"]);
  expect(git(join(dir, "reader"), ["push", "origin", "main"], reader).code).not.toBe(0);

  // Refuse at ref advertisement time, not only on the pack POST.
  const basic = Buffer.from(`${reader.username}:${reader.token}`).toString("base64");
  const adv = await fetch(`${cloneUrl("admin", repo)}/info/refs?service=git-receive-pack`, { headers: { Authorization: `Basic ${basic}` } });
  expect(adv.status).toBe(403);

  gitOk(dir, ["clone", "-q", cloneUrl("admin", repo), "writer"], writer);
  writeFileSync(join(dir, "writer", "f.txt"), "writer edit\n");
  gitOk(join(dir, "writer"), ["commit", "-qam", "writer edit"]);
  gitOk(join(dir, "writer"), ["push", "-q", "origin", "main"], writer);

  const check = workdir();
  gitOk(check, ["clone", "-q", cloneUrl("admin", repo), "c"], auth);
  expect(readFileSync(join(check, "c", "f.txt"), "utf8")).toBe("writer edit\n");
});

test("gzip-encoded upload-pack requests are decoded", async () => {
  const { ctx, auth } = await adminWithToken();
  const repo = await createRepo(ctx);
  const src = workdir();
  seed(src, { "z.txt": "z\n" });
  gitOk(src, ["push", cloneUrl("admin", repo), "main"], auth);
  const head = gitOk(src, ["rev-parse", "HEAD"]).trim();

  const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
  const body = gzipSync(Buffer.from(pkt(`want ${head}\n`) + "0000" + pkt("done\n")));
  const basic = Buffer.from(`${auth.username}:${auth.token}`).toString("base64");
  const res = await fetch(`${cloneUrl("admin", repo)}/git-upload-pack`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-git-upload-pack-request",
      "Content-Encoding": "gzip",
    },
    body,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
  const out = Buffer.from(await res.arrayBuffer());
  expect(out.subarray(0, 8).toString()).toBe("0008NAK\n");
  expect(out.includes(Buffer.from("PACK"))).toBe(true);
});

test("path traversal and malformed repository names are refused", async () => {
  const { ctx, auth } = await adminWithToken();
  for (const name of ["../evil", "a/b", "..", ".", "evil.git", "with space", "", "x".repeat(101)]) {
    const res = await ctx.post("/api/repos", { data: { name } });
    expect(res.status(), `name ${JSON.stringify(name)}`).toBe(400);
  }

  const basic = Buffer.from(`${auth.username}:${auth.token}`).toString("base64");
  for (const path of ["/..%2F..%2Fadmin/x.git/info/refs", "/admin/..%2F..%2Fx.git/info/refs", "/admin/%2E%2E.git/info/refs"]) {
    const res = await fetch(`${baseURL()}${path}?service=git-upload-pack`, { headers: { Authorization: `Basic ${basic}` } });
    expect([400, 404], path).toContain(res.status);
  }
  expect(existsSync(join(process.env.ETHER_DATA!, "evil"))).toBe(false);
  expect(existsSync(join(process.env.ETHER_DATA!, "evil.git"))).toBe(false);
});

test("the server is not reachable from the LAN, only loopback", async () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  test.skip(!lan, "no non-loopback IPv4 interface on this machine");

  const reachable = await new Promise<boolean>((ok) => {
    const sock = connect({ host: lan!, port: Number(process.env.ETHER_PORT) });
    sock.setTimeout(2000);
    sock.once("connect", () => (sock.destroy(), ok(true)));
    sock.once("error", () => ok(false));
    sock.once("timeout", () => (sock.destroy(), ok(false)));
  });
  expect(reachable).toBe(false);
});

test("deleting a repository removes it from disk", async () => {
  const { ctx } = await adminWithToken();
  const repo = await createRepo(ctx, unique("doomed"));
  const dir = join(process.env.ETHER_DATA!, "repos", "admin", `${repo}.git`);
  expect(existsSync(dir)).toBe(true);
  expect((await ctx.delete(`/api/repos/admin/${repo}`)).status()).toBe(200);
  expect(existsSync(dir)).toBe(false);
  expect((await ctx.get(`/api/repos/admin/${repo}`)).status()).toBe(404);
});
