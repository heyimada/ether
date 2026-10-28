# Access tokens

Users generate personal access tokens in Settings and use them as the git password over HTTPS (and as `Authorization: Bearer` for the API and the Rust client). A token is shown once, records when it was last used, and stops working the moment it's revoked.

## Sub-features

- `token-generate` creates a named token and shows its value once.
- `token-git-auth` authenticates git over HTTPS as `<username>:<token>`.
- `token-last-used` shows `last used …` on the token row after a use.
- `token-revoke` removes the token, after which git is refused.

## How to get to it (user POV)

- Account menu, then **Settings** (`/settings`), then the **Access tokens** section with `Token name` and `button "Generate token"`.
- **Your tokens** list: one `listitem` per token with a `Revoke` button.

## Driving it with verify-ether

Preconditions:

- `doctor.sh` exits 0.
- An empty repository owned by `admin` to run `ls-remote` against.
- Signed in as `admin` through `uiLogin()`.

Run the whole journey with `ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts access-tokens`.

- **Generate.** Run `page.goto("/settings")`, fill `getByLabel("Token name")` with a `unique("laptop")` name, and click `button "Generate token"`. `getByLabel("New token")` holds the token value and the name appears under **Your tokens**.
- **Use.** Run `git(workdir(), ["ls-remote", cloneUrl(...)], { username: "admin", token })`. It exits 0.
- **Last used.** Reload the page. `getByRole("listitem").filter({ hasText: tokenName })` contains `last used`.
- **Revoke.** On that row, click `button "Revoke"`. The token name disappears from the page.
- **Side effect.** Repeat the same `git ls-remote`. It exits non-zero, which proves the server refuses the revoked token, not only that the UI hid it.

## Gotchas

- Other journeys create tokens through the API. Scope assertions to your token's row, not to the page. `getByText(/last used/)` matches several rows.
- The token value is shown only once. Read it from `getByLabel("New token")` before you navigate away.
- Passwords don't work for git. Only tokens and SSH keys do.
- Tokens survive `bun run ether reset-password`, which only signs out sessions.
