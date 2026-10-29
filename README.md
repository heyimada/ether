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
- **Protected branches**: rules per branch name or pattern (`main`, `release/*`, `hotfix/**`) that block direct pushes, force pushes and deletion over HTTPS and SSH, for everyone including owners. Each ref in a push is checked on its own, so a refused branch doesn't hold back the others. Merging a pull request stays possible; requiring pull requests doesn't require a review, so turn on approving reviews too if someone else should look first. If the check can't run, protected pushes are refused instead of let through.
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
| `BETTER_AUTH_SECRET` | generated into `data/auth-secret` | Session signing secret; CI secrets are encrypted under a key derived from it |
| `ETHER_CI_RUNTIME` | `docker`, else `podman` | Container CLI for CI jobs |
| `ETHER_CI_IMAGE` | `oven/bun:1` | Image for CI jobs that don't name one |
| `ETHER_CI_JOBS` | `2` | CI jobs that run at the same time, across all repositories |

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

Off until an admin ticks **Admin → Access → Run CI jobs on this server** and an owner turns it on in the repository's **Settings**. Then commit workflows to `.ether/workflows/` (any number of `.yml` or `.yaml` files, up to 20), in a format close to GitHub Actions:

```yaml
# .ether/workflows/test.yml
name: Tests
on:
  push:
    branches: [main, "release/**"]   # or branches-ignore; tags / tags-ignore work the same way
    paths-ignore: ["docs/**"]        # or paths
  pull_request:
    branches: [main]                 # the branch the pull request goes into
jobs:
  lint:
    steps:
      - run: bun run lint
  test:
    image: oven/bun:1.4.0            # optional; the server's default image otherwise
    strategy:
      matrix:
        shard: [1, 2, 3]             # one job per value: "test (1)", "test (2)", "test (3)"
    steps:
      - name: Install
        run: bun install
      - name: Test
        run: bun test --shard "$CI_MATRIX_SHARD/3"
        timeout-minutes: 15          # default 10, at most 60
  report:
    needs: [lint, test]              # starts once both have finished
    if: failure()                    # success() (the default), failure(), always() or cancelled()
    steps:
      - run: ./scripts/notify.sh
```

```yaml
# .ether/workflows/deploy.yml
name: Deploy
on:
  workflow_dispatch:                 # a "Run workflow" button on the CI tab
    inputs:
      target:
        type: choice                 # string (default), boolean, number or choice
        options: [staging, production]
      dry-run:
        type: boolean
jobs:
  deploy:
    env:
      DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}   # set under the repository's Settings → CI secrets
    steps:
      - run: ./scripts/deploy.sh "$CI_INPUT_TARGET"
        shell: bash                  # bash (default when installed) or sh; pwsh if the image has it
        env:
          RETRIES: 3                 # plain values work too
```

**When workflows run.** `on:` takes `push`, `pull_request` and `workflow_dispatch`, as a name, a list or a map with filters:

- `push` runs when a branch or tag moves to a new commit, including when a pull request is merged into a branch. Naming only `branches` leaves tags out and the other way round; naming neither takes both. As on GitHub, a push of more than three tags at once (`git push --tags`, a mirror) starts nothing for its tags. Patterns use `*` (within one `/` segment), `**` and `?`, and in a list a later `!pattern` takes a match back.
- `pull_request` runs on the pull request's head commit when it is opened or reopened and whenever its branch moves (`types: [opened, synchronize, reopened]`, all three by default).
- `paths` and `paths-ignore` look at the files the push changed (for a new branch, what it has beyond the default branch; for a pull request, what it would bring in). They don't apply to tags, or when more than 1000 files changed.
- `workflow_dispatch` lets anyone with write access start the workflow on a branch from the **CI** tab, or with `POST /api/repos/:owner/:repo/ci/workflows/dispatch` and `{"workflow": ".ether/workflows/deploy.yml", "ref": "main", "inputs": {…}}`. Inputs are checked against their type, and the workflow is read from that branch.

**Jobs** run side by side, up to `ETHER_CI_JOBS` at a time across the server, each from its own fresh checkout. A job with `needs:` starts once the jobs it names have finished, and by default only if they all succeeded; otherwise it is skipped, and so is whatever needs it. `if:` changes that with one of `success()`, `failure()` (a need failed), `always()` or `cancelled()`, optionally negated with `!` or written as `${{ … }}`. Cancelling a run stops everything, `always()` jobs included. `strategy.matrix` runs a job once per combination of its lists, with `include` and `exclude` as on GitHub (at most 256 combinations, 100 jobs per run); each gets its values as `CI_MATRIX_<KEY>`. With `fail-fast` (the default) the first combination that fails cancels the others; `max-parallel` limits how many run at once.

