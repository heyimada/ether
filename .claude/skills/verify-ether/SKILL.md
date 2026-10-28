---
name: verify-ether
description: Launch a private Ether server (self-hosted git forge, Bun + Elysia + TanStack SPA) and drive its web UI and git-over-HTTPS like a user, with Playwright, capturing screenshots, ARIA snapshots and on-disk side effects as proof. Use to prove a change to Ether works in the real app (repositories, issues, pull requests, tokens, invites, settings), not just in unit or e2e tests.
---

# verify-ether

Drives a throwaway Ether instance end to end. Every helper lives in `.claude/skills/verify-ether/scripts/` and is run from the repo root (or a worktree root; the scripts find their own checkout).

Surfaces: the **web UI** is primary and is what this skill drives. Secondary surfaces are git over HTTPS (driven here through an isolated `git`), git over SSH (`e2e/ssh.spec.ts` shows the recipe with `sshIdentity()`), the operator CLI `bun run ether …` (`src/server/cli.ts`) and the Rust client in `cli/` (`e2e/cli.spec.ts`).

## Hard rules

- **Never drive the user's instance.** Not `./data`, not ports 3000/5173/2222, not a server you didn't launch. `launch.sh` picks free ports and a `mktemp` data dir. Two runs can coexist; each has its own run dir.
- **Never let git see your token through a credential helper.** On macOS an ordinary `git push` with a token stores it in the Keychain. Use `git()`/`gitOk()` from `lib.ts`, which empty `GIT_CONFIG_GLOBAL`, set `GIT_CONFIG_NOSYSTEM=1`, `credential.helper=`, `GIT_TERMINAL_PROMPT=0` and pass the token as an `http.extraHeader`.
- **Kill only what you started.** `cleanup.sh` stops the PID from `state.env` after checking its command line, never by process name.

## Launch

```sh
V=.claude/skills/verify-ether/scripts
RUN_DIR="$($V/launch.sh | sed -n 's/^RUN_DIR=//p')"   # builds dist/ first; always do this after code changes
RUN_DIR="$($V/launch.sh --no-build | sed -n 's/^RUN_DIR=//p')"   # reuse dist/ only if nothing in src/web changed
[ -n "$RUN_DIR" ] || echo "launch failed; see the newest e2e-report/verify/<run-id>/ logs (a failed launch stops its own server and data dir)"
```

Keep `RUN_DIR` and pass it to every later command (doctor, drive, cleanup). Every helper falls back to `e2e-report/verify/latest`, which is the newest launch by anyone, so another agent's launch would redirect your drive or cleanup to their instance. Rely on `latest` only when you know you are the only one verifying. Shell variables don't survive between separate tool calls, so either chain the commands in one call or paste the literal path.

