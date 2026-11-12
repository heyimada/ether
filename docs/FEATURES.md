# Feature map

Where each user-visible feature lives in the code, and which end-to-end spec covers it. The [README](../README.md) explains how to use the features; this page is for finding your way around the source. Server paths are under `src/server/` and web paths under `src/web/`, unless a path says otherwise.

## Accounts and access

| Feature | What it does | Server | Web | e2e |
|---|---|---|---|---|
| Sign-in and sessions | Username and password through Better Auth. Sessions last 30 days, and passwords need at least 10 characters. | `auth.ts`, `auth-plugins.ts` | `routes/login.tsx` | `auth.spec.ts` |
| Invites | Admins create one-time links that expire after 7 days, in the UI or with `bun run ether invite`. | `routes/account.ts`, `cli.ts` | `routes/register.tsx`, `routes/_authed.site-admin.tsx` | `auth.spec.ts`, `signup.spec.ts` |
| Personal access tokens | `eth_…` tokens. They're sent as `Authorization: Bearer` to the API, or as the HTTP password for git. They have no scopes and act with the owner's full rights. | `routes/account.ts` | `routes/_authed.settings.tsx` | `ui.spec.ts` |
| Roles | A repository's role (`read`, `write` or owner) comes from the owner, org owners, the org's base permission, collaborators, teams, or public visibility. A repository you can't read returns 404. | `access.ts` | | `orgs.spec.ts`, `teams.spec.ts` |
| Anonymous read | Admin setting: visitors without an account can browse and clone public repositories and read their issues and pull requests. | `access.ts`, `routes/account.ts` | `routes/_authed.site-admin.tsx` | `anonymous.spec.ts` |
| Organizations | Owners and members, and a base permission (read or write) on every org repository. An org needs at least one owner. | `routes/orgs.ts` | `routes/_authed.organizations.*.tsx` | `orgs.spec.ts`, `overview.spec.ts` |
| Teams | Groups of org members that get read or write access to chosen org repositories. | `routes/orgs.ts` | `components/teams.tsx` | `teams.spec.ts` |
| Profiles | Avatar (GIFs keep their animation), bio, pronouns, links, status, followers, up to 6 pinned repositories, and a profile README. | `routes/profiles.ts` | `routes/_authed.$owner.index.tsx`, `components/profile-settings.tsx` | `profile.spec.ts`, `tabs.spec.ts` |
| Commit emails | Pushes record author emails. Users claim them (up to 10) so their commits count toward them. | `contrib.ts` | `components/profile-settings.tsx` | `contributions.spec.ts` |
| Contribution graph | The last 365 days of commits, pull requests, issues and reviews, counting only repositories the viewer can read. | `routes/profiles.ts` | `routes/_authed.$owner.index.tsx` | `contributions.spec.ts` |
| Appearance | Light, dark or system theme, and an accent colour per user that is adjusted for contrast. | `routes/account.ts` | `lib/accent.ts`, `routes/__root.tsx` | `accent.spec.ts` |

## Git

| Feature | What it does | Server | e2e |
|---|---|---|---|
| Smart HTTP | Clone, fetch and push, streamed in both directions. | `smart-http.ts`, `routes/git.ts` | `git.spec.ts` |
| SSH | Public-key login on port 2222, git protocol v2. The host key fingerprint is shown in Settings. | `ssh.ts`, `ssh-relay.ts`, `routes/ssh-keys.ts` | `ssh.spec.ts` |
| Deploy keys | SSH keys for one repository, read-only unless writes are allowed. | `routes/deploy-keys.ts` | `ssh.spec.ts` |
| Protected branches | Rules by name or pattern that block direct pushes, force pushes and deletion. An update hook enforces them, and refuses protected pushes if the check can't run. | `branch-rules.ts`, `protection.ts`, `hooks/update.ts`, `routes/branch-protection.ts` | `protection.spec.ts` |
| Backup and restore | `bun run ether backup` and `restore`. | `cli.ts`, `backup-copy.ts` | `backup.spec.ts` |

## Code and collaboration

