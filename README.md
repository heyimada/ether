# Ether

A self-hosted alternative to GitHub Enterprise: code hosting, review and collaboration on a server you control. Run it on a VPS, a home server or your own machine behind a private network such as a Tailscale tailnet.

- **Git over HTTPS** (smart HTTP, streamed in both directions), authenticated with personal access tokens.
- **Public and private repositories.** Public means readable and cloneable by every account on the server; pushing always needs a role.
- **Organizations** that own repositories, with owners, members and a base permission (read or write) for every org repository.
- **Code browser**: files with their last commit, branches and tags (including names with `/`), history, diffs, and a branch/tag picker.
- **Issues and pull requests**, sharing one number sequence per repository. Merges happen on the server with a compare-and-swap on the base branch.
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
| `BETTER_AUTH_SECRET` | generated into `data/auth-secret` | Session signing secret |

## Example deployment: a Tailscale tailnet

`scripts/deploy.ps1` builds Ether and registers a logon task that runs `scripts/start.ps1`. It then publishes the server to your tailnet with `tailscale serve --https=443`. Ether only ever listens on `127.0.0.1`, so it can't be reached from the LAN or the internet. Don't use `tailscale funnel`.

On a tailnet, first share the machine with the person in the Tailscale admin console (or invite them to the tailnet).

## Adding people

1. Create an invite link in **Admin** (account menu, top right), or run `bun run ether invite --by <you>`. Send them the link.
2. Give them access: make a repository public, add them as a collaborator in its **Settings**, or add them to an organization.
3. They create a personal access token in **Settings** and use it as the git password.

Forgotten password (anyone's): `bun run ether reset-password <username> --password '<new password>'`. It signs that account out everywhere; their access tokens keep working.

Backups: `bun run ether backup <dir>` writes a consistent SQLite snapshot (`VACUUM INTO`), the bare repos and the auth secret.

## Tests

`bun run test:e2e` builds the app, boots a real server on a random port against a throwaway data directory, and drives the git CLI and Chromium. Each run writes a timestamped report to `e2e-report/<timestamp>/`, containing an HTML report with screenshots, `results.json` and `server.log`.
