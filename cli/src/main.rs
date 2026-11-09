mod client;
mod config;

use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use client::{repo_api, seg, Client};
use config::{normalize_host, Config, Host};
use reqwest::Method;
use serde_json::{json, Value};
use std::io::{BufRead, Read};
use std::process::Command;

/// Work with Ether repositories, issues and pull requests from the terminal.
#[derive(Parser)]
#[command(name = "ether", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Log in, log out and show who you are
    #[command(subcommand)]
    Auth(AuthCmd),
    /// Create, list, view and clone repositories
    #[command(subcommand)]
    Repo(RepoCmd),
    /// Work with issues
    #[command(subcommand)]
    Issue(IssueCmd),
    /// Work with pull requests
    #[command(subcommand)]
    Pr(PrCmd),
    /// Print a shell completion script, e.g. `ether completion zsh > ~/.zfunc/_ether`
    Completion {
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
    /// Call any API endpoint and print the JSON response
    Api {
        /// Path such as /api/me
        path: String,
        /// HTTP method
        #[arg(short = 'X', long, default_value = "GET")]
        method: String,
        /// JSON request body
        #[arg(long)]
        input: Option<String>,
    },
}

#[derive(Subcommand)]
enum AuthCmd {
    /// Save a personal access token for a server (create one in Settings)
    Login {
        /// Server URL, e.g. https://ether.example.com
        #[arg(long)]
        host: String,
        /// Read the token from standard input
        #[arg(long)]
        with_token: bool,
        /// The token itself (prefer --with-token so it stays out of shell history)
        #[arg(long)]
        token: Option<String>,
    },
    /// Show which account you're using
    Status,
    /// Forget the saved token for the current server
    Logout,
    /// Git credential helper protocol (configured by `ether repo clone`)
    #[command(hide = true)]
    GitCredential { operation: String },
}

#[derive(Args)]
struct RepoArg {
    /// OWNER/REPO; defaults to the repository of the current directory
    #[arg(short = 'R', long = "repo")]
    repo: Option<String>,
}

