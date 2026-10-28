use anyhow::{bail, Result};
use reqwest::blocking::Client as Http;
use reqwest::Method;
use serde_json::Value;

// A thin JSON client for Ether's REST API, authenticated with a personal access token.
pub struct Client {
    pub host: String,
    token: String,
    http: Http,
}

impl Client {
    pub fn new(host: &str, token: &str) -> Result<Client> {
        let http = Http::builder()
            .user_agent(concat!("ether-cli/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Client {
            host: host.to_string(),
            token: token.to_string(),
            http,
        })
    }

    pub fn request(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let url = format!("{}{}", self.host, path);
        let mut req = self.http.request(method, &url).bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send()?;
        let status = res.status();
        let text = res.text()?;
        let json: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        if !status.is_success() {
            let msg = json
                .get("error")
                .and_then(|e| e.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| status.to_string());
            bail!("{msg} (HTTP {})", status.as_u16());
        }
        Ok(json)
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        self.request(Method::GET, path, None)
    }
    pub fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.request(Method::POST, path, Some(&body))
    }
    pub fn patch(&self, path: &str, body: Value) -> Result<Value> {
        self.request(Method::PATCH, path, Some(&body))
    }
}

// Path segments are user input; keep them from changing the URL structure.
pub fn seg(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn repo_api(owner: &str, repo: &str) -> String {
    format!("/api/repos/{}/{}", seg(owner), seg(repo))
}
