use base64::Engine as _;
use regex::Regex;
use reqwest::Client;
use std::collections::HashSet;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct RawGitProfile {
    pub handle: String,
    pub profile_url: String,
    pub exists: bool,
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub org: Option<String>,
    pub location: Option<String>,
    pub external_links: Vec<String>,
    pub ssh_keys: Vec<String>,
    pub gpg_uids: Vec<String>,
    pub gpg_emails: Vec<String>,
}

/// Direct raw GitHub HTML + `.keys` + `.gpg` fetcher — ZERO GitHub REST API calls, ZERO tokens.
pub async fn probe_github_raw(client: &Client, handle: &str) -> RawGitProfile {
    let clean = handle.trim().trim_start_matches('@');
    let profile_url = format!("https://github.com/{}", clean);
    let mut profile = RawGitProfile {
        handle: clean.to_string(),
        profile_url: profile_url.clone(),
        ..Default::default()
    };

    // 1. Direct HTML profile fetch
    if let Ok(resp) = client
        .get(&profile_url)
        .timeout(Duration::from_secs(9))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(html) = resp.text().await {
                if !html.contains("Not Found") && html.contains("og:title") {
                    profile.exists = true;
                    parse_github_html(&html, &mut profile);
                }
            }
        }
    }

    if !profile.exists {
        return profile;
    }

    // 2. Direct raw SSH public keys endpoint (plain text, not an API)
    let keys_url = format!("https://github.com/{}.keys", clean);
    if let Ok(resp) = client
        .get(&keys_url)
        .timeout(Duration::from_secs(7))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(body) = resp.text().await {
                for line in body.lines() {
                    let l = line.trim();
                    if l.starts_with("ssh-") || l.starts_with("ecdsa-") || l.starts_with("sk-") {
                        let key_type = l.split_whitespace().next().unwrap_or("ssh-key");
                        let short = if l.chars().count() > 48 {
                            format!("{}…", l.chars().take(48).collect::<String>())
                        } else {
                            l.to_string()
                        };
                        profile.ssh_keys.push(format!("{} ({})", key_type, short));
                    }
                }
            }
        }
    }

    // 3. Direct raw GPG key block endpoint + pure-Rust RFC 4880 OpenPGP UID extraction!
    let gpg_url = format!("https://github.com/{}.gpg", clean);
    if let Ok(resp) = client
        .get(&gpg_url)
        .timeout(Duration::from_secs(7))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(armor) = resp.text().await {
                if armor.contains("BEGIN PGP PUBLIC KEY BLOCK") {
                    let (uids, emails) = extract_uids_from_pgp_armor(&armor);
                    profile.gpg_uids = uids;
                    profile.gpg_emails = emails;
                }
            }
        }
    }

    profile
}