Other events (`schedule`, `pull_request_target`, …), `uses:` actions, other `if:` conditions and expressions other than `${{ secrets.NAME }}` aren't supported (yet); a workflow that uses an unknown event is refused with a message saying so. A workflow file that doesn't parse shows up as a failed run on the next push. The older single `.ether/ci.yml` still works: it may leave out `on:` and then runs on every push to a branch, like before.

Each run is one workflow for one commit. Steps get `CI`, `CI_REPOSITORY`, `CI_COMMIT_SHA`, `CI_REF` (the branch or tag), `CI_REF_TYPE` (`branch` or `tag`), `CI_EVENT`, `CI_WORKFLOW`, for pull requests `CI_PULL_REQUEST` and `CI_BASE_REF`, a manual run's inputs as `CI_INPUT_<NAME>` (upper case, `-` becomes `_`), `CI_JOB` (the job's id in the workflow), and the `env` they ask for, never Ether's own settings. Runs and logs are under the repository's **CI** tab, by workflow. Pull requests show the newest run of each workflow for their head commit as checks (their own `pull_request` runs, not another pull request's from the same branch; manual runs don't count), and **Require passing checks before merging** blocks merges until they all pass.

**Where jobs run.** By default each job gets its own container, from Docker or Podman on the Ether machine (whichever is installed, or `ETHER_CI_RUNTIME`). The checkout is copied in, not mounted, so a job can't see Ether's data folder or anything else on the host. The container runs with `no-new-privileges`, without raw sockets, and capped at `ETHER_CI_MEMORY` (default `4g`), `ETHER_CI_CPUS` (`2`) and `ETHER_CI_PIDS` (`1024`) processes, and it is removed when the job ends. Jobs still have network access, for example to install packages. The default image is `ETHER_CI_IMAGE`, or `oven/bun:1`. Without a container runtime, jobs fail with a message saying so.

An admin can instead choose **On this machine, as the user Ether runs as** (the behaviour before containers, and the only option without Docker or Podman, for example on Windows without Docker Desktop). Those jobs can read Ether's data folder, including the database and auth secret, so everyone with write access to a repository with CI controls the server. Jobs that use secrets are refused in this mode.

**Secrets.** Owners add them under **Settings → CI secrets**. Values are encrypted in the database with a key derived from the auth secret (so a backup restores them along with it), can't be read back through the API or the UI, and are masked as `***` in logs. They reach a job only as the environment variables it names, and only in a container. Masking only prevents accidents: anyone who can push to the repository can write a workflow that prints a secret in another form, so only store what everyone with write access may know. If the auth secret changes (for example a new `BETTER_AUTH_SECRET`), jobs report that a secret can't be decrypted until it's set again.

## Deployments

A job that names an `environment` deploys there:

```yaml
jobs:
  staging:
    environment: staging
    steps:
      - run: ./scripts/deploy.sh staging
  production:
    environment:
      name: production
      url: https://example.com          # shown on the run and the repository home
    env:
      DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}
    steps:
      - run: ./scripts/deploy.sh production
```

An environment is created the first time a job names it. Under **Settings → Environments** owners can give it rules, all optional:

- **Branches that may deploy**: names or patterns like `main` or `release/*`, matched like protected branches. A job from any other branch is skipped, which doesn't fail its run. With branches set, a run for a tag is skipped too; without any, tags may deploy.
- **Required reviewers**: up to six people with write access. The job waits until one of them clicks **Approve and deploy** on the CI run, or **Reject**, which fails it. Nobody else can answer, the owner included.
- **Wait timer**: minutes the job waits before it starts, counted from the approval (or from the push when no approval is needed).
- **Secrets**: like CI secrets, but only for jobs deploying to this environment, where they replace a repository secret of the same name.

A waiting job steps out of the CI queue, so other runs go on, and the run shows as **Waiting** until it continues or is cancelled. Deploy jobs don't count as a pull request's checks: one that waits, is skipped or fails doesn't block **Require passing checks before merging**. Steps get `CI_ENVIRONMENT` with the environment's name. The repository home lists each environment with the commit it currently runs; a pull request whose head commit runs somewhere says **Deployed to …**. `GET /api/repos/:owner/:repo/deployments?environment=…` returns the history.

Reviewers and wait timers decide whether a deployment *starts*, not what it does. Anyone who can push can change the workflow, so keep the credentials that reach production in production's environment secrets: then only a job that passed its rules gets them.

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
