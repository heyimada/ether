# Ether

[![CI](https://github.com/heyimada/ether/actions/workflows/ci.yml/badge.svg)](https://github.com/heyimada/ether/actions/workflows/ci.yml)

A self-hosted alternative to GitHub Enterprise: code hosting, review and collaboration on a server you control. Run it on a VPS, a home server or your own machine behind a private network such as a Tailscale tailnet.

- **Git over HTTPS** (smart HTTP, streamed in both directions), authenticated with personal access tokens.
- **Git over SSH** with keys people add in **Settings**, protocol v2 and streamed with backpressure. Settings shows the server's host key fingerprint to check on the first connection.
- **Deploy keys**: SSH keys for one repository, read-only unless the owner allows writes, for servers and CI without an account. Pushes made with one are attributed to whoever added it; once that account is deleted, to the repository's owner (for an organization's repository, the organization). A deploy key keeps working when the person who added it loses access and when the repository is transferred.
- **Public and private repositories.** Public means readable and cloneable by every account on the server; pushing always needs a role. An admin can also let visitors without an account browse and clone public repositories (**Admin → Access**).
- **Organizations** that own repositories, with owners, members and a base permission (read or write) for every org repository, and **teams** that give groups of members read or write on chosen repositories.
- **Code browser**: files with their last commit, syntax highlighting, raw and download links, branches and tags (including names with `/`), history, unified or split diffs, and a branch/tag picker that also creates a branch from the ref you're viewing (with write access; protected-branch rules apply as for a push). The repository home renders the README and shows languages, recent activity, stars and deployments.
- **Issues and pull requests**, sharing one number sequence per repository, with Markdown comments, labels (`bug`, `enhancement`, `documentation` and `question` to start with), up to 10 assignees, and filters by state, label and assignee. Merges happen on the server as a merge commit, with a compare-and-swap on the base branch. A pull request can be opened as a **draft**: it can't be merged until its author (or anyone with write access) marks it ready for review, and it can be turned back into a draft while it's open. `GET …/pulls?draft=true` (or `false`) lists only drafts (or only ready ones). Drafts still run `pull_request` workflows; code owners aren't asked to review until the draft is marked ready.
- **Stacked pull requests**: a pull request can go into another one's branch (`b` into `a`, `a` into `main`); each shows the whole stack in its sidebar, bottom first, and only its own changes. When the one below is merged with **Delete … after merging** (on by default when something is stacked on it), the ones stacked on it move to its base branch on their own, as on GitHub; a branch that stays keeps the pull requests going into it. The default branch and protected branches are never deleted on merge and never link a stack. **Change base** (or `PATCH …/issues/:number` with `base`) points an open pull request at another branch. Over the API, merge with `POST …/pulls/:number/merge` and `{"deleteBranch": true}`; the response says whether the branch was deleted (it stays when another open pull request still uses it) and which pull requests were retargeted.
- **Reviews**: Comment, Approve or Request changes, with inline comments on the lines of the diff, and review requests. **Require an approving review** in a repository's settings blocks merging until someone with write access approves (approvals stay valid when new commits are pushed), and **Require review from code owners** (below) until the owners of the changed files do.
- **Code owners**: a `CODEOWNERS` file in `.ether/`, `.github/`, the root or `docs/` of a pull request's base branch names who owns which files, as on GitHub (the last matching line decides; owners are `@user` or `@org/team` of the organization that owns the repository, and need write access). Opening a pull request, marking it ready or pushing to it asks the owners of its files for a review; a review by a team member with write access answers a team's request. The author's own approval never counts, so a group owned only by the author waits until someone fixes `CODEOWNERS` or turns the setting off. **Require review from code owners** blocks merging until each owned group of files has an approval from one of its owners. The file view shows who owns a file, and the `CODEOWNERS` file itself lists the lines Ether ignores (email owners, `!` and `[…]` patterns, malformed owner names, and whatever goes past its limits: 2000 rules, 512-character patterns, 50 owners per line; files over 256 KiB aren't read). Over the API the setting is `requireCodeOwnerReview` on `PATCH /api/repos/:owner/:repo`.
- **Notifications**: the bell in the header counts what concerns you, and **Notifications** lists it. You hear about `@mentions` (of you or a team you're in, outside code), comments, reviews, merges and closes on issues and pull requests you opened, commented on, reviewed or are assigned to, review requests (direct, through a team, or from `CODEOWNERS`), being assigned, and your own failed runs. You never hear about your own actions or about repositories you can't read (anymore). New activity on a thread updates its unread entry instead of adding another, and opening the issue or pull request marks it read. Editing an issue's or pull request's description doesn't notify anyone it newly mentions. Over the API: `GET /api/me/notifications` (50 at a time; `?filter=all` for read ones too), `GET /api/me/notifications/count` for the unread count, `PATCH /api/me/notifications/:id` with `{"read": false}` (or `true`), and `POST /api/me/notifications/read` to mark everything read.
- **Releases** from a tag (created from a branch if it doesn't exist yet), with Markdown notes, a pre-release flag, a source archive and uploaded files of up to 500 MB each.
- **Wikis**: every repository has one, stored as its own git repository (`<repo>.wiki.git`), so pages can be edited in the browser or cloned and pushed. Each page has its own history, and `[[Page]]` links work.
- **CI, deployments and runners**: workflows in `.ether/workflows/` in a format close to GitHub Actions, run in a container per job, on the Ether machine or on runners elsewhere. See [CI](#ci).
- **Protected branches**: rules per branch name or pattern (`main`, `release/*`, `hotfix/**`) that block direct pushes, force pushes and deletion over HTTPS and SSH, for everyone including owners. Each ref in a push is checked on its own, so a refused branch doesn't hold back the others. Merging a pull request stays possible; requiring pull requests doesn't require a review, so turn on approving reviews too if someone else should look first. If the check can't run, protected pushes are refused instead of let through.
- **Profiles** like GitHub's: avatar (animated GIFs kept), bio, pronouns, company, location, links, status, followers, pinned repositories, stars, a profile README from `<you>/<you>`, a contribution graph and recent activity, all limited to what the viewer can see. The contribution graph counts commits by the email addresses you claim under **Settings**, which suggests the addresses your pushes brought in.
- **Dashboard**: an activity feed from the repositories you can read, and your work: assigned issues, your open pull requests, review requests and starred repositories.
- **Invite-only accounts**, per-repository collaborators (`read` / `write`), a jump box in the header (search repositories, or type `#123` to open an issue or pull request), light/dark theme and a free accent colour per user.
- **Command-line tools**: `bun run ether` for administration, the Rust [`ether` client](#command-line-client) in the spirit of `gh`, and the [`ether-runner`](#ci) CI runner.

Not there (yet): renaming, transferring or archiving repositories, milestones, squash or rebase merges, blame, automatic `#123` links or rendered `@mention` links in Markdown, editing comments, and scoped tokens (a token acts with all of its owner's rights). [docs/FEATURES.md](docs/FEATURES.md) maps each feature to its code and tests.

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
| `ETHER_CI_RUNNER_TIMEOUT` | `90` | Seconds an external runner may stay silent before it loses its job (at least 5) |
| `ETHER_CI_MEMORY` / `ETHER_CI_CPUS` / `ETHER_CI_PIDS` | `4g` / `2` / `1024` | Limits for each CI job container on the Ether machine |
| `ETHER_WEB_DIST` | `dist/client` | Folder of the built web app to serve |
| `ETHER_ADMIN_PASSWORD` | | Password for `create-admin` when `--password` is left out |

## Example deployment: a Tailscale tailnet

`scripts/deploy.ps1` builds Ether and registers a logon task that runs `scripts/start.ps1`. It then publishes the server to your tailnet with `tailscale serve --https=443`, and git over SSH with `tailscale serve --tcp=2222`. Ether only ever listens on `127.0.0.1`, so it can't be reached from the LAN or the internet. Don't use `tailscale funnel`.

On a tailnet, first share the machine with the person in the Tailscale admin console (or invite them to the tailnet).

## Adding people

1. Create an invite link in **Admin** (account menu, top right), or run `bun run ether invite --by <you>`. Send them the link.
2. Give them access: make a repository public, add them as a collaborator in its **Settings**, or add them to an organization.
3. They create a personal access token in **Settings** and use it as the git password.

Without an account, nobody can see anything unless an admin ticks **Admin → Access → Let visitors without an account read public repositories**. Visitors can then browse and clone public repositories (over HTTPS, not SSH) and read their issues and pull requests. Leave it off if people outside your team can reach the server.

Forgotten password (anyone's): `bun run ether reset-password <username> --password '<new password>'`. It signs that account out everywhere; their access tokens keep working.

Backups: `bun run ether backup <dir>` writes a timestamped snapshot while the server keeps running: a consistent SQLite copy (`VACUUM INTO`), every bare repo copied refs-first (so a push during the backup can't leave refs pointing at missing objects) along with wikis, avatars, release files, the SSH host key and the auth secret. If you set `BETTER_AUTH_SECRET` instead of using the generated file, keep that value with your backups: CI secrets can't be decrypted without it.

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
        description: Only print what would change
        default: false               # inputs also take required: true
jobs:
  deploy:
    env:
      DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}   # set under the repository's Settings → CI secrets
    steps:
      - run: ./scripts/deploy.sh "$CI_INPUT_TARGET"
        shell: bash                  # bash (default when installed) or sh; pwsh if the image has it; powershell and cmd only outside containers
        env:
          RETRIES: 3                 # plain values work too
```

**When workflows run.** `on:` takes `push`, `pull_request`, `workflow_dispatch` and `schedule`, as a name, a list or a map with filters:

- `push` runs when a branch or tag moves to a new commit, including when a pull request is merged into a branch. Naming only `branches` leaves tags out and the other way round; naming neither takes both. As on GitHub, a push of more than three tags at once (`git push --tags`, a mirror) starts nothing for its tags. Patterns use `*` (within one `/` segment), `**` and `?`, and in a list a later `!pattern` takes a match back.
- `pull_request` runs on the pull request's head commit when it is opened or reopened and whenever its branch moves (`types: [opened, synchronize, reopened]`, all three by default), and with `ready_for_review` in `types` when a draft is marked ready. `github.event.pull_request.draft` says whether it is a draft, so a job can skip drafts with `if: ${{ !github.event.pull_request.draft }}`.
- `paths` and `paths-ignore` look at the files the push changed (for a new branch, what it has beyond the default branch; for a pull request, what it would bring in). They don't apply to tags, or when more than 1000 files changed.
- `workflow_dispatch` lets anyone with write access start the workflow on a branch from the **CI** tab, or with `POST /api/repos/:owner/:repo/ci/workflows/dispatch` and `{"workflow": ".ether/workflows/deploy.yml", "ref": "main", "inputs": {…}}`. Inputs are checked against their type, and the workflow is read from that branch.
- `schedule: [{ cron: "30 5 * * 1-5" }]` runs the workflow as it is on the default branch, at its latest commit, on a cron schedule in UTC (minute, hour, day of month, month, day of week; `*`, lists, ranges, `/` steps and names such as `MON` or `JAN`). As on GitHub the shortest interval is five minutes (also across a workflow's crons together), minutes the server was down aren't made up, and the run sees the cron that started it as `github.event.schedule`. A scheduled run has no actor, so its failures show up on the **CI** tab but in nobody's feed.

**Expressions.** `${{ … }}` works as on GitHub in a job's `if:`, `runs-on:`, `image:` and `outputs:`, and in a step's `name:`, `run:`, `env:` and `if:`. It has `==`, `!=`, `<`, `>`, `&&`, `||`, `!`, `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `success()`, `failure()`, `always()` and `cancelled()`, and the contexts `github` (`ref`, `ref_name`, `ref_type`, `sha`, `event_name`, `repository`, `actor`, `workflow`, `run_id`, `head_ref`, `base_ref`, `event.schedule`), `inputs`, `matrix`, `needs`, and in steps also `steps`, `env` and `secrets`. A step writes outputs to the file in `$CI_OUTPUT` (`name=value`, or `name<<DELIMITER` for several lines), which later steps read as `steps.<id>.outputs.<name>`, and a job's `outputs:` pass them on as `needs.<job>.outputs.<name>`; an output that holds a secret is dropped. A step's `if:` can run it after a failure, and `continue-on-error: true` lets the job go on. An expression in `run:` becomes part of the script, so a branch name in it could change what the script does: pass such values through `env:` instead.

**Jobs** run side by side, up to `ETHER_CI_JOBS` at a time across the server, each from its own fresh checkout. A job with `needs:` starts once the jobs it names have finished, and by default only if they all succeeded; otherwise it is skipped, and so is whatever needs it. `if:` changes that with one of `success()`, `failure()` (a job before it failed, however far up the chain), `always()` or `cancelled()`, optionally negated with `!` or written as `${{ … }}`. Cancelling a run stops everything, `always()` jobs included. An environment takes one deploy job at a time, in push order: a deploy job also waits while an older run of the same branch or tag still has one for that environment queued behind its needs. An older one that waits for a review or a timer doesn't hold it back; it is skipped once the newer one deploys, so an older commit can't land after a newer one. `strategy.matrix` runs a job once per combination of its lists, with `include` and `exclude` as on GitHub (at most 256 combinations, 100 jobs per run); each gets its values as `CI_MATRIX_<KEY>`. With `fail-fast` (the default) the first combination that fails cancels the others; `max-parallel` limits how many run at once.

Other events (`pull_request_target`, `release`, …), `uses:` actions aren't supported (yet); a workflow that uses an unknown event is refused with a message saying so. Keys Ether doesn't know, such as `services:`, `container:`, `concurrency:`, `working-directory:` or a job-level `timeout-minutes:`, are ignored without a warning, so check that a job does what you expect. A workflow has at most 20 jobs. A workflow file that doesn't parse shows up as a failed run on the next push. The older single `.ether/ci.yml` still works: it may leave out `on:` and then runs on every push to a branch, like before.

Each run is one workflow for one commit. Steps get `CI`, `CI_REPOSITORY`, `CI_COMMIT_SHA`, `CI_REF` (the branch or tag), `CI_REF_TYPE` (`branch` or `tag`), `CI_EVENT`, `CI_WORKFLOW`, for pull requests `CI_PULL_REQUEST` and `CI_BASE_REF`, a manual run's inputs as `CI_INPUT_<NAME>` (upper case, `-` becomes `_`), `CI_JOB` (the job's id in the workflow), and the `env` they ask for, never Ether's own settings. Runs and logs are under the repository's **CI** tab, by workflow, where people with write access can cancel or re-run them (also `POST /api/repos/:owner/:repo/ci/runs/:id/cancel` and `…/rerun`; `GET …/ci/runs/:id` returns the jobs with their logs). Pull requests show the newest run of each workflow for their head commit as checks (their own `pull_request` runs, not another pull request's from the same branch; manual runs don't count), and **Require passing checks before merging** blocks merges until they all pass.

**Where jobs run.** By default each job gets its own container, from Docker or Podman on the Ether machine (whichever is installed, or `ETHER_CI_RUNTIME`). The checkout is copied in, not mounted, so a job can't see Ether's data folder or anything else on the host. The container runs with `no-new-privileges`, without raw sockets, and capped at `ETHER_CI_MEMORY` (default `4g`), `ETHER_CI_CPUS` (`2`) and `ETHER_CI_PIDS` (`1024`) processes, and it is removed when the job ends. Jobs still have network access, for example to install packages. The default image is `ETHER_CI_IMAGE`, or `oven/bun:1`. Without a container runtime, jobs fail with a message saying so.

An admin can instead choose **On this machine, as the user Ether runs as** (the behaviour before containers, and the only option without Docker or Podman, for example on Windows without Docker Desktop). Those jobs can read Ether's data folder, including the database and auth secret, so everyone with write access to a repository with CI controls the server. Jobs that use secrets are refused in this mode.

**Runners on other machines.** Under **Admin → Runners**, **Add runner** shows a one-time command for the other machine. Build the program with `bun run build:runner` (`dist/ether-runner`, a single file for the platform it's built on), then:

```bash
ether-runner register --url https://ether.example.com --token <token> --name build-1
ether-runner run --jobs 2            # jobs at a time on this machine, 1 by default
```

The registration is saved to `~/.config/ether-runner/config.json` (under `XDG_CONFIG_HOME` if set); `--config <file>` on both commands uses another file, for example to run two runners on one machine. A runner only ever calls the server, so its machine needs no open port. Jobs run in a container per job with Docker or Podman on that machine; `--isolation host` runs them directly as the runner's user instead, which gives everyone who can push on the server that machine, including the runner's token and with it the code of other repositories' jobs. Such a runner gets no secrets, but use it only if you trust everyone who can push. A runner keeps the isolation it registered with; to change it, remove it and register again. A job with secrets waits for a runner with containers if there is one, and otherwise fails with the reason. Once a runner covers a repository, its jobs go to runners and the built-in one stops taking them, even while no runner is online, so they wait rather than land on the Ether machine; removing the last one brings it back. Every job gets a token of its own that can read just its repository until the job ends, and its secrets, which the runner keeps in memory only. A runner silent for `ETHER_CI_RUNNER_TIMEOUT` seconds (90) loses its job. Use HTTPS: jobs carry their secrets over this connection.

**Choosing runners.** `ether-runner register --labels linux,gpu` names what a runner offers, and `runs-on: gpu` or `runs-on: [linux, gpu]` makes a job wait for a runner with all of those. A job that asks for labels never runs on the built-in runner; to mix, run a runner on the Ether machine itself. Under an environment's rules, **Runner labels** does the same for every deployment there, and a workflow can't drop it. Besides **Admin → Runners**, owners can add runners under a repository's or an organization's settings: those run only that repository's or organization's jobs, and from then on its jobs wait for a runner rather than use the built-in one. Server-wide runners can still take them, along with their secrets, so use `runs-on` with a label only your runner has to keep them on it. `runs-on: ${{ matrix.os }}` works too.

**Secrets.** Owners add them under **Settings → CI secrets**. Values are encrypted in the database with a key derived from the auth secret (so a backup restores them along with it), can't be read back through the API or the UI, and are masked as `***` in logs (values shorter than four characters aren't masked). They reach a job only as the environment variables it names, and only in a container. Masking only prevents accidents: anyone who can push to the repository can write a workflow that prints a secret in another form, so only store what everyone with write access may know. If the auth secret changes (for example a new `BETTER_AUTH_SECRET`), jobs report that a secret can't be decrypted until it's set again.

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
- **Wait timer**: minutes the job waits before it starts, counted from the approval (or from when the job was queued when no approval is needed).
- **Secrets**: like CI secrets, but only for jobs deploying to this environment, where they replace a repository secret of the same name.

A waiting job steps out of the CI queue, so other runs go on, and the run shows as **Waiting** until it continues or is cancelled. Deploy jobs don't count as a pull request's checks: one that waits, is skipped or fails doesn't block **Require passing checks before merging**. Steps get `CI_ENVIRONMENT` with the environment's name. The repository home lists each environment with the commit it currently runs; a pull request whose head commit runs somewhere says **Deployed to …**. `GET /api/repos/:owner/:repo/deployments?environment=…` returns the history.

Reviewers and wait timers decide whether a deployment *starts*, not what it does. Anyone who can push can change the workflow, so keep the credentials that reach production in production's environment secrets: then only a job that passed its rules gets them.

## Command-line client

`cli/` is a Rust client in the spirit of GitHub's `gh`, built as `ether`:

```sh
cd cli && cargo build --release        # binary at cli/target/release/ether(.exe)
echo "$TOKEN" | ether auth login --host https://ether.example.com --with-token
ether auth status                      # who you are; `auth logout` forgets the token (it stays valid)
ether repo create my-tool --public     # or --org acme; --description "…"
ether repo list | view ada/my-tool
ether repo clone ada/my-tool [dir]     # git push/pull then use your login
ether issue create --title "Bug" --body "Steps…"
ether issue list --state closed | view 3 | comment 3 --body "…" | close 3 | reopen 3
ether pr create --title "Fix it"       # head = current branch, base = default branch; --head, --base, --body
ether pr list | view 4 | merge 4 | checkout 4
ether api /api/me                      # any endpoint, JSON out
ether api -X POST /api/repos --input '{"name":"x"}'
```

`view`, and `list` for issues and pull requests, take `--json`. Inside a clone the repository is taken from `origin` (an HTTPS remote on the server you're logged in to); elsewhere pass `-R OWNER/REPO` (`repo view` takes it as an argument). The token is stored in your config directory (`ETHER_CONFIG_DIR` overrides it, `ETHER_HOST` picks another server you've logged in to), and the API accepts it as `Authorization: Bearer <token>`. This is separate from the server's admin commands (`bun run ether …`).

## Tests

`bun run test:e2e` builds the app, boots a real server on a random port against a throwaway data directory, and drives the git CLI and Chromium. Each run writes a timestamped report to `e2e-report/<timestamp>/`, containing an HTML report with screenshots, `results.json` and `server.log`. Install the browser once with `bunx playwright install chromium`.

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, tests and how reviews work. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
