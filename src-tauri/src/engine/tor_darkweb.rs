use regex::Regex;
use reqwest::{Client, Proxy};
use std::collections::HashSet;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct TorProbeStatus {
    pub available: bool,
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OnionCrawlHit {
    pub onion_url: String,
    pub matched_term: String,
    pub title: String,
    pub snippet: String,
    pub discovered_onions: Vec<String>,
}

/// Probe local Tor daemon (9050), Tor Browser (9150), or user-configured SOCKS5h endpoint.
pub fn detect_local_tor(custom_url: Option<&str>) -> TorProbeStatus {
    let mut candidates: Vec<(String, String)> = Vec::new();

    if let Some(u) = custom_url {
        let trimmed = u.trim();
        if !trimmed.is_empty() {
            let normalized = ensure_socks5h(trimmed);
            if let Some(addr) = extract_host_port(&normalized) {
                candidates.push((normalized, addr));
            }
        }
    }

    candidates.push((
        "socks5h://127.0.0.1:9050".to_string(),
        "127.0.0.1:9050".to_string(),
    ));
    candidates.push((
        "socks5h://127.0.0.1:9150".to_string(),
        "127.0.0.1:9150".to_string(),
    ));

    for (socks_url, addr_str) in candidates {
        if let Ok(addr) = addr_str.parse::<SocketAddr>() {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(450)).is_ok() {
                return TorProbeStatus {
                    available: true,
                    endpoint: Some(socks_url),
                };
            }
        }
    }

    TorProbeStatus {
        available: false,
        endpoint: None,
    }
}

/// Guarantee `socks5h://` so DNS resolution happens remotely inside Tor (preventing local Windows DNS leaks).
pub fn ensure_socks5h(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("socks5h://") {
        trimmed.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("socks5://") {
        format!("socks5h://{}", rest)
    } else if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("socks5h://{}", trimmed)
    }
}

fn extract_host_port(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    let host_port = after_scheme.split('/').next()?;
    let without_auth = host_port.rsplit('@').next()?;
    Some(without_auth.to_string())
}

/// Build a dedicated reqwest Client strictly routed through local Tor SOCKS5h proxy.
pub fn build_tor_client(socks5h_url: &str) -> Result<Client, String> {
    let safe_url = ensure_socks5h(socks5h_url);
    let proxy = Proxy::all(&safe_url)
        .map_err(|e| format!("Invalid Tor SOCKS5h proxy '{}': {}", safe_url, e))?;

    Client::builder()
        .proxy(proxy)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0")
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to construct Tor HTTP client: {}", e))
}

/// Directly crawl user-configured `.onion` search/directory seed URLs over local Tor SOCKS5h.
/// Supports `{query}` placeholder substitution (e.g. `http://...onion/search/?q={query}`) OR direct page crawl.
/// Zero third-party clearnet dark-web APIs!
pub async fn crawl_onion_seeds_over_tor(
    socks5h_url: &str,
    seeds: &[String],
    terms: &[String],
) -> Result<Vec<OnionCrawlHit>, String> {
    let client = build_tor_client(socks5h_url)?;
    let onion_re = Regex::new(r"https?://[a-z2-7]{16,56}\.onion(?:/[^\s\x22'<>]*)?").unwrap();
    let title_re = Regex::new(r"(?is)<title[^>]*>([^<]{1,180})</title>").unwrap();
    let tag_re = Regex::new(r"(?is)<[^>]+>").unwrap();

    let mut hits = Vec::new();
    let mut visited = HashSet::new();

    for raw_seed in seeds {
        let seed = raw_seed.trim();
        if seed.is_empty() {
            continue;
        }
        // Only allow .onion URLs over the Tor engine
        if !seed.to_lowercase().contains(".onion") {
            continue;
        }

        let target_urls: Vec<(String, Option<String>)> = if seed.contains("{query}") {
            terms
                .iter()
                .take(4)
                .map(|t| {
                    let encoded = urlencoding::encode(t);
                    (seed.replace("{query}", &encoded), Some(t.clone()))
                })
                .collect()
        } else {
            vec![(seed.to_string(), None)]
        };

        for (url, forced_term) in target_urls {
            if !visited.insert(url.clone()) {
                continue;
            }
            let Ok(resp) = client.get(&url).send().await else {
                continue;
            };
            if !resp.status().is_success() {
                continue;
            }
            let Ok(body) = resp.text().await else {
                continue;
            };

            let title = title_re
                .captures(&body)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_else(|| "Tor Hidden Service Page".to_string());

            let plain = tag_re.replace_all(&body, " ");
            let plain_lower = plain.to_lowercase();

            let mut discovered_onions = Vec::new();
            let mut seen_o = HashSet::new();
            for m in onion_re.find_iter(&body) {
                let u = m.as_str().to_string();
                if seen_o.insert(u.clone()) {
                    discovered_onions.push(u);
                    if discovered_onions.len() >= 10 {
                        break;
                    }
                }
            }

            let check_terms: Vec<String> = match forced_term {
                Some(t) => vec![t],
                None => terms.to_vec(),
            };

            for term in check_terms {
                let needle = term.trim().to_lowercase();
                if needle.len() < 3 {
                    continue;
                }
                if let Some(idx) = plain_lower.find(&needle) {
                    let mut start = idx.saturating_sub(90);
                    while start > 0 && !plain.is_char_boundary(start) {
                        start -= 1;
                    }
                    let mut end = (idx + needle.len() + 110).min(plain.len());
                    while end < plain.len() && !plain.is_char_boundary(end) {
                        end += 1;
                    }
                    let snippet = plain
                        .get(start..end)
                        .unwrap_or("")
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");

                    hits.push(OnionCrawlHit {
                        onion_url: url.clone(),
                        matched_term: term.clone(),
                        title: title.clone(),
                        snippet,
                        discovered_onions: discovered_onions.clone(),
                    });
                }
            }
        }
    }

    Ok(hits)
}
