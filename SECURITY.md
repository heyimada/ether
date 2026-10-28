# Security policy

Ether hosts other people's source code and credentials, so we treat security reports as the highest priority.

## Supported versions

Ether has no versioned releases yet. Only the latest commit on the default branch gets security fixes. Run that commit and keep it up to date.

## Reporting a vulnerability

**Don't open a public issue, discussion or pull request for a vulnerability.**

Report it privately through [GitHub's private vulnerability reporting](https://github.com/heyimada/ether/security/advisories/new) (the repository's **Security** tab, then **Report a vulnerability**). Include:

- what an attacker can do, and what access they need first (no account, an invited account, write access to a repository, an admin)
- steps to reproduce, ideally against a fresh `bun run ether create-admin` setup
- the commit you tested
- any fix you suggest

You can expect a first response within a week. Once the issue is confirmed, we agree with you on a fix and a disclosure date, and we credit you in the advisory unless you prefer not to be named.

## Scope

These are in scope:

- reading or writing repositories, issues, pull requests, wikis, releases, profiles or activity that your role doesn't allow, over the web UI, the API, git over HTTPS or git over SSH
- authentication and session problems: invite links, personal access tokens, SSH keys, password reset
- cross-site scripting through Markdown, file previews, avatars or profile fields
- path traversal or command injection through repository, branch, tag or file names
- the `ether` command-line client leaking its token

These are known and documented, so they don't count as vulnerabilities:

- **CI runs jobs as the operating system user that runs Ether.** As the [README](README.md#ci) states, turning on CI for a repository gives everyone with write access to it full control of the server. A report that a CI job can read Ether's data folder isn't new. A report that someone *without* write access can get a job to run is.
- Ether is meant to listen on loopback behind a private network such as a Tailscale tailnet. Problems that only exist because the server is exposed directly to the internet are lower priority, but still welcome.
- Denial of service by an account the admin invited.
