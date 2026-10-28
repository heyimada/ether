# Ether

[![CI](https://github.com/heyimada/ether/actions/workflows/ci.yml/badge.svg)](https://github.com/heyimada/ether/actions/workflows/ci.yml)

A self-hosted alternative to GitHub Enterprise: code hosting, review and collaboration on a server you control. Run it on a VPS, a home server or your own machine behind a private network such as a Tailscale tailnet.

- **Git over HTTPS** (smart HTTP, streamed in both directions), authenticated with personal access tokens.
- **Git over SSH** with keys people add in **Settings**, protocol v2 and streamed with backpressure. Settings shows the server's host key fingerprint to check on the first connection.
- **Deploy keys**: SSH keys for one repository, read-only unless the owner allows writes, for servers and CI without an account. Pushes made with one are attributed to whoever added it; once that account is deleted, to the repository's owner (for an organization's repository, the organization). A deploy key keeps working when the person who added it loses access and when the repository is transferred.
- **Public and private repositories.** Public means readable and cloneable by every account on the server; pushing always needs a role.
- **Organizations** that own repositories, with owners, members and a base permission (read or write) for every org repository.
- **Code browser**: files with their last commit, branches and tags (including names with `/`), history, diffs, and a branch/tag picker.
- **Issues and pull requests**, sharing one number sequence per repository. Merges happen on the server with a compare-and-swap on the base branch.
- **Protected branches**: rules per branch name or pattern (`main`, `release/*`, `hotfix/**`) that block direct pushes, force pushes and deletion over HTTPS and SSH, for everyone including owners. Merging a pull request stays possible.
- **Profiles** like GitHub's: avatar (animated GIFs kept), bio, pronouns, company, location, links, status, followers, pinned repositories, a profile README from `<you>/<you>`, a contribution graph and recent activity, all limited to what the viewer can see.
- **Invite-only accounts**, per-repository collaborators (`read` / `write`), search or jump (`Ctrl`+`K` style), light/dark theme and a free accent colour per user.

Stack: Bun · Elysia 2 (RC) · Better Auth · Drizzle + SQLite (`bun:sqlite`) · TanStack Start (SPA) · `@pierre/diffs`.

## Run it

```sh
bun install
bun run build                                   # builds the web app into dist/
bun run ether create-admin <you> --password '<at least 10 chars>'
bun run start                                   # http://127.0.0.1:3000
```

Development: run `bun run dev:server` and `bun run dev:web` together. The app is at http://localhost:5173, and Vite proxies `/api` and git requests to the server.

| Env var | Default | Meaning |
|---|---|---|
| `ETHER_DATA` | `./data` | SQLite DB, bare repos, auth secret |
| `ETHER_HOST` / `ETHER_PORT` | `127.0.0.1` / `3000` | Bind address. Keep it on loopback. |
| `ETHER_PUBLIC_URL` | `http://HOST:PORT` | The URL people use to reach Ether |
| `ETHER_SSH_PORT` | `2222` | Git over SSH on the same bind address; `off` disables it |
| `ETHER_SSH_HOST` | host of `ETHER_PUBLIC_URL` | Host name shown in `ssh://` clone URLs |
| `BETTER_AUTH_SECRET` | generated into `data/auth-secret` | Session signing secret |

## Example deployment: a Tailscale tailnet

`scripts/deploy.ps1` builds Ether and registers a logon task that runs `scripts/start.ps1`. It then publishes the server to your tailnet with `tailscale serve --https=443`, and git over SSH with `tailscale serve --tcp=2222`. Ether only ever listens on `127.0.0.1`, so it can't be reached from the LAN or the internet. Don't use `tailscale funnel`.

On a tailnet, first share the machine with the person in the Tailscale admin console (or invite them to the tailnet).

## Adding people

1. Create an invite link in **Admin** (account menu, top right), or run `bun run ether invite --by <you>`. Send them the link.
2. Give them access: make a repository public, add them as a collaborator in its **Settings**, or add them to an organization.
3. They create a personal access token in **Settings** and use it as the git password.

Forgotten password (anyone's): `bun run ether reset-password <username> --password '<new password>'`. It signs that account out everywhere; their access tokens keep working.

Backups: `bun run ether backup <dir>` writes a timestamped snapshot while the server keeps running: a consistent SQLite copy (`VACUUM INTO`), every bare repo copied refs-first (so a push during the backup can't leave refs pointing at missing objects), avatars and the auth secret.

Restore: stop Ether, then `ETHER_DATA=<empty folder> bun run ether restore <dir>/<timestamp>` and start Ether with that `ETHER_DATA`. Restore refuses to write into a folder that already holds Ether data.

## CI

Off until an admin ticks **Admin → Access → Run CI jobs on this server** and an owner turns it on in the repository's **Settings**. Jobs run on the Ether machine as the user Ether runs as, so only allow it for people you trust with that. Then commit `.ether/ci.yml`:

```yaml
jobs:
  test:
    steps:
      - name: Install
        run: bun install
      - name: Test
        run: bun test
        timeout-minutes: 15        # default 10, at most 60
  lint:
    steps:
      - run: bunx tsc --noEmit
        shell: bash                # bash (default when installed), sh, pwsh, powershell or cmd
```

Every push to a branch runs the workflow of its new commit, one job at a time, in a fresh checkout. Steps get a minimal environment (`PATH`, `HOME`/`TEMP` and `CI`, `CI_REPOSITORY`, `CI_COMMIT_SHA`, `CI_REF`) without Ether's settings. They still run as the same OS user as Ether, so a workflow can read Ether's data folder, including the database and auth secret: turning CI on gives everyone with write access to that repository full control of the server. Runs and logs are under the repository's **CI** tab; pull requests show their head commit's checks, and **Require passing checks before merging** blocks merges until they pass.

## Command-line client

`cli/` is a Rust client in the spirit of GitHub's `gh`, built as `ether`:

```sh
cd cli && cargo build --release        # binary at cli/target/release/ether(.exe)
echo "$TOKEN" | ether auth login --host https://ether.example.com --with-token
ether repo create my-tool --public     # or --org acme
ether repo clone ada/my-tool           # git push/pull then use your login
ether issue create --title "Bug" --body "Steps…"
ether issue list | view 3 | comment 3 --body "…" | close 3
ether pr create --title "Fix it"       # head = current branch, base = default branch
ether pr list | view 4 | merge 4 | checkout 4
ether api /api/me                      # any endpoint, JSON out
```

Inside a clone the repository is taken from `origin`; elsewhere pass `-R OWNER/REPO`. The token is stored in your config directory (`ETHER_CONFIG_DIR` overrides it), and the API accepts it as `Authorization: Bearer <token>`. This is separate from the server's admin commands (`bun run ether …`).

## Tests

`bun run test:e2e` builds the app, boots a real server on a random port against a throwaway data directory, and drives the git CLI and Chromium. Each run writes a timestamped report to `e2e-report/<timestamp>/`, containing an HTML report with screenshots, `results.json` and `server.log`. Install the browser once with `bunx playwright install chromium`.

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, tests and how reviews work. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