fn parse_github_html(html: &str, out: &mut RawGitProfile) {
    if let Ok(re) = Regex::new(r#"(?is)<meta\s+property="og:title"\s+content="([^"]+)""#) {
        if let Some(cap) = re.captures(html).and_then(|c| c.get(1)) {
            let val = cap.as_str().trim();
            if !val.is_empty() {
                out.display_name = Some(html_unescape(val));
            }
        }
    }

    if let Ok(re) = Regex::new(r#"(?is)<meta\s+name="description"\s+content="([^"]+)""#) {
        if let Some(cap) = re.captures(html).and_then(|c| c.get(1)) {
            let val = html_unescape(cap.as_str().trim());
            if !val.is_empty() {
                out.bio = Some(val);
            }
        }
    }

    if let Ok(re) = Regex::new(r#"(?is)itemprop="worksFor"[^>]*>.*?<span[^>]*>([^<]+)</span>"#) {
        if let Some(cap) = re.captures(html).and_then(|c| c.get(1)) {
            let val = html_unescape(cap.as_str().trim());
            if !val.is_empty() {
                out.org = Some(val);
            }
        }
    }

    if let Ok(re) = Regex::new(r#"(?is)itemprop="homeLocation"[^>]*>.*?<span[^>]*>([^<]+)</span>"#)
    {
        if let Some(cap) = re.captures(html).and_then(|c| c.get(1)) {
            let val = html_unescape(cap.as_str().trim());
            if !val.is_empty() {
                out.location = Some(val);
            }
        }
    }

    // Extract rel="nofollow me" or itemprop="url" links from user profile sidebar
    let mut seen_links = HashSet::new();
    if let Ok(re) = Regex::new(r#"(?i)rel="nofollow me"[^>]*href="(https?://[^"]+)""#) {
        for cap in re.captures_iter(html) {
            if let Some(m) = cap.get(1) {
                let u = m.as_str().to_string();
                if seen_links.insert(u.clone()) {
                    out.external_links.push(u);
                }
            }
        }
    }
    if let Ok(re) = Regex::new(r#"(?i)href="(https?://[^"]+)"[^>]*rel="nofollow me""#) {
        for cap in re.captures_iter(html) {
            if let Some(m) = cap.get(1) {
                let u = m.as_str().to_string();
                if seen_links.insert(u.clone()) {
                    out.external_links.push(u);
                }
            }
        }
    }
}

/// Pure-Rust RFC 4880 ASCII-armored OpenPGP public key parser: extracts Packet Tag 13 (User ID)
/// strings and embedded email addresses directly from raw `.gpg` blocks with zero external binaries or APIs.
pub fn extract_uids_from_pgp_armor(armor: &str) -> (Vec<String>, Vec<String>) {
    let mut uids = Vec::new();
    let mut emails = Vec::new();
    let mut seen_uids = HashSet::new();
    let mut seen_emails = HashSet::new();
    let email_re = Regex::new(r"([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})").unwrap();

    for block in armor.split("-----BEGIN PGP PUBLIC KEY BLOCK-----").skip(1) {
        let Some(end_idx) = block.find("-----END PGP PUBLIC KEY BLOCK-----") else {
            continue;
        };
        let body = &block[..end_idx];

        // Skip armor headers until first blank line
        let mut b64 = String::new();
        let mut in_data = false;
        for line in body.lines() {
            let trimmed = line.trim();
            if !in_data {
                if trimmed.is_empty() {
                    in_data = true;
                }
                continue;
            }
            if trimmed.starts_with('=') {
                // CRC24 checksum line
                break;
            }
            b64.push_str(trimmed);
        }

        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&b64) else {
            continue;
        };

        // Parse OpenPGP binary packets (RFC 4880 Section 4.2)
        let mut i = 0usize;
        while i < bytes.len() {
            let header = bytes[i];
            if (header & 0x80) == 0 {
                break;
            }
            i += 1;

            let (tag, body_len) = if (header & 0x40) != 0 {
                // New packet format
                let tag = header & 0x3F;
                if i >= bytes.len() {
                    break;
                }
                let first = bytes[i] as usize;
                i += 1;
                if first < 192 {
                    (tag, first)
                } else if first < 224 {
                    if i >= bytes.len() {
                        break;
                    }
                    let second = bytes[i] as usize;
                    i += 1;
                    (tag, ((first - 192) << 8) + second + 192)
                } else if first == 255 {
                    if i + 4 > bytes.len() {
                        break;
                    }
                    let len =
                        u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]])
                            as usize;
                    i += 4;
                    (tag, len)
                } else {
                    // Partial body length — stop scanning this block safely
                    break;
                }
            } else {
                // Old packet format
                let tag = (header >> 2) & 0x0F;
                let len_type = header & 0x03;
                match len_type {
                    0 => {
                        if i >= bytes.len() {
                            break;
                        }
                        let len = bytes[i] as usize;
                        i += 1;
                        (tag, len)
                    }
                    1 => {
                        if i + 2 > bytes.len() {
                            break;
                        }
                        let len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
                        i += 2;
                        (tag, len)
                    }
                    2 => {
                        if i + 4 > bytes.len() {
                            break;
                        }
                        let len = u32::from_be_bytes([
                            bytes[i],
                            bytes[i + 1],
                            bytes[i + 2],
                            bytes[i + 3],
                        ]) as usize;
                        i += 4;
                        (tag, len)
                    }
                    _ => (tag, bytes.len().saturating_sub(i)),
                }
            };

            if i + body_len > bytes.len() {
                break;
            }
            let payload = &bytes[i..i + body_len];
            i += body_len;

            // Packet Tag 13 = User ID Packet (UTF-8 string like "Jane Doe <jane@corp.com>")
            if tag == 13 {
                if let Ok(uid_str) = std::str::from_utf8(payload) {
                    let clean_uid = uid_str.trim().to_string();
                    if !clean_uid.is_empty() && seen_uids.insert(clean_uid.clone()) {
                        for cap in email_re.captures_iter(&clean_uid) {
                            if let Some(m) = cap.get(1) {
                                let em = m.as_str().to_lowercase();
                                if !em.ends_with("users.noreply.github.com")
                                    && seen_emails.insert(em.clone())
                                {
                                    emails.push(em);
                                }
                            }
                        }
                        uids.push(clean_uid);
                    }
                }
            }
        }
    }

    (uids, emails)
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}
