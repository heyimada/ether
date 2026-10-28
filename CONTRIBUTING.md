# Contributing to Ether

Thanks for helping out. This guide covers how to set up a development copy, what CI checks, and how issues and pull requests move along.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Before you start

- **Bugs:** search the [open issues](https://github.com/heyimada/ether/issues) first. If none matches, open one with the bug report form.
- **Features and larger changes:** open a feature request and wait for a maintainer's response before you write a lot of code. Ether is deliberately scoped for a small group of trusted people, so some features don't fit. Agreeing on the shape first saves you from rewriting.
- **Small fixes** (typos, docs, obvious one-line bugs): send the pull request directly.
- **Looking for something to do:** issues labelled [`good first issue`](https://github.com/heyimada/ether/labels/good%20first%20issue) are small and well described, and [`help wanted`](https://github.com/heyimada/ether/labels/help%20wanted) marks work the maintainers would welcome help on. Leave a comment before you start so two people don't do the same work.

## Development setup

You need:

- [Bun](https://bun.sh) 1.4 or later
- Git
- An OpenSSH client (`ssh`, `ssh-keygen`) for the SSH tests
- A Rust toolchain ([rustup](https://rustup.rs)), only if you work on `cli/` or run the full e2e suite

```sh
git clone https://github.com/heyimada/ether.git
cd ether
bun install
bun run ether create-admin admin --password 'admin-password-1'
```

Run the server and the web app in two terminals:

```sh
bun run dev:server   # Elysia on http://127.0.0.1:3000, restarts on change
bun run dev:web      # Vite on http://localhost:5173, proxies /api and git to the server
```

Open http://localhost:5173 and sign in. Your development data lives in `./data` (gitignored). To start fresh, stop the server and delete that folder. Point `ETHER_DATA` at another folder to keep several setups side by side.

## Project layout

| Path | What's there |
|---|---|
| `src/server/` | Bun + Elysia server: API routes (`routes/`), git smart HTTP and SSH, access control (`access.ts`), CI runner, admin CLI (`cli.ts`) |
| `src/server/db/` | Drizzle schema (`schema.ts`), Better Auth tables (`auth-schema.ts`), SQLite client |
| `drizzle/` | SQL migrations, applied automatically on startup |
| `src/web/` | TanStack Start SPA: routes, components, styles |
| `cli/` | The `ether` command-line client, in Rust |
| `e2e/` | Playwright end-to-end tests against a real server |
| `scripts/` | Deployment helpers and the Better Auth schema generator config |
| `design/` | Design briefs and mockups. These are historical, so treat the README and the code as the source of truth. |

## Making changes

### Database schema

Edit `src/server/db/schema.ts`, then generate a migration:

```sh
bunx drizzle-kit generate --name <short_description>
```

Commit the new `drizzle/*.sql` file and the updated `drizzle/meta/` together with the schema change. Never edit a migration that is already on the main branch. Add a new one instead.

The Better Auth tables in `auth-schema.ts` are generated from `scripts/auth-gen.ts` with Better Auth's `generate` command. Regenerate them if you change `src/server/auth-plugins.ts`.

### Access control

Anything that reads or changes a repository, issue, profile or organization must go through the checks in `src/server/access.ts`. Feeds, search, profiles and activity must only show what the viewer can read. If your change exposes new data, add an e2e test that signs in as a user *without* access and checks that they can't see it.

### Command-line client

```sh
cd cli
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo build
```

## Tests

```sh
bun run typecheck                 # needs src/web/routeTree.gen.ts, which `bun run build` or `dev:web` generates
bunx playwright install chromium  # once
bun run test:e2e                  # builds, boots a throwaway server, drives git and Chromium
bun run test:e2e -- e2e/git.spec.ts   # one file
```

The e2e suite boots a real server against a temporary data folder. It never touches `./data`. Each run writes a report to `e2e-report/<timestamp>/`, with an HTML report and screenshots in `html/` and the server's output in `server.log`. Look there first when a test fails.

New behavior needs an e2e test. Write it the way the existing specs read: one user-visible story per test, named as a sentence that describes the behavior.

## Commits and pull requests

**Commit messages.** Write the subject as a short imperative sentence that says what changes for the user or the code, as in `Keep wiki temp index out of repos/`. Don't use a `feat:`/`fix:` prefix. When the change needs it, add a body that explains what changed and why.

**Pull requests:**

1. Fork the repository and create a branch from the default branch.
2. Keep one pull request to one change. Split unrelated fixes into separate pull requests.
3. Fill in the pull request template. Link the issue with `Fixes #123` so it closes on merge.
4. Make sure CI passes. It runs the build, typecheck, `cargo fmt`/`clippy`/`build` for `cli/`, and the full e2e suite. When the e2e suite fails, download the `e2e-report` artifact from the workflow run to see screenshots and the server log.
5. Include a screenshot or short recording for UI changes, in light and dark theme if colors are involved.
6. Update `README.md` when you change commands, environment variables, setup steps or user-facing behavior.

A maintainer reviews the pull request and may ask for changes. Push follow-up commits to the same branch instead of opening a new pull request. If a pull request goes quiet for a while, a polite ping in the thread is welcome.

## Issue labels

| Label | Meaning |
|---|---|
| `bug` | Something doesn't work as documented |
| `enhancement` | A new feature or an improvement to an existing one |
| `documentation` | Docs only |
| `question` | Needs an answer, not code |
| `good first issue` | Small, self-contained and well described. Good for a first contribution. |
| `help wanted` | The maintainers would welcome a pull request |
| `server`, `web`, `cli`, `e2e`, `ci` | The area a pull request touches. Added automatically from the changed paths. |

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
