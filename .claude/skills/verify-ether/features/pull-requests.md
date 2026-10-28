# Pull requests

A writer opens a pull request from a pushed branch by comparing it with a base branch, reads the diff under `Files changed`, and merges it on the server. The base branch in the bare repository then contains the change.

## Sub-features

- `pr-compare` picks the `Base` and `Compare` branches and previews the changed files.
- `pr-open` creates the pull request, numbered in the issue sequence.
- `pr-files` renders the diff in `region "Diff"`.
- `pr-merge` merges on the server with a compare-and-swap on the base branch.
- `pr-conflict` disables `Merge pull request` and mentions conflicts when the branches conflict (see `e2e/ui.spec.ts`).
- `pr-reviews` requests reviewers, adds line comments, approves or requests changes, and can require an approving review before merging (see `e2e/reviews.spec.ts`).

## How to get to it (user POV)

- Repository page, `navigation "Repository"`, `link "Pull requests"` (`/<owner>/<repo>/pulls`), then `link "New pull request"` (`/<owner>/<repo>/pulls/new`).
- A pull request at `/<owner>/<repo>/pull/<number>`, with tabs `Conversation`, `Commits` and `Files changed` (`?tab=files`).
- From the terminal: `ether pr create` and `ether pr merge` in the Rust client (`cli/`).

## Driving it with verify-ether

Preconditions:

- `doctor.sh` exits 0.
- A repository owned by `admin` with `main` (`README.md`) and `topic/add-file` (adds `added.txt` with `brand new file`), pushed with `gitOk(..., ["push", "-q", url, "main", "topic/add-file"], auth)`.
- Signed in as `admin` through `uiLogin()`.

Run the whole journey with `ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts pull-requests`.

- **Compare.** Click `link "Pull requests"`, then `link "New pull request"`. Run `getByLabel("Base").selectOption("main")` and `getByLabel("Compare").selectOption("topic/add-file")`. The text `added.txt` appears.
- **Open.** Fill `Title` with `Add added.txt` and click `button "Create pull request"`. The state badge reads `Open`.
- **Diff.** Click `link "Files changed"`. `region "Diff"` contains `brand new file`.
- **Merge.** Click `link "Conversation"`, then `button "Merge pull request"`. The state badge reads `Merged` and the timeline says `merged this pull request in <sha>`.
- **Side effect.** `bareGit(run, owner, repo, ["ls-tree", "--name-only", "refs/heads/main"])` lists `added.txt`. The before and after refs go to `bare-refs-before.txt` and `bare-main-after.txt`, and the API view of the pull request goes to `pull-1.json`.

## Gotchas

- The `Compare` options only list branches that exist on the server. Push the branch before you open the form.
- The `Open` and `Merged` texts appear in several places. Use `.first()` with `exact: true`.
- With `Require approving reviews` on (a branch protection rule), the merge button stays disabled and the page says `Merging requires an approving review`.
- With `Require passing checks before merging`, the merge waits for CI. CI needs Docker or Podman and an admin's opt-in under **Admin, Access**.
