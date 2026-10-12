//! Proxy model + parsing.
//!
//! Accepted formats:
//!   {host}:{port}:{username}:{password}
//!   {host}:{port}@{username}:{password}
//!   {scheme}://{username}:{password}@{host}:{port}
//!   {host}:{port}      (scheme defaults to http)

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proxy {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub raw: String,
}

const SUPPORTED: &[&str] = &["http", "https", "socks4", "socks4a", "socks5", "socks5h"];

impl Proxy {
    /// Parse a single proxy line. Returns `None` if unparseable.
    pub fn parse(line: &str) -> Option<Proxy> {
        let raw = line.trim();
        if raw.is_empty() {
            return None;
        }

        // scheme://user:pass@host:port   or   scheme://host:port
        if let Some((scheme, rest)) = raw.split_once("://") {
            let scheme = normalize_scheme(scheme);
            if let Some((auth, hostport)) = rest.rsplit_once('@') {
                let (user, pass) = auth.split_once(':')?;
                let (host, port) = parse_host_port(hostport)?;
                return Some(Proxy::build(scheme, host, port, Some(user), Some(pass), raw));
            }
            let (host, port) = parse_host_port(rest)?;
            return Some(Proxy::build(scheme, host, port, None, None, raw));
        }

        // host:port@user:pass
        if let Some((hostport, auth)) = raw.split_once('@') {
            let (host, port) = parse_host_port(hostport)?;
            let (user, pass) = auth.split_once(':')?;
            return Some(Proxy::build("http".into(), host, port, Some(user), Some(pass), raw));
        }

        // host:port:user:pass  or  host:port
        let parts: Vec<&str> = raw.splitn(4, ':').collect();
        match parts.as_slice() {
            [host, port, user, pass] => {
                let port: u16 = port.parse().ok()?;
                Some(Proxy::build("http".into(), host.to_string(), port, Some(user), Some(pass), raw))
            }
            [host, port] => {
                let port: u16 = port.parse().ok()?;
                Some(Proxy::build("http".into(), host.to_string(), port, None, None, raw))
            }
            _ => None,
        }
    }

    fn build(
        scheme: String,
        host: String,
        port: u16,
        user: Option<&str>,
        pass: Option<&str>,
        raw: &str,
    ) -> Proxy {
        Proxy {
            scheme,
            host,
            port,
            username: user.map(|s| s.to_string()),
            password: pass.map(|s| s.to_string()),
            raw: raw.to_string(),
        }
    }
}

fn normalize_scheme(s: &str) -> String {
    let s = s.to_lowercase();
    if SUPPORTED.contains(&s.as_str()) {
        s
    } else {
        "http".to_string()
    }
}

fn parse_host_port(s: &str) -> Option<(String, u16)> {
    let (host, port) = s.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}
