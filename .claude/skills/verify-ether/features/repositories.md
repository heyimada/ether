# Repositories

A signed-in user creates a repository from the dashboard, pushes to it over HTTPS with a personal access token, and browses the rendered README, the file tree and a file. A clone returns what was pushed.

## Sub-features

- `repo-create` creates an empty private repository and shows the quick-setup clone URL.
- `repo-push-https` accepts a push over smart HTTP authenticated with a token.
- `repo-readme` renders the root `README.md` as sanitized Markdown.
- `repo-tree` browses directories and opens a file with its contents.
- `repo-clone` clones the repository over HTTPS.

## How to get to it (user POV)

- Dashboard (`/`): `New repository` link, which leads to `/new`.
- After a push, `/<owner>/<repo>` shows the README. Directories link to `/<owner>/<repo>/tree/<ref>/<path>` and files to `/<owner>/<repo>/blob/<ref>/<path>`.
- `git push http://127.0.0.1:<port>/<owner>/<repo>.git main` with the username and a token as the password.

## Driving it with verify-ether

Preconditions:

- `doctor.sh` exits 0.
- Signed in as `admin` through `uiLogin()`.

Run the whole journey with `ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts repositories`.

- **Open the form.** `page.getByRole("link", { name: "New repository" }).click()`. The `Repository name` and `Description` fields appear.
- **Create.** Fill `getByLabel("Repository name")` and `getByLabel("Description")`, then `getByRole("button", { name: "Create repository" }).click()`. The URL becomes `/<owner>/<name>` and `Quick setup` is visible.
- **Push.** Run `gitOk(src, ["push", cloneUrl(run, owner, name), "main"], { username, token })` with a token from `createToken(await api(run))`. The transcript shows exit 0.
- **README.** Reload the page. `getByRole("article", { name: "README" })` contains the heading `Verify Ether` and `<strong>over HTTPS</strong>`.
- **Tree and file.** Click `link "src"` (`exact: true`), then `link "main.ts"`. `getByRole("region", { name: "File contents" })` contains `export const answer = 42;`.
- **Side effect.** `bareGit(run, owner, name, ["show-ref"])` lists `refs/heads/main` at the local `HEAD` sha. It's written to `bare-refs.txt`.
- **Clone.** `gitOk(dir, ["clone", cloneUrl(...), "c"], auth)` exits 0.

## Gotchas

- New repositories are private. A second user sees a 404 until they're a collaborator or the repository is public.
- The repository page shows `Quick setup` only while the repository is empty. Assert it before the push.
- Branch names with `/` work in tree URLs (`/tree/feature/nested-name`). `e2e/ui.spec.ts` covers that case.
- Use `gitOk` from `lib.ts`, never plain `git push`. On macOS an ordinary push stores the token in the Keychain.
