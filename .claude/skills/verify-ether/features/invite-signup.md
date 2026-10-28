# Invite sign-up

Ether is invite-only. An admin creates an invite link, a newcomer opens it, picks a username and password, and lands signed in on their dashboard. Each link works once, and an anonymous visitor without one is told that the instance is invite-only.

## Sub-features

- `invite-create` generates a link in **Admin** (or with `bun run ether invite --by <admin>`).
- `invite-only-notice` shows anonymous visitors that sign-up needs an invite.
- `invite-register` prefills the invite code from the link and creates the account.
- `invite-single-use` refuses a second registration with the same link.

## How to get to it (user POV)

- `button "Account menu"`, then `menuitem "Admin"` (`/site-admin`), then `button "Create invite link"`. The link is in `getByLabel("Invite link")`.
- The newcomer opens `/register?code=<code>`.
- Terminal: `ETHER_DATA=<run data dir> bun src/server/cli.ts invite --by admin` prints the link.

## Driving it with verify-ether

Preconditions:

- `doctor.sh` exits 0.
- Signed in as `admin` through `uiLogin()`.

Run the whole journey with `ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts invite-signup`.

- **Create invite.** Click `button "Account menu"`, then `menuitem "Admin"`, then `button "Create invite link"`. `getByLabel("Invite link")` holds `…/register?code=…`.
- **Anonymous notice.** In a fresh page (`newPage(b, run)`), go to `/`. The text `/invite-only/i` is visible.
- **Register.** Go to the link's path and query. `getByLabel("Invite code")` is not empty. Fill `Username` and `Password` (at least 10 characters) and click `button "Create account"`. The heading `Welcome, <username>` appears.
- **Single use.** In another fresh page, open the same link and register a different username. `getByRole("alert")` contains `/invite/i`.
- **Side effect.** `api(run, username, "friend-password-123")` signs in, so the account exists with that password.

## Gotchas

- Use a fresh browser context for the newcomer. Reusing the admin's page keeps the admin's session cookie.
- Usernames are limited in length. The journey trims `unique()` names to 30 characters.
- The CLI invite prints a URL built from `ETHER_PUBLIC_URL`. On a verify instance that's `http://127.0.0.1:<port>`, but only if `ETHER_PORT` is exported for the CLI call too.