#[derive(Subcommand)]
enum RepoCmd {
    /// Create a repository
    Create {
        name: String,
        #[arg(long, default_value = "")]
        description: String,
        /// Readable by every account on the server
        #[arg(long)]
        public: bool,
        /// Create it in an organization you own
        #[arg(long)]
        org: Option<String>,
    },
    /// List repositories you can see
    List,
    /// Show a repository
    View {
        /// OWNER/REPO; defaults to the current directory's repository
        repo: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Clone a repository and set up git to authenticate with your token
    Clone { repo: String, dir: Option<String> },
}

#[derive(Subcommand)]
enum IssueCmd {
    /// List issues
    List {
        #[command(flatten)]
        r: RepoArg,
        #[arg(long, default_value = "open")]
        state: String,
        #[arg(long)]
        json: bool,
    },
    /// Open an issue
    Create {
        #[command(flatten)]
        r: RepoArg,
        #[arg(long)]
        title: String,
        #[arg(long, default_value = "")]
        body: String,
    },
    /// Show an issue and its comments
    View {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        #[arg(long)]
        json: bool,
    },
    /// Add a comment
    Comment {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        #[arg(long)]
        body: String,
    },
    /// Close an issue
    Close {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
    },
    /// Reopen an issue
    Reopen {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
    },
}

#[derive(Subcommand)]
enum PrCmd {
    /// List pull requests
    List {
        #[command(flatten)]
        r: RepoArg,
        #[arg(long, default_value = "open")]
        state: String,
        #[arg(long)]
        json: bool,
    },
    /// Open a pull request (head defaults to the current branch)
    Create {
        #[command(flatten)]
        r: RepoArg,
        #[arg(long)]
        title: String,
        #[arg(long, default_value = "")]
        body: String,
        /// Branch to merge into; defaults to the repository's default branch
        #[arg(long)]
        base: Option<String>,
        #[arg(long)]
        head: Option<String>,
        /// Open it as a draft, which can't be merged until it's marked ready
        #[arg(long)]
        draft: bool,
    },
    /// Show a pull request
    View {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        #[arg(long)]
        json: bool,
    },
    /// Merge a pull request; without a method flag, the repository's preferred way
    Merge {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        /// Merge with a merge commit
        #[arg(long, group = "method")]
        merge: bool,
        /// Squash all commits into one
        #[arg(long, group = "method")]
        squash: bool,
        /// Make each commit again on top of the base
        #[arg(long, group = "method")]
        rebase: bool,
        /// Delete the head branch afterwards; pull requests stacked on it move to its base
        #[arg(short = 'd', long)]
        delete_branch: bool,
        /// Title of the merge or squash commit
        #[arg(long)]
        subject: Option<String>,
        /// Message of the merge or squash commit
        #[arg(short = 'b', long)]
        body: Option<String>,
    },
    /// Mark a draft ready for review, or turn it back into a draft with --undo
    Ready {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        #[arg(long)]
        undo: bool,
    },
    /// Change a pull request's title, body, base branch or reviewers
    Edit {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        body: Option<String>,
        /// Point it at another branch, e.g. once the one it was stacked on is merged
        #[arg(long)]
        base: Option<String>,
        /// Ask users or ORG/TEAM for a review (comma-separated or repeated)
        #[arg(long, value_delimiter = ',')]
        add_reviewer: Vec<String>,
        /// Take back review requests (comma-separated or repeated)
        #[arg(long, value_delimiter = ',')]
        remove_reviewer: Vec<String>,
    },
    /// Approve, request changes or comment on a pull request
    Review {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        #[arg(short = 'a', long, group = "verdict")]
        approve: bool,
        #[arg(short = 'r', long, group = "verdict")]
        request_changes: bool,
        #[arg(short = 'c', long, group = "verdict")]
        comment: bool,
        #[arg(short = 'b', long, default_value = "")]
        body: String,
    },
    /// Show a pull request's checks; exits 1 if any failed and 8 while some still run
    Checks {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
    },
    /// Show what a pull request changes
    Diff {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
        /// Only the names of the changed files
        #[arg(long)]
        name_only: bool,
    },
    /// Check out a pull request's branch locally
    Checkout {
        number: u64,
        #[command(flatten)]
        r: RepoArg,
    },
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

fn client() -> Result<Client> {
    let (host, entry) = Config::load()?.current()?;
    Client::new(&host, &entry.token)
}

fn print_json(v: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn git(args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .output()
        .context("running git")?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// OWNER/REPO from -R, else from the `origin` remote of the current directory when it points
// at the server we're logged in to.
fn resolve_repo(explicit: &Option<String>, host: &str) -> Result<(String, String)> {
    let full = match explicit {
        Some(r) => r.clone(),
        None => {
            let url = git(&["remote", "get-url", "origin"])
                .context("not in a clone of an Ether repository; pass -R OWNER/REPO")?;
            let rest = url
                .strip_prefix(host)
                .with_context(|| format!("origin ({url}) is not on {host}; pass -R OWNER/REPO"))?;
            rest.trim_start_matches('/')
                .trim_end_matches('/')
                .trim_end_matches(".git")
                .to_string()
        }
    };
    match full.split_once('/') {
        Some((o, r)) if !o.is_empty() && !r.is_empty() && !r.contains('/') => {
            Ok((o.to_string(), r.to_string()))
        }
        _ => bail!("expected OWNER/REPO, got {full}"),
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Cmd::Auth(cmd) => auth(cmd),
        Cmd::Repo(cmd) => repo(cmd),
        Cmd::Issue(cmd) => issue(cmd),
        Cmd::Pr(cmd) => pr(cmd),
        Cmd::Completion { shell } => {
            use clap::CommandFactory;
            clap_complete::generate(shell, &mut Cli::command(), "ether", &mut std::io::stdout());
            Ok(())
        }
        Cmd::Api {
            path,
            method,
            input,
        } => {
            let c = client()?;
            let body = input
                .map(|s| serde_json::from_str::<Value>(&s))
                .transpose()
                .context("--input must be JSON")?;
            let method = Method::from_bytes(method.to_uppercase().as_bytes())?;
            print_json(&c.request(method, &path, body.as_ref())?)
        }
    }
}

fn auth(cmd: AuthCmd) -> Result<()> {
    match cmd {
        AuthCmd::Login {
            host,
            with_token,
            token,
        } => {
            let host = normalize_host(&host);
            let token = match (with_token, token) {
                (true, _) => {
                    let mut s = String::new();
                    std::io::stdin().read_to_string(&mut s)?;
                    s.trim().to_string()
                }
                (false, Some(t)) => t,
                (false, None) => bail!("pass --with-token (and pipe the token in) or --token"),
            };
            if token.is_empty() {
                bail!("no token given");
            }
            let me = Client::new(&host, &token)?
                .get("/api/me")
                .context("that token was not accepted")?;
            let user = me["user"]["username"]
                .as_str()
                .context("unexpected response from /api/me")?
                .to_string();
            let mut cfg = Config::load()?;
            cfg.hosts.insert(
                host.clone(),
                Host {
                    user: user.clone(),
                    token,
                },
            );
            cfg.default = Some(host.clone());
            cfg.save()?;
            println!("Logged in to {host} as {user}");
            Ok(())
        }
        AuthCmd::Status => {
            let (host, entry) = Config::load()?.current()?;
            let me = Client::new(&host, &entry.token)?
                .get("/api/me")
                .context("the saved token no longer works; log in again")?;
            println!(
                "{host}: logged in as {}",
                me["user"]["username"].as_str().unwrap_or(&entry.user)
            );
            Ok(())
        }
        AuthCmd::Logout => {
            let mut cfg = Config::load()?;
            let (host, _) = cfg.current()?;
            cfg.hosts.remove(&host);
            if cfg.default.as_deref() == Some(host.as_str()) {
                cfg.default = cfg.hosts.keys().next().cloned();
            }
            cfg.save()?;
            println!("Logged out of {host}");
            Ok(())
        }
        AuthCmd::GitCredential { operation } => {
            // Only `get` answers; `store` and `erase` are no-ops because the token lives here.
            let mut fields = std::collections::HashMap::new();
            for line in std::io::stdin().lock().lines() {
                let line = line?;
                if line.is_empty() {
                    break;
                }
                if let Some((k, v)) = line.split_once('=') {
                    fields.insert(k.to_string(), v.to_string());
                }
            }
            if operation != "get" {
                return Ok(());
            }
            let wanted = format!(
                "{}://{}",
                fields
                    .get("protocol")
                    .map(String::as_str)
                    .unwrap_or("https"),
                fields.get("host").map(String::as_str).unwrap_or("")
            );
            let cfg = Config::load()?;
            if let Some(entry) = cfg.hosts.get(&normalize_host(&wanted)) {
                println!("username={}\npassword={}", entry.user, entry.token);
            }
            Ok(())
        }
    }
}

fn repo(cmd: RepoCmd) -> Result<()> {
    let c = client()?;
    match cmd {
        RepoCmd::Create {
            name,
            description,
            public,
            org,
        } => {
            let mut body = json!({ "name": name, "description": description, "visibility": if public { "public" } else { "private" } });
            if let Some(o) = org {
                body["owner"] = json!(o);
            }
            let res = c.post("/api/repos", body)?;
            let (owner, name) = (
                res["repo"]["owner"].as_str().unwrap_or(""),
                res["repo"]["name"].as_str().unwrap_or(""),
            );
            println!("Created {owner}/{name}\n{}/{owner}/{name}", c.host);
            Ok(())
        }
        RepoCmd::List => {
            for r in c.get("/api/repos")?["repos"]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                println!(
                    "{}/{}\t{}\t{}",
                    r["owner"].as_str().unwrap_or(""),
                    r["name"].as_str().unwrap_or(""),
                    r["visibility"].as_str().unwrap_or(""),
                    r["description"].as_str().unwrap_or("")
                );
            }
            Ok(())
        }
        RepoCmd::View { repo, json } => {
            let (o, r) = resolve_repo(&repo, &c.host)?;
            let v = c.get(&repo_api(&o, &r))?;
            if json {
                return print_json(&v);
            }
            let info = &v["repo"];
            println!("{o}/{r}  ({})", info["visibility"].as_str().unwrap_or(""));
            if let Some(d) = info["description"].as_str().filter(|d| !d.is_empty()) {
                println!("{d}");
            }
            println!(
                "Default branch: {}",
                info["defaultBranch"].as_str().unwrap_or("")
            );
            println!("Stars: {}", v["stars"]);
            println!("Clone: {}/{o}/{r}.git", c.host);
            Ok(())
        }
        RepoCmd::Clone { repo, dir } => {
            let (o, r) = resolve_repo(&Some(repo), &c.host)?;
            let url = format!("{}/{}/{}.git", c.host, o, r);
            let exe = std::env::current_exe()?
                .to_string_lossy()
                .replace('\\', "/");
            let helper = format!("!'{exe}' auth git-credential");
            let target = dir.unwrap_or_else(|| r.clone());
            // An empty helper first resets any global helpers so they don't prompt.
            let status = Command::new("git")
                .args([
                    "-c",
                    "credential.helper=",
                    "-c",
                    &format!("credential.helper={helper}"),
                    "clone",
                    &url,
                    &target,
                ])
                .status()?;
            if !status.success() {
                bail!("git clone failed");
            }
            git(&["-C", &target, "config", "--add", "credential.helper", ""])?;
            git(&[
                "-C",
                &target,
                "config",
                "--add",
                "credential.helper",
                &helper,
            ])?;
            println!("Cloned {o}/{r} into {target}; git push and pull use your ether login.");
            Ok(())
        }
    }
}

fn list_items(v: &Value) -> Vec<Value> {
    v["items"].as_array().cloned().unwrap_or_default()
}

fn print_item_line(i: &Value) {
    println!(
        "#{}\t{}\t{}\t{}",
        i["number"],
        i["title"].as_str().unwrap_or(""),
        i["state"].as_str().unwrap_or(""),
        i["author"].as_str().unwrap_or("")
    );
}

fn print_conversation(v: &Value, key: &str) {
    let i = &v[key];
    println!(
        "{} #{}  [{}]",
        i["title"].as_str().unwrap_or(""),
        i["number"],
        i["state"].as_str().unwrap_or("")
    );
    if key == "pull" {
        println!(
            "{} wants to merge {} into {}",
            i["author"].as_str().unwrap_or(""),
            i["head"].as_str().unwrap_or(""),
            i["base"].as_str().unwrap_or("")
        );
    } else {
        println!("opened by {}", i["author"].as_str().unwrap_or(""));
    }
    if let Some(b) = i["body"].as_str().filter(|b| !b.is_empty()) {
        println!("\n{b}");
    }
    for c in v["comments"].as_array().cloned().unwrap_or_default() {
        println!(
            "\n— {}:\n{}",
            c["author"].as_str().unwrap_or(""),
            c["body"].as_str().unwrap_or("")
        );
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

// What decides whether a pull request can be merged: draft, reviews, checks, code owners and its stack.
fn print_pull_status(v: &Value) {
    let p = &v["pull"];
    if p["state"] != "open" {
        if p["state"] == "merged" {
            println!(
                "\n{} by {}",
                match p["mergeMethod"].as_str() {
                    Some("squash") => "Squashed and merged",
                    Some("rebase") => "Rebased and merged",
                    _ => "Merged",
                },
                p["mergedBy"].as_str().unwrap_or("")
            );
        }
        return;
    }
    println!();
    if p["draft"] == true {
        println!("Draft: mark it ready with `ether pr ready {}`", p["number"]);
    }
    let stack: Vec<Value> = v["stack"].as_array().cloned().unwrap_or_default();
    if !stack.is_empty() {
        let line: Vec<String> = stack
            .iter()
            .map(|s| {
                if s["number"] == p["number"] {
                    format!("[#{}]", s["number"])
                } else {
                    format!("#{}", s["number"])
                }
            })
            .collect();
        println!("Stack: {}", line.join(" → "));
    }
    let mut reviewers: Vec<String> = Vec::new();
    if let Some(map) = v["reviewers"].as_object() {
        for (who, verdict) in map {
            reviewers.push(format!(
                "{who} ({})",
                if verdict == "approved" {
                    "approved"
                } else {
                    "changes requested"
                }
            ));
        }
    }
    for who in strings(&v["reviewRequests"])
        .into_iter()
        .chain(strings(&v["teamRequests"]))
    {
        reviewers.push(format!("{who} (pending)"));
    }
    if !reviewers.is_empty() {
        println!("Reviewers: {}", reviewers.join(", "));
    }
    if let Some(status) = v["checks"]["status"].as_str() {
        println!("Checks: {status}");
    }
    if let Some(groups) = v["codeOwners"]["groups"].as_array() {
        let waiting: Vec<String> = groups
            .iter()
            .filter(|g| g["approvedBy"].is_null())
            .map(|g| g["pattern"].as_str().unwrap_or("").to_string())
            .collect();
        if !waiting.is_empty() {
            println!("Waiting on code owners of: {}", waiting.join(", "));
        }
    }
    println!(
        "{}",
        if v["missing"] == true {
            "A branch of this pull request no longer exists."
        } else if v["mergeable"] == true {
            "No conflicts with the base branch."
        } else {
            "Has conflicts; can't be merged yet."
        }
    );
}

fn issue(cmd: IssueCmd) -> Result<()> {
    let c = client()?;
    match cmd {
        IssueCmd::List { r, state, json } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.get(&format!(
                "{}/issues?state={}",
                repo_api(&o, &n),
                seg(&state)
            ))?;
            if json {
                return print_json(&v);
            }
            for i in list_items(&v) {
                print_item_line(&i);
            }
            Ok(())
        }
        IssueCmd::Create { r, title, body } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.post(
                &format!("{}/issues", repo_api(&o, &n)),
                json!({ "title": title, "body": body }),
            )?;
            let num = &v["issue"]["number"];
            println!("Created issue #{num}\n{}/{o}/{n}/issues/{num}", c.host);
            Ok(())
        }
        IssueCmd::View { number, r, json } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.get(&format!("{}/issues/{number}", repo_api(&o, &n)))?;
            if json {
                return print_json(&v);
            }
            print_conversation(&v, "issue");
            Ok(())
        }
        IssueCmd::Comment { number, r, body } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            c.post(
                &format!("{}/issues/{number}/comments", repo_api(&o, &n)),
                json!({ "body": body }),
            )?;
            println!("Commented on #{number}");
            Ok(())
        }
        IssueCmd::Close { number, r } => set_state(&c, &r, number, "closed"),
        IssueCmd::Reopen { number, r } => set_state(&c, &r, number, "open"),
    }
}

fn set_state(c: &Client, r: &RepoArg, number: u64, state: &str) -> Result<()> {
    let (o, n) = resolve_repo(&r.repo, &c.host)?;
    c.patch(
        &format!("{}/issues/{number}", repo_api(&o, &n)),
        json!({ "state": state }),
    )?;
    println!(
        "{} #{number}",
        if state == "closed" {
            "Closed"
        } else {
            "Reopened"
        }
    );
    Ok(())
}

fn pr(cmd: PrCmd) -> Result<()> {
    let c = client()?;
    match cmd {
        PrCmd::List { r, state, json } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.get(&format!("{}/pulls?state={}", repo_api(&o, &n), seg(&state)))?;
            if json {
                return print_json(&v);
            }
            for i in list_items(&v) {
                print_item_line(&i);
            }
            Ok(())
        }
        PrCmd::Create {
            r,
            title,
            body,
            base,
            head,
            draft,
        } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let head = match head {
                Some(h) => h,
                None => {
                    git(&["rev-parse", "--abbrev-ref", "HEAD"]).context("pass --head BRANCH")?
                }
            };
            let base = match base {
                Some(b) => b,
                None => c.get(&repo_api(&o, &n))?["repo"]["defaultBranch"]
                    .as_str()
                    .unwrap_or("main")
                    .to_string(),
            };
            let v = c.post(
                &format!("{}/pulls", repo_api(&o, &n)),
                json!({ "title": title, "body": body, "base": base, "head": head, "draft": draft }),
            )?;
            let num = &v["pull"]["number"];
            println!(
                "Created {}pull request #{num} ({head} into {base})\n{}/{o}/{n}/pull/{num}",
                if draft { "draft " } else { "" },
                c.host
            );
            Ok(())
        }
        PrCmd::View { number, r, json } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.get(&format!("{}/pulls/{number}", repo_api(&o, &n)))?;
            if json {
                return print_json(&v);
            }
            print_conversation(&v, "pull");
            print_pull_status(&v);
            Ok(())
        }
        PrCmd::Merge {
            number,
            r,
            merge,
            squash,
            rebase,
            delete_branch,
            subject,
            body,
        } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let mut req = json!({ "deleteBranch": delete_branch });
            if let Some(m) = [(merge, "merge"), (squash, "squash"), (rebase, "rebase")]
                .iter()
                .find(|(on, _)| *on)
            {
                req["method"] = json!(m.1);
            }
            if let Some(t) = subject {
                req["title"] = json!(t);
            }
            if let Some(b) = body {
                req["message"] = json!(b);
            }
            let res = c.post(&format!("{}/pulls/{number}/merge", repo_api(&o, &n)), req)?;
            let verb = match res["method"].as_str() {
                Some("squash") => "Squashed and merged",
                Some("rebase") => "Rebased and merged",
                _ => "Merged",
            };
            println!("{verb} #{number}");
            if res["deletedBranch"] == true {
                println!("Deleted its branch");
            }
            for (key, what) in [
                ("retargeted", "Moved onto its base"),
                ("restacked", "Rebuilt on the new commits"),
            ] {
                let nums: Vec<String> = res[key]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|v| format!("#{v}"))
                    .collect();
                if !nums.is_empty() {
                    println!("{what}: {}", nums.join(", "));
                }
            }
            Ok(())
        }
        PrCmd::Ready { number, r, undo } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            c.patch(
                &format!("{}/issues/{number}", repo_api(&o, &n)),
                json!({ "draft": undo }),
            )?;
            println!(
                "{} #{number}",
                if undo {
                    "Turned into a draft:"
                } else {
                    "Ready for review:"
                }
            );
            Ok(())
        }
        PrCmd::Edit {
            number,
            r,
            title,
            body,
            base,
            add_reviewer,
            remove_reviewer,
        } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let api = repo_api(&o, &n);
            let mut fields = json!({});
            if let Some(t) = title {
                fields["title"] = json!(t);
            }
            if let Some(b) = body {
                fields["body"] = json!(b);
            }
            if let Some(b) = base {
                fields["base"] = json!(b);
            }
            let touched_fields = fields.as_object().is_some_and(|f| !f.is_empty());
            if touched_fields {
                c.patch(&format!("{api}/issues/{number}"), fields)?;
            }
            if !add_reviewer.is_empty() || !remove_reviewer.is_empty() {
                let v = c.get(&format!("{api}/pulls/{number}"))?;
                let names = |key: &str| -> Vec<String> {
                    v[key]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|x| x.as_str().map(str::to_lowercase))
                        .collect()
                };
                let clean = |s: &String| s.trim().trim_start_matches('@').to_lowercase();
                let removed: Vec<String> = remove_reviewer.iter().map(clean).collect();
                let mut users = names("reviewRequests");
                let mut teams = names("teamRequests");
                for a in add_reviewer.iter().map(clean).filter(|a| !a.is_empty()) {
                    let list = if a.contains('/') {
                        &mut teams
                    } else {
                        &mut users
                    };
                    if !list.contains(&a) {
                        list.push(a);
                    }
                }
                users.retain(|u| !removed.contains(u));
                teams.retain(|t| !removed.contains(t));
                c.put(
                    &format!("{api}/pulls/{number}/reviewers"),
                    json!({ "reviewers": users, "teams": teams }),
                )?;
            } else if !touched_fields {
                bail!("nothing to change; pass --title, --body, --base, --add-reviewer or --remove-reviewer");
            }
            println!("Updated #{number}");
            Ok(())
        }
        PrCmd::Review {
            number,
            r,
            approve,
            request_changes,
            comment: _,
            body,
        } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let state = if approve {
                "approved"
            } else if request_changes {
                "changes_requested"
            } else {
                "commented"
            };
            c.post(
                &format!("{}/pulls/{number}/reviews", repo_api(&o, &n)),
                json!({ "state": state, "body": body }),
            )?;
            println!(
                "{} #{number}",
                match state {
                    "approved" => "Approved",
                    "changes_requested" => "Requested changes on",
                    _ => "Reviewed",
                }
            );
            Ok(())
        }
        PrCmd::Checks { number, r } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.get(&format!("{}/pulls/{number}", repo_api(&o, &n)))?;
            let checks = &v["checks"];
            if checks.is_null() {
                println!("No checks ran for the head commit.");
                return Ok(());
            }
            for run in checks["runs"].as_array().cloned().unwrap_or_default() {
                println!(
                    "{}\t{}\t{}/{o}/{n}/ci/{}",
                    run["status"].as_str().unwrap_or(""),
                    run["workflow"].as_str().unwrap_or(""),
                    c.host,
                    run["id"]
                );
            }
            match checks["status"].as_str() {
                Some("success") => Ok(()),
                Some("queued" | "running" | "waiting") => std::process::exit(8),
                _ => std::process::exit(1),
            }
        }
        PrCmd::Diff {
            number,
            r,
            name_only,
        } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.get(&format!("{}/pulls/{number}", repo_api(&o, &n)))?;
            let diff = v["diff"].as_str().unwrap_or("");
            if name_only {
                for line in diff.lines().filter_map(|l| l.strip_prefix("+++ b/")) {
                    println!("{line}");
                }
            } else {
                print!("{diff}");
            }
            if v["truncated"] == true {
                eprintln!("(the diff was cut short; see it in the browser)");
            }
            Ok(())
        }
        PrCmd::Checkout { number, r } => {
            let (o, n) = resolve_repo(&r.repo, &c.host)?;
            let v = c.get(&format!("{}/pulls/{number}", repo_api(&o, &n)))?;
            let head = v["pull"]["head"]
                .as_str()
                .context("pull request has no head branch")?;
            git(&["fetch", "origin", &format!("{head}:{head}")])?;
            git(&["checkout", head])?;
            println!("Switched to {head}");
            Ok(())
        }
    }
}
