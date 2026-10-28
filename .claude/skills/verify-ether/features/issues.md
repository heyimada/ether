# Issues

People with access open issues with a Markdown body, discuss them in comments, triage them with labels and assignees, and close them. The issue list separates open and closed issues.

## Sub-features

- `issue-create` opens an issue with a title and a rendered Markdown body, numbered `#N` per repository (shared with pull requests).
- `issue-comment` adds a comment to the timeline.
- `issue-labels` applies labels from the `Edit labels` menu. New repositories start with `bug`, `enhancement`, `documentation` and `question`.
- `issue-assignees` assigns people with write access from the `Edit assignees` menu.
- `issue-close` closes the issue. It disappears from the open list and appears under `Closed`.

## How to get to it (user POV)

- Repository page, `navigation "Repository"`, `link "Issues"` (`/<owner>/<repo>/issues`), then `link "New issue"`.
- An issue at `/<owner>/<repo>/issues/<number>`.
- The labels page at `/<owner>/<repo>/labels` creates new labels.

## Driving it with verify-ether

Preconditions:

- `doctor.sh` exits 0.
- An empty repository owned by `admin`, created with `admin.post("/api/repos", { data: { name, description: "" } })`.
- Signed in as `admin` through `uiLogin()`.

Run the whole journey with `ETHER_VERIFY_RUN="$RUN_DIR" .claude/skills/verify-ether/scripts/drive.ts issues`.

- **Open the form.** Click `navigation "Repository"`, then `link "Issues"`, then `link "New issue"`. The `Title` and `Body` fields appear.
- **Create.** Fill `Title` with `Build is broken` and `Body` with `Steps:\n\n1. run it\n2. **boom**`, then click `button "Submit new issue"`. A heading matching `/Build is broken/` appears and `strong` reads `boom`.
- **Label.** Click `button "Edit labels"`, then `menuitemcheckbox /bug/`, then press `Escape`. `list "Issue labels"` contains `bug`.
- **Comment.** Fill `getByLabel("Comment")` and click `button "Comment"` (`exact: true`). The text `Looking into it` appears in the timeline.
- **Close.** Click `button "Close issue"`. The state badge reads `Closed`.
- **List views.** Go back to `link "Issues"`. `link "Build is broken"` has count 0. Click `link /Closed/` and the issue link is visible.
- **Side effect.** `admin.get("/api/repos/<owner>/<repo>/issues/1")` returns `issue.state == "closed"`, `issue.labels` containing `bug`, and `comments` containing the comment body. It's written to `issue-1.json`.

## Gotchas

- Issues and pull requests share one number sequence. Create an issue before a pull request and the pull request becomes `#2`.
- `button "Comment"` needs `exact: true`. Otherwise it also matches the `Comment` field label and other buttons.
- The labels and assignees menus are Radix menus. Press `Escape` to close them before you interact with the rest of the page.
- Only writers can change labels and assignees. A reader sees them without the edit buttons, as `e2e/labels.spec.ts` checks.
