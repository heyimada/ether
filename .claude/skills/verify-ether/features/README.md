# Ether verification map

This directory is the maintained source for verifying Ether's user-facing behavior. Read this index before you drive the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch a private instance with `.claude/skills/verify-ether/scripts/launch.sh`. It uses a `mktemp` data dir and free ports, never `./data` or `:3000`.
- `.claude/skills/verify-ether/scripts/doctor.sh` exits 0.
- The instance has one account: `admin` / `admin-password-1` (site admin). Further people come from `createUser()` in `lib.ts` (invite + register).
- Never drive an instance this run didn't start.

## Driving conventions

- Every feature with a scripted journey runs as `ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts <feature>`, with `RUN_DIR` taken from the launch output (see SKILL.md). The bullets in each file name the Playwright calls the journey makes, so you can reproduce a single step in an ad-hoc script built on `lib.ts`.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position. `e2e/*.spec.ts` holds more working selectors.
- Run every `git` command through `git()`/`gitOk()` from `lib.ts` so tokens never reach a credential helper.
- Create every repository, issue or token with a `unique()` name; the instance keeps state between journeys.

## Proof and skip reporting

- Capture the user action and the resulting state with `ev.shot(page, "<step>")` before and after it.
- UI proof is a screenshot plus an ARIA snapshot (`NN-<step>.png`, `NN-<step>.aria.txt`).
- Git proof is the command, exit code and output in `transcript.txt`, plus a `bareGit()` dump of the server-side repo.
- Mutation proof includes a read-only second view of the stored value: an API GET written with `ev.write()`, or `bareGit()`.
- Report an unreachable path with the attempted command and the unmet precondition. Don't report an entry point as verified through a different one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-ether` (starting with `Preconditions:`, then labeled bullets pairing each action with its exact call and observable result), and `Gotchas`.

## Features

- [Repositories](./repositories.md): create in the UI, push over HTTPS, browse README, tree and files, and clone.
- [Issues](./issues.md): open, comment, label, close, and filter the closed list.
- [Pull requests](./pull-requests.md): compare branches, open, review the diff, and merge on the server.
- [Access tokens](./access-tokens.md): generate in Settings, use as the git password, and revoke.
- [Invite sign-up](./invite-signup.md): an admin creates an invite link, a newcomer registers, and the link can't be reused.

Not yet mapped (add files when you verify them): SSH keys and git over SSH, deploy keys, organizations and teams, protected branches, PR reviews and reviewers, labels page, wiki, releases, CI (`.ether/ci.yml`, needs Docker or Podman), profiles and contributions, stars and feed, search (`Ctrl`+`K`), accent and theme, the operator CLI (`backup`, `restore`, `reset-password`), and the Rust `ether` client.