It runs `bun run build`, copies `dist/client` into the data dir (served via `ETHER_WEB_DIST`, so later rebuilds don't change the running instance), creates the admin with `bun src/server/cli.ts create-admin admin --password admin-password-1`, starts `bun src/server/main.ts` with `nohup`, and waits for `GET /api/health` → `{"ok":true}`. Ready looks like:

```
ready: http://127.0.0.1:55063 (ssh :55064, pid 41394)
```

followed by the run's `state.env` (`ETHER_URL`, `ETHER_PORT`, `ETHER_SSH_PORT`, `ETHER_DATA`, `PID`, `ADMIN_USER`, `ADMIN_PASSWORD`, `EVIDENCE_DIR`, `SOURCE_REV`). The run dir is `e2e-report/verify/<run-id>/` (gitignored); `e2e-report/verify/latest` points at the newest. Logs: `build.log`, `create-admin.log`, `server.log` in the run dir.

The server runs from source without `--watch`: after editing `src/server/` or `src/web/`, clean up and launch again.

## Doctor

```sh
.claude/skills/verify-ether/scripts/doctor.sh "$RUN_DIR"
```

Read-only. Checks the PID is alive and is `bun src/server/main.ts`, both ports are owned by that PID (`lsof`), `/api/health` is ok, admin sign-in returns 200, and the data dir is a verify dir. Warns when `HEAD` moved or source contents changed since launch (a hash of `git diff HEAD` plus untracked, non-ignored files), meaning the instance is stale. Exit 0 means drive it; anything else means clean up and relaunch. Run it first whenever something looks off.

## Drive

Scripted journeys, one per feature file:

```sh
ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts repositories      # one
ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts repositories issues pull-requests access-tokens invite-signup
HEADED=1 ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts issues   # watch it
```

Each prints `PASS <feature>  -> <evidence dir>` or `FAIL <feature>: <reason>` and exits non-zero on failure.

For a behavior no journey covers, write an ad-hoc script in your scratchpad. Import **everything**, including `expect`, from `lib.ts` by absolute path. A bare `import "@playwright/test"` in a file outside the repo finds no `node_modules`. This example signs in a second person, and was run as written:

```sh
REPO="$(git rev-parse --show-toplevel)"
SCRIPT="<your scratchpad>/second-user.ts"
echo "import { api, browser, createUser, evidence, expect, loadRun, newPage, uiLogin } from \"$REPO/.claude/skills/verify-ether/scripts/lib.ts\";" >"$SCRIPT"
cat >>"$SCRIPT" <<'EOF'
const run = loadRun();
const ev = evidence(run, "second-user");
const friend = await createUser(run, await api(run));     // invite + register through the API
const b = await browser();
const page = await newPage(b, run);                       // baseURL = run.ETHER_URL, so page.goto("/settings") works
await uiLogin(page, friend.username, friend.password);
await ev.shot(page, "friend-dashboard");
await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
await b.close();
console.log("PASS second-user ->", ev.dir);
EOF
ETHER_VERIFY_RUN="$RUN_DIR" bun "$SCRIPT"
```

`lib.ts` exports `expect` and `chromium` (re-exported from the repo's Playwright), and `loadRun`, `evidence` (`shot`, `write`, `log`), `browser`, `newPage`, `uiLogin`, `api` (signed-in API context with the required `Origin` header), `json`, `createToken`, `createUser` (invite + register a second person), `cloneUrl`, `workdir`, `git`/`gitOk` (isolated), `bareGit` (read-only git against the server's bare repo in `$ETHER_DATA/repos/<owner>/<repo>.git`).

Selectors: use roles and accessible names; the app labels its landmarks. Stable handles: `link "New repository"`, `navigation "Repository"` → `link "Issues"` / `"Pull requests"`, `article "README"`, `region "File contents"`, `region "Diff"`, `region "Review"`, `button "Account menu"` → `menuitem "Admin"`, `code[aria-label="New token"]`, `list "Issue labels"`, `list "Reviewers"`. `e2e/*.spec.ts` is the largest catalogue of working selectors; grep it before guessing.

Interactive alternative: the chrome-devtools MCP (`new_page` at `ETHER_URL`, `take_snapshot`, `click` by uid) works against the same instance. Sign in through `/login` with the admin credentials from `state.env`.

## Evidence

Everything goes to `$EVIDENCE_DIR/<feature>/` = `e2e-report/verify/<run-id>/evidence/<feature>/`:

- `NN-<step>.png` (full page) and `NN-<step>.aria.txt` (URL plus ARIA snapshot), taken before and after each action;
- `transcript.txt`: timestamped steps, every git command with exit code and output (tokens never appear; they travel in a header that isn't logged);
- side-effect dumps: `bare-refs.txt` / `bare-main-after.txt` (refs and trees in the server's bare repo), `issue-1.json` / `pull-1.json` (a second, read-only view through the API).

The server's own output is `e2e-report/verify/<run-id>/server.log`.

Proof standards:

- Exercise the real user path: UI clicks and a real `git push`. The API is for setup and for read-only checks of what the UI did, not a replacement for the step under test.
- Capture the action and the resulting state, not just the final screen.
- Verify side effects alongside what's visible: refs in the bare repo after a push or merge, stored issue state, a token rejected by git after revoking.
- No mocks. CI journeys need Docker or Podman for real; if neither is installed, report that rather than switching to the host runner without saying so.

## Cleanup

```sh
.claude/skills/verify-ether/scripts/cleanup.sh "$RUN_DIR"
```

Stops our PID (TERM, then KILL after 10 s), removes Docker/Podman containers labelled `ether.ci.instance=<sha256(data dir)[:16]>` (only this instance's CI jobs), deletes the `ether-verify-*` data dir, and appends `STOPPED_AT=<time>` to `state.env` (doctor and `loadRun` then refuse the run). The run dir with `evidence/` and `server.log` stays. Run cleanup after every run, including failed ones. Remove old run dirs by hand with `rm -rf e2e-report/verify/<run-id>` once nobody needs the proof.

## Gotchas

- **SSH host key flake (product bug).** On a fresh data dir, ssh2's `generateKeyPairSync("ed25519")` sometimes writes a host key that its own `parseKey` rejects (about 1 in 200), and the server dies with `Cannot parse privateKey: Malformed OpenSSH private key` at `src/server/ssh.ts`. `launch.sh` retries once with a new data dir and prints a WARNING; the failed log is kept as `server-failed-start.log`.
- Mutating API calls need an `Origin` header matching the server; `api()` sets it.
- A stale `dist/` serves an old UI against new server code. Launch without `--no-build` unless you're sure.
- Names created by journeys use `unique()` so reruns against the same instance don't collide; lists and counters therefore include earlier runs' items. Scope assertions to the row or item you created.
- Feature map: `features/README.md`. Keep it honest with `/maintain-verification-skill`.
