#!/usr/bin/env bun
// Scripted user journeys, one per feature file in ../features/. Each writes its proof to
// $EVIDENCE_DIR/<feature>/ and exits non-zero on the first failed expectation.
// Usage: ETHER_VERIFY_RUN=<run dir> .claude/skills/verify-ether/scripts/drive.ts <feature> [<feature>...]
//        HEADED=1 ... to watch.
import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, bareGit, browser, cloneUrl, createToken, evidence, git, gitOk, json, loadRun, newPage, uiLogin, unique, workdir, type RunState } from "./lib";

type Journey = (run: RunState, ev: ReturnType<typeof evidence>) => Promise<void>;

const journeys: Record<string, Journey> = {
  // features/repositories.md
  async repositories(run, ev) {
    const b = await browser();
    try {
      const page = await newPage(b, run);
      const name = unique("verify-repo");
      await uiLogin(page, run.ADMIN_USER, run.ADMIN_PASSWORD);
      await ev.shot(page, "dashboard");
      await page.getByRole("link", { name: "New repository" }).click();
      await page.getByLabel("Repository name").fill(name);
      await page.getByLabel("Description").fill("Made by verify-ether");
      await ev.shot(page, "new-repo-form");
      await page.getByRole("button", { name: "Create repository" }).click();
      await expect(page).toHaveURL(`${run.ETHER_URL}/${run.ADMIN_USER}/${name}`);
      await expect(page.getByText("Quick setup")).toBeVisible();
      await ev.shot(page, "empty-repo");

      const auth = { username: run.ADMIN_USER, token: await createToken(await api(run)) };
      const src = workdir();
      gitOk(src, ["init", "-q"], undefined, ev.log);
      writeFileSync(join(src, "README.md"), "# Verify Ether\n\nPushed **over HTTPS**.\n");
      mkdirSync(join(src, "src"));
      writeFileSync(join(src, "src", "main.ts"), "export const answer = 42;\n");
      gitOk(src, ["add", "-A"], undefined, ev.log);
      gitOk(src, ["commit", "-q", "-m", "Add readme and main"], undefined, ev.log);
      gitOk(src, ["push", cloneUrl(run, run.ADMIN_USER, name), "main"], auth, ev.log);

      await page.reload();
      const readme = page.getByRole("article", { name: "README" });
      await expect(readme.getByRole("heading", { name: "Verify Ether" })).toBeVisible();
      await expect(readme.locator("strong")).toHaveText("over HTTPS");
      await ev.shot(page, "pushed-readme");
      await page.getByRole("link", { name: "src", exact: true }).click();
      await page.getByRole("link", { name: "main.ts" }).click();
      await expect(page.getByRole("region", { name: "File contents" })).toContainText("export const answer = 42;");
      await ev.shot(page, "file-view");

      const local = gitOk(src, ["rev-parse", "HEAD"]).trim();
      const refs = bareGit(run, run.ADMIN_USER, name, ["show-ref"]);
      ev.write("bare-refs.txt", refs);
      if (!refs.includes(`${local} refs/heads/main`)) throw new Error(`bare repo main is not ${local}`);
      const clone = workdir();
      gitOk(clone, ["clone", "-q", cloneUrl(run, run.ADMIN_USER, name), "c"], auth, ev.log);
      ev.log(`PASS repositories ${name} main=${local}`);
    } finally {
      await b.close();
    }
  },

  // features/issues.md
  async issues(run, ev) {
    const admin = await api(run);
    const name = unique("verify-issues");
    await json(await admin.post("/api/repos", { data: { name, description: "" } }));
    const b = await browser();
    try {
      const page = await newPage(b, run);
      await uiLogin(page, run.ADMIN_USER, run.ADMIN_PASSWORD);
      await page.goto(`/${run.ADMIN_USER}/${name}`);
      await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Issues" }).click();
      await page.getByRole("link", { name: "New issue" }).click();
      await page.getByLabel("Title").fill("Build is broken");
      await page.getByLabel("Body").fill("Steps:\n\n1. run it\n2. **boom**");
      await ev.shot(page, "new-issue-form");
      await page.getByRole("button", { name: "Submit new issue" }).click();
      await expect(page.getByRole("heading", { name: /Build is broken/ })).toBeVisible();
      await expect(page.locator("strong", { hasText: "boom" })).toBeVisible();
      await ev.shot(page, "issue-created");

      await page.getByRole("button", { name: "Edit labels" }).click();
      await page.getByRole("menuitemcheckbox", { name: /bug/ }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("list", { name: "Issue labels" })).toContainText("bug");
      await page.getByLabel("Comment").fill("Looking into it");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(page.getByText("Looking into it")).toBeVisible();
      await ev.shot(page, "labelled-and-commented");
      await page.getByRole("button", { name: "Close issue" }).click();
      await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
      await ev.shot(page, "closed");

      await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Issues" }).click();
      await expect(page.getByRole("link", { name: "Build is broken" })).toHaveCount(0);
      await page.getByRole("link", { name: /Closed/ }).click();
      await expect(page.getByRole("link", { name: "Build is broken" })).toBeVisible();
      await ev.shot(page, "closed-list");

      const stored = await json(await admin.get(`/api/repos/${run.ADMIN_USER}/${name}/issues/1`));
      ev.write("issue-1.json", JSON.stringify(stored, null, 2));
      if (stored.issue.state !== "closed") throw new Error(`issue state is ${stored.issue.state}`);
      if (!stored.issue.labels.some((l: { name: string }) => l.name === "bug")) throw new Error("label bug not stored");
      if (!stored.comments.some((c: { body: string }) => c.body === "Looking into it")) throw new Error("comment not stored");
      ev.log(`PASS issues ${name}#1`);
    } finally {
      await b.close();
    }
  },

  // features/pull-requests.md
  async "pull-requests"(run, ev) {
    const admin = await api(run);
    const auth = { username: run.ADMIN_USER, token: await createToken(admin) };
    const name = unique("verify-pr");
    await json(await admin.post("/api/repos", { data: { name, description: "" } }));
    const src = workdir();
    gitOk(src, ["init", "-q"], undefined, ev.log);
    writeFileSync(join(src, "README.md"), "# PR test\n");
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "base"]);
    gitOk(src, ["checkout", "-q", "-b", "topic/add-file"]);
    writeFileSync(join(src, "added.txt"), "brand new file\n");
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "Add a file"]);
    gitOk(src, ["push", "-q", cloneUrl(run, run.ADMIN_USER, name), "main", "topic/add-file"], auth, ev.log);
    ev.write("bare-refs-before.txt", bareGit(run, run.ADMIN_USER, name, ["show-ref"]));

    const b = await browser();
    try {
      const page = await newPage(b, run);
      await uiLogin(page, run.ADMIN_USER, run.ADMIN_PASSWORD);
      await page.goto(`/${run.ADMIN_USER}/${name}`);
      await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Pull requests" }).click();
      await page.getByRole("link", { name: "New pull request" }).click();
      await page.getByLabel("Base").selectOption("main");
      await page.getByLabel("Compare").selectOption("topic/add-file");
      await expect(page.getByText("added.txt")).toBeVisible();
      await page.getByLabel("Title").fill("Add added.txt");
      await ev.shot(page, "compare");
      await page.getByRole("button", { name: "Create pull request" }).click();
      await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();
      await ev.shot(page, "opened");
      await page.getByRole("link", { name: "Files changed" }).click();
      await expect(page.getByRole("region", { name: "Diff" }).getByText("brand new file")).toBeVisible();
      await ev.shot(page, "files-changed");
      await page.getByRole("link", { name: "Conversation" }).click();
      await page.getByRole("button", { name: "Merge pull request" }).click();
      await expect(page.getByText("Merged", { exact: true }).first()).toBeVisible();
      await ev.shot(page, "merged");

      const tree = bareGit(run, run.ADMIN_USER, name, ["ls-tree", "--name-only", "refs/heads/main"]);
      ev.write("bare-main-after.txt", `${bareGit(run, run.ADMIN_USER, name, ["show-ref"])}\n${tree}`);
      if (!tree.includes("added.txt")) throw new Error("main does not contain added.txt after merge");
      const pr = await json(await admin.get(`/api/repos/${run.ADMIN_USER}/${name}/pulls/1`));
      ev.write("pull-1.json", JSON.stringify(pr, null, 2));
      ev.log(`PASS pull-requests ${name}#1`);
    } finally {
      await b.close();
    }
  },

  // features/access-tokens.md
  async "access-tokens"(run, ev) {
    const admin = await api(run);
    const name = unique("verify-token");
    await json(await admin.post("/api/repos", { data: { name, description: "" } }));
    const b = await browser();
    try {
      const page = await newPage(b, run);
      await uiLogin(page, run.ADMIN_USER, run.ADMIN_PASSWORD);
      await page.goto("/settings");
      const tokenName = unique("laptop");
      await page.getByLabel("Token name").fill(tokenName);
      await page.getByRole("button", { name: "Generate token" }).click();
      const token = (await page.getByLabel("New token").textContent())!.trim();
      await expect(page.getByText(tokenName)).toBeVisible();
      await ev.shot(page, "token-generated");

      const auth = { username: run.ADMIN_USER, token };
      const ok = git(workdir(), ["ls-remote", cloneUrl(run, run.ADMIN_USER, name)], auth, ev.log);
      if (ok.code !== 0) throw new Error(`fresh token rejected: ${ok.stderr}`);
      await page.reload();
      const row = page.getByRole("listitem").filter({ hasText: tokenName });
      await expect(row).toContainText("last used");
      await ev.shot(page, "token-used");

      await row.getByRole("button", { name: "Revoke" }).click();
      await expect(page.getByText(tokenName)).toHaveCount(0);
      await ev.shot(page, "token-revoked");
      const denied = git(workdir(), ["ls-remote", cloneUrl(run, run.ADMIN_USER, name)], auth, ev.log);
      if (denied.code === 0) throw new Error("revoked token still works");
      ev.log("PASS access-tokens");
    } finally {
      await b.close();
    }
  },

  // features/invite-signup.md
  async "invite-signup"(run, ev) {
    const b = await browser();
    try {
      const page = await newPage(b, run);
      await uiLogin(page, run.ADMIN_USER, run.ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("menuitem", { name: "Admin" }).click();
      await page.getByRole("button", { name: "Create invite link" }).click();
      const link = (await page.getByLabel("Invite link").textContent())!.trim();
      await ev.shot(page, "invite-created");
      ev.log(`invite ${link}`);

      const friend = await newPage(b, run);
      await friend.goto("/");
      await expect(friend.getByText(/invite-only/i)).toBeVisible();
      const u = new URL(link);
      await friend.goto(`${u.pathname}${u.search}`);
      await expect(friend.getByLabel("Invite code")).not.toHaveValue("");
      const username = unique("friend").slice(0, 30);
      await friend.getByLabel("Username").fill(username);
      await friend.getByLabel("Password").fill("friend-password-123");
      await ev.shot(friend, "register-form");
      await friend.getByRole("button", { name: "Create account" }).click();
      await expect(friend.getByRole("heading", { name: `Welcome, ${username}` })).toBeVisible();
      await ev.shot(friend, "registered");

      const reuse = await newPage(b, run);
      await reuse.goto(`${u.pathname}${u.search}`);
      await reuse.getByLabel("Username").fill(unique("second").slice(0, 30));
      await reuse.getByLabel("Password").fill("friend-password-123");
      await reuse.getByRole("button", { name: "Create account" }).click();
      await expect(reuse.getByRole("alert")).toContainText(/invite/i);
      await ev.shot(reuse, "invite-reuse-refused");

      await api(run, username, "friend-password-123");
      ev.log(`PASS invite-signup ${username} can sign in`);
    } finally {
      await b.close();
    }
  },
};

const names = process.argv.slice(2);
if (names.length === 0 || names.some((n) => !journeys[n])) {
  console.error(`usage: drive.ts <${Object.keys(journeys).join("|")}>...`);
  process.exit(2);
}
const run = loadRun();
let failed = false;
for (const n of names) {
  const ev = evidence(run, n);
  try {
    await journeys[n](run, ev);
    console.log(`PASS ${n}  -> ${ev.dir}`);
  } catch (e) {
    failed = true;
    ev.log(`FAIL ${n}: ${(e as Error).stack}`);
    console.error(`FAIL ${n}: ${(e as Error).message}\n  evidence: ${ev.dir}`);
  }
}
process.exit(failed ? 1 : 0);