| Feature | What it does | Server | Web | e2e |
|---|---|---|---|---|
| Code browser | Tree with the last commit per entry, highlighted files, raw and download links, history, commit diffs (unified or split), and a branch/tag picker that can create branches. | `routes/repos.ts`, `routes/branches.ts`, `git.ts` | `components/code-browser.tsx`, `components/ref-picker.tsx` | `branches.spec.ts`, `complete.spec.ts` |
| Repository home | Rendered README, languages (Linguist), recent activity, stars, environments, and a quick-setup card for empty repositories. | `routes/repos.ts`, `languages.ts` | `routes/_authed.$owner.$repo.index.tsx`, `components/activity.tsx` | `languages.spec.ts`, `activity.spec.ts` |
| Issues | Shared numbering with pull requests. Comments, open and closed state, filtering by label and assignee, and up to 10 assignees. | `routes/issues.ts`, `routes/labels.ts` | `components/conversation.tsx` | `ui.spec.ts`, `labels.spec.ts` |
| Labels | Per-repository name, colour and description. New repositories get `bug`, `enhancement`, `documentation` and `question`. | `routes/labels.ts` | `components/labels.tsx` | `labels.spec.ts` |
| Pull requests | Compare and open, review the diff, and merge on the server as a merge commit, a squash or a rebase (whichever the repository allows), with a compare-and-swap on the base branch. | `routes/issues.ts`, `git.ts` | `routes/_authed.$owner.$repo.pull.$number.tsx` | `ui.spec.ts` |
| Reviews | Comment, Approve or Request changes, with inline comments on lines of the new side. Writers can request reviewers. The repository can require an approving review before merging. | `routes/reviews.ts` | `components/reviews.tsx` | `reviews.spec.ts` |
| Draft pull requests | Can't be merged until marked ready. Turning a draft back is possible while it's open, `?draft=` filters the list, and CI sees `ready_for_review` and `github.event.pull_request.draft`. | `routes/issues.ts`, `ci-triggers.ts` | `routes/_authed.$owner.$repo.pull.$number.tsx`, `routes/_authed.$owner.$repo.pulls.new.tsx` | `drafts.spec.ts` |
| Stacked pull requests | Pull requests into another pull request's branch. The sidebar shows the stack, **Change base** retargets one, and merging with **Delete … after merging** moves the ones above down. | `routes/issues.ts`, `git.ts` | `routes/_authed.$owner.$repo.pull.$number.tsx` | `stacked.spec.ts` |
| Code owners | `CODEOWNERS` in `.ether/`, `.github/`, the root or `docs/` requests reviews from owners. **Require review from code owners** gates merging, and the file view shows a file's owners. | `codeowners.ts`, `owners.ts`, `routes/reviews.ts` | `components/reviews.tsx`, `components/code-browser.tsx` | `codeowners.spec.ts` |
| Notifications | A bell with the unread count, and an inbox of mentions, comments, reviews, review requests, assignments and failed runs. There is one entry per thread. | `notify.ts`, `routes/notifications.ts` | `routes/_authed.notifications.tsx`, `routes/_authed.tsx` | `notifications.spec.ts` |
| Releases | Created from a tag, which is made from a branch if it doesn't exist yet. Markdown notes, pre-release flag, a source archive, and uploaded assets up to 500 MB each. | `routes/releases.ts`, `upload.ts` | `components/releases.tsx` | `releases.spec.ts` |
| Wiki | A separate `<repo>.wiki.git` repository, edited in the browser or with git. Per-page history and `[[Page]]` links. | `routes/wiki.ts` | `components/wiki.tsx` | `wiki.spec.ts` |
| Stars | Star a repository you can read. Stars show on profiles and the dashboard. | `routes/repos.ts` | | `stars.spec.ts` |
| Dashboard and feed | Activity from repositories you can read, plus "your work": assigned issues, your open pull requests, review requests and starred repositories. | `routes/dashboard.ts`, `events.ts` | `components/feed.tsx`, `routes/_authed.index.tsx` | `feed.spec.ts` |
| Jump box | Search repositories you can read, or type `#123` to open an issue or pull request. | `routes/repos.ts` | `components/jump.tsx` | `complete.spec.ts` |
| Markdown | GFM rendered with `marked` and sanitised with DOMPurify. | | `components/content.tsx` | `ui.spec.ts` |

## CI and deployments

| Feature | What it does | Code | e2e |
|---|---|---|---|
| Workflows | `.ether/workflows/*.yml`: triggers, `needs` graph, matrix, `if:`, and `${{ }}` expressions. | `ci-workflow.ts`, `ci-triggers.ts`, `ci-graph.ts`, `src/runner/expr.ts` | `workflows.spec.ts`, `job-graph.spec.ts` |
| Scheduling and queue | Job queue, `ETHER_CI_JOBS` limit, cancel and re-run. | `ci.ts`, `routes/ci.ts` | `ci.spec.ts` |
| Cron | `schedule:` triggers in UTC, at most once every 5 minutes. | `cron.ts` | `schedule.spec.ts` |
| Isolation | A container per job (Docker or Podman), or host mode chosen by an admin. | `ci-container.ts` | `ci-isolation.spec.ts` |
| Secrets | Encrypted repository and environment secrets, masked in logs. | `ci-secrets.ts`, `secret-box.ts`, `log-mask.ts` | `ci-isolation.spec.ts` |
| Pull request checks | The newest run per workflow shows as a check, and **Require passing checks** blocks merges until they pass. | `ci.ts`, `routes/issues.ts` | `ci.spec.ts` |
| Environments and deployments | Allowed branches, required reviewers, wait timer, secrets and runner labels per environment. | `deploy.ts`, `deploy-rules.ts`, `routes/deployments.ts` | `deployments.spec.ts` |
| External runners | The `ether-runner` binary, server-wide or scoped to a repository or organization, with labels and `runs-on`. | `src/runner/`, `routes/runners.ts` | `runners.spec.ts` |

## Tools

| Tool | What it does | Code | e2e |
|---|---|---|---|
| Admin CLI | `bun run ether create-admin`, `reset-password`, `invite`, `backup` and `restore`. | `src/server/cli.ts` | `backup.spec.ts` |
| `ether` client | A Rust client for auth, repositories, issues, pull requests (drafts, reviews, reviewers, checks, diffs, stacks, merge methods), shell completions and raw API calls. | `cli/src/` | `cli.spec.ts` |
| `ether-runner` | CI runner for other machines (`bun run build:runner`). | `src/runner/main.ts` | `runners.spec.ts` |
| Tailscale deploy | Windows scripts that start Ether at logon and run `tailscale serve`. | `scripts/deploy.ps1`, `scripts/start.ps1` | |
| Review bot | AI bug and security review, `/fix`, and the merge gate for this repository's pull requests. | `.github/review/`, `.github/workflows/` | unit tests in `.github/review/` |

## Not supported

There is no repository rename, transfer or archive. There are no milestones, blame, automatic `#123` or `@mention` links in Markdown (mentions do notify), comment editing, or token scopes. Workflows can't use `uses:` actions, `services:`, `container:`, job-level `timeout-minutes` or `working-directory`.
