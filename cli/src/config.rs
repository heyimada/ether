use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct Host {
    pub user: String,
    pub token: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Config {
    pub default: Option<String>,
    #[serde(default)]
    pub hosts: BTreeMap<String, Host>,
}

// ETHER_CONFIG_DIR overrides the platform config directory (used by tests and CI).
fn dir() -> Result<PathBuf> {
    if let Ok(d) = std::env::var("ETHER_CONFIG_DIR") {
        return Ok(PathBuf::from(d));
    }
    Ok(dirs::config_dir().context("no config directory on this system")?.join("ether"))
}

fn path() -> Result<PathBuf> {
    Ok(dir()?.join("hosts.json"))
}

pub fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('/').to_string()
}

impl Config {
    pub fn load() -> Result<Config> {
        let p = path()?;
        if !p.exists() {
            return Ok(Config::default());
        }
        let text = fs::read_to_string(&p).with_context(|| format!("reading {}", p.display()))?;
        Ok(serde_json::from_str(&text).with_context(|| format!("{} is not valid", p.display()))?)
    }

    pub fn save(&self) -> Result<()> {
        let p = path()?;
        fs::create_dir_all(p.parent().unwrap())?;
        fs::write(&p, serde_json::to_string_pretty(self)?)?;
        // The file holds tokens: keep it private to the user.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    // The host to talk to: ETHER_HOST, else the default from `ether auth login`.
    pub fn current(&self) -> Result<(String, Host)> {
        let host = std::env::var("ETHER_HOST")
            .ok()
            .map(|h| normalize_host(&h))
            .or_else(|| self.default.clone())
            .context("not logged in; run `ether auth login --host <url>`")?;
        let entry = self
            .hosts
            .get(&host)
            .cloned()
            .with_context(|| format!("not logged in to {host}; run `ether auth login --host {host}`"))?;
        Ok((host, entry))
    }
}
