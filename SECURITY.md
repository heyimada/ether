# Security policy

Ether hosts other people's source code and credentials, so we treat security reports as the highest priority.

## Supported versions

Ether itself has no versioned releases yet. Only the latest commit on the default branch gets security fixes. Run that commit and keep it up to date.

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
- CI: a job escaping its container, reading another repository's code or secrets, CI or environment secrets readable through the API or UI, runner tokens and per-job tokens reaching more than they should, or a deployment running without the environment's reviewers, branches or wait timer

These are known and documented, so they don't count as vulnerabilities:

- **CI in host mode, and runners registered with `--isolation host`, run jobs as an operating system user.** As the [README](README.md#ci) states, when an admin chooses **On this machine** for CI, everyone with write access to a repository with CI gets full control of the server; the same goes for a host-mode runner's machine. A report that such a job can read Ether's data folder isn't new. A report that someone *without* write access can get a job to run is, and so is anything a job can do from its container in the default mode.
- **Anyone who can push can read the secrets their workflows use**, for example by printing them reversed. Log masking only prevents accidents.
- Ether is meant to listen on loopback behind a private network such as a Tailscale tailnet. Problems that only exist because the server is exposed directly to the internet are lower priority, but still welcome.
- Denial of service by an account the admin invited.
