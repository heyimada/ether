import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createUser, git, gitOk, loginAdmin, originHeaders, uiLogin, unique, workdir } from "./helpers";

function canPush(owner: string, repo: string, who: { username: string; token: string }) {
  const dir = workdir();
  if (git(dir, ["clone", "-q", cloneUrl(owner, repo), "w"], who).code !== 0) return "no-read";
  writeFileSync(join(dir, "w", `${unique("f")}.txt`), "x\n");
  gitOk(join(dir, "w"), ["add", "-A"]);
  gitOk(join(dir, "w"), ["commit", "-q", "-m", "change"]);
  return git(join(dir, "w"), ["push", "-q", "origin", "main"], who).code === 0 ? "pushed" : "read-only";
}

test("teams grant their members a role on chosen org repositories", async ({ page }, info) => {
  const admin = await loginAdmin();
  const founder = await createUser(admin);
  const dev = await createUser(admin);
  const viewer = await createUser(admin);
  const outsider = await createUser(admin);
  const org = unique("crew").slice(0, 30);
  await founder.ctx.post("/api/orgs", { data: { name: org }, headers: originHeaders() });
  for (const m of [dev, viewer]) await founder.ctx.put(`/api/orgs/${org}/members/${m.username}`, { data: { role: "member" }, headers: originHeaders() });
  const repo = unique("engine");
  await founder.ctx.post("/api/repos", { data: { name: repo, owner: org }, headers: originHeaders() });
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "a.txt"), "a\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "seed"]);
  gitOk(src, ["push", "-q", cloneUrl(org, repo), "main"], { username: founder.username, token: founder.token });

  await uiLogin(page, founder.username, founder.password);
  await page.goto(`${baseURL()}/organizations/${org}/settings`);
  await page.getByLabel("Team name").fill("core");
  await page.getByRole("button", { name: "Create team" }).click();
  const team = page.getByRole("region", { name: "Team core" });
  await team.getByLabel("Add member").fill(dev.username);
  await team.getByRole("button", { name: "Add to team" }).click();
  await expect(team.getByRole("list", { name: "Team members" })).toContainText(dev.username);
  await team.getByLabel("Repository").selectOption(repo);
  await team.getByLabel("Team role").selectOption("write");
  await team.getByRole("button", { name: "Grant access" }).click();
  await expect(team.getByRole("list", { name: "Team repositories" })).toContainText(repo);
  await info.attach("team", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Base permission is read: only the team member can push.
  expect(canPush(org, repo, { username: dev.username, token: dev.token })).toBe("pushed");
  expect(canPush(org, repo, { username: viewer.username, token: viewer.token })).toBe("read-only");

  // Only org members can join a team.
  expect((await founder.ctx.put(`/api/orgs/${org}/teams/core/members/${outsider.username}`, { headers: originHeaders() })).status()).toBe(400);

  // Leaving the team, or the team going away, takes the extra access with it.
  expect((await founder.ctx.delete(`/api/orgs/${org}/teams/core/members/${dev.username}`, { headers: originHeaders() })).ok()).toBe(true);
  expect(canPush(org, repo, { username: dev.username, token: dev.token })).toBe("read-only");
  await founder.ctx.put(`/api/orgs/${org}/teams/core/members/${dev.username}`, { headers: originHeaders() });
  expect(canPush(org, repo, { username: dev.username, token: dev.token })).toBe("pushed");
  expect((await founder.ctx.delete(`/api/orgs/${org}/teams/core`, { headers: originHeaders() })).ok()).toBe(true);
  expect(canPush(org, repo, { username: dev.username, token: dev.token })).toBe("read-only");

  // Removing someone from the org removes them from its teams as well.
  await founder.ctx.post(`/api/orgs/${org}/teams`, { data: { name: "ops" }, headers: originHeaders() });
  await founder.ctx.put(`/api/orgs/${org}/teams/ops/members/${viewer.username}`, { headers: originHeaders() });
  await founder.ctx.delete(`/api/orgs/${org}/members/${viewer.username}`, { headers: originHeaders() });
  const teams = await (await founder.ctx.get(`/api/orgs/${org}/teams`)).json();
  expect(teams.teams.find((t: { name: string }) => t.name === "ops").members).toEqual([]);
});
