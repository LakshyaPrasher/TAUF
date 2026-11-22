use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct ExtractedProfileData {
    pub title: Option<String>,
    pub description: Option<String>,
    pub emails: Vec<String>,
    pub cross_handles: Vec<(String, String)>, // (platform, handle)
    pub same_as_urls: Vec<String>,
    pub orgs: Vec<String>,
}

/// Native Rust direct HTML & structured-metadata extractor (sovereign `socid-extractor` equivalent).
/// Fetches a confirmed profile HTML page directly from the laptop and extracts OpenGraph, JSON-LD
/// `sameAs`/`worksFor`, `rel="me"` indie-web links, embedded emails, and cross-platform handles.
pub async fn extract_profile_html(client: &Client, url: &str) -> Option<ExtractedProfileData> {
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(9))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let body = resp.text().await.ok()?;
    let slice: String = body.chars().take(250_000).collect();

    Some(parse_profile_html(&slice))
}

pub fn parse_profile_html(html: &str) -> ExtractedProfileData {
    let mut out = ExtractedProfileData::default();
    let mut seen_emails = HashSet::new();
    let mut seen_urls = HashSet::new();
    let mut seen_handles = HashSet::new();
    let mut seen_orgs = HashSet::new();

    // 1. <title> or og:title
    if let Ok(re) =
        Regex::new(r#"(?is)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']"#)
    {
        if let Some(m) = re.captures(html).and_then(|c| c.get(1)) {
            out.title = Some(m.as_str().trim().to_string());
        }
    }
    if out.title.is_none() {
        if let Ok(re) = Regex::new(r"(?is)<title[^>]*>([^<]{1,200})</title>") {
            if let Some(m) = re.captures(html).and_then(|c| c.get(1)) {
                out.title = Some(m.as_str().trim().to_string());
            }
        }
    }

    // 2. og:description or meta description
    if let Ok(re) = Regex::new(
        r#"(?is)<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([^"']{4,400})["']"#,
    ) {
        if let Some(m) = re.captures(html).and_then(|c| c.get(1)) {
            out.description = Some(m.as_str().trim().to_string());
        }
    }

    // 3. JSON-LD <script type="application/ld+json">
    if let Ok(ld_re) =
        Regex::new(r#"(?is)<script[^>]+type=["']application/ld\+json["'][^>]*>(.*?)</script>"#)
    {
        for cap in ld_re.captures_iter(html) {
            if let Some(raw_json) = cap.get(1) {
                if let Ok(val) = serde_json::from_str::<Value>(raw_json.as_str().trim()) {
                    walk_json_ld(
                        &val,
                        &mut seen_urls,
                        &mut seen_orgs,
                        &mut seen_emails,
                        &mut out,
                    );
                }
            }
        }
    }

    // Strip boilerplate layout regions (footer, nav, aside, non-JSON-LD script, style)
    // BEFORE scanning for emails or social links so platform footers never pollute anchors.
    let mut cleaned_html = html.to_string();
    for tag in ["footer", "nav", "aside", "style", "noscript"] {
        let pat = format!(r"(?is)<{0}\b[^>]*>.*?</{0}>", tag);
        if let Ok(re) = Regex::new(&pat) {
            cleaned_html = re.replace_all(&cleaned_html, " ").into_owned();
        }
    }
    if let Ok(re) = Regex::new(r#"(?is)<script(?![^>]+application/ld\+json)[^>]*>.*?</script>"#) {
        cleaned_html = re.replace_all(&cleaned_html, " ").into_owned();
    }

    // 4. rel="me" links (Mastodon, IndieWeb, personal sites, GitHub)
    if let Ok(rel_re) = Regex::new(
        r#"(?i)<a[^>]+rel=["'][^"']*\bme\b[^"']*["'][^>]+href=["'](https?://[^"']+)["']"#,
    ) {
        for cap in rel_re.captures_iter(&cleaned_html) {
            if let Some(m) = cap.get(1) {
                let u = m.as_str().to_string();
                if seen_urls.insert(u.clone()) {
                    out.same_as_urls.push(u);
                }
            }
        }
    }

    // 5. Embedded emails (mailto: and visible text — filter out obvious asset/platform/boilerplate addresses)
    if let Ok(em_re) =
        Regex::new(r"(?i)\b([A-Za-z0-9._%+\-]{2,64}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,12})\b")
    {
        for cap in em_re.captures_iter(&cleaned_html) {
            if let Some(m) = cap.get(1) {
                let em = m.as_str().to_lowercase();
                if !is_noise_email(&em) && seen_emails.insert(em.clone()) {
                    out.emails.push(em);
                    if out.emails.len() >= 8 {
                        break;
                    }
                }
            }
        }
    }

    // 6. Cross-platform social URLs in cleaned HTML & sameAs
    let social_patterns = [
        (
            "GitHub",
            r"(?i)https?://(?:www\.)?github\.com/([A-Za-z0-9][A-Za-z0-9\-]{1,38})(?:[/?#\x22'\s<]|$)",
        ),
        (
            "GitLab",
            r"(?i)https?://(?:www\.)?gitlab\.com/([A-Za-z0-9_.\-]{2,40})(?:[/?#\x22'\s<]|$)",
        ),
        (
            "X/Twitter",
            r"(?i)https?://(?:www\.)?(?:twitter|x)\.com/([A-Za-z0-9_]{2,20})(?:[/?#\x22'\s<]|$)",
        ),
        (
            "Keybase",
            r"(?i)https?://(?:www\.)?keybase\.io/([A-Za-z0-9_]{2,24})(?:[/?#\x22'\s<]|$)",
        ),
        (
            "Telegram",
            r"(?i)https?://t\.me/([A-Za-z0-9_]{4,32})(?:[/?#\x22'\s<]|$)",
        ),
        (
            "LinkedIn",
            r"(?i)https?://(?:www\.)?linkedin\.com/in/([A-Za-z0-9\-]{3,60})(?:[/?#\x22'\s<]|$)",
        ),
    ];

    for (platform, pat) in social_patterns {
        if let Ok(re) = Regex::new(pat) {
            for cap in re.captures_iter(&cleaned_html) {
                if let Some(m) = cap.get(1) {
                    let h = m.as_str().to_lowercase();
                    if !is_reserved_path(&h)
                        && seen_handles.insert((platform.to_string(), h.clone()))
                    {
                        out.cross_handles.push((platform.to_string(), h));
                        if out.cross_handles.len() >= 12 {
                            break;
                        }
                    }
                }
            }
        }
    }

    out
}

fn walk_json_ld(
    val: &Value,
    seen_urls: &mut HashSet<String>,
    seen_orgs: &mut HashSet<String>,
    seen_emails: &mut HashSet<String>,
    out: &mut ExtractedProfileData,
) {
    match val {
        Value::Object(map) => {
            if let Some(same_as) = map.get("sameAs") {
                match same_as {
                    Value::String(s) if s.starts_with("http") => {
                        if seen_urls.insert(s.clone()) {
                            out.same_as_urls.push(s.clone());
                        }
                    }
                    Value::Array(arr) => {
                        for item in arr {
                            if let Some(s) = item.as_str() {
                                if s.starts_with("http") && seen_urls.insert(s.to_string()) {
                                    out.same_as_urls.push(s.to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Some(works_for) = map.get("worksFor") {
                let org_name = match works_for {
                    Value::String(s) => Some(s.trim().to_string()),
                    Value::Object(o) => o
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string()),
                    _ => None,
                };
                if let Some(org) = org_name {
                    if !org.is_empty() && seen_orgs.insert(org.to_lowercase()) {
                        out.orgs.push(org);
                    }
                }
            }
            if let Some(email) = map.get("email").and_then(|v| v.as_str()) {
                let clean = email.trim_start_matches("mailto:").trim().to_lowercase();
                if clean.contains('@')
                    && !is_noise_email(&clean)
                    && seen_emails.insert(clean.clone())
                {
                    out.emails.push(clean);
                }
            }
            for v in map.values() {
                walk_json_ld(v, seen_urls, seen_orgs, seen_emails, out);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                walk_json_ld(item, seen_urls, seen_orgs, seen_emails, out);
            }
        }
        _ => {}
    }
}

fn is_noise_email(email: &str) -> bool {
    let blocked_domains = [
        "example.com",
        "example.org",
        "users.noreply.github.com",
        "sentry.io",
        "w3.org",
        "schema.org",
        "gravatar.com",
        "automattic.com",
        "wordpress.com",
        "wordpress.org",
        "github.com",
        "gitlab.com",
        "kaggle.com",
        "medium.com",
        "substack.com",
        "reddit.com",
        "patreon.com",
        "cloudflare.com",
        "google.com",
        "youtube.com",
        "vimeo.com",
        "dribbble.com",
        "behance.net",
        "adobe.com",
        "purl.org",
    ];
    let blocked_exts = [
        ".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".css", ".js",
    ];
    if blocked_exts.iter().any(|ext| email.ends_with(ext)) {
        return true;
    }
    if let Some((local, dom)) = email.split_once('@') {
        if blocked_domains
            .iter()
            .any(|b| dom == *b || dom.ends_with(&format!(".{}", b)))
        {
            return true;
        }
        let blocked_prefixes = [
            "privacy",
            "legal",
            "dmca",
            "abuse",
            "copyright",
            "security",
            "press",
            "support",
            "noreply",
            "no-reply",
            "webmaster",
            "hostmaster",
            "postmaster",
            "admin",
            "billing",
            "sales",
            "marketing",
            "compliance",
            "dpo",
            "gdpr",
        ];
        if blocked_prefixes
            .iter()
            .any(|p| local == *p || local.starts_with(p))
        {
            return true;
        }
    }
    false
}

fn is_reserved_path(handle: &str) -> bool {
    matches!(
        handle,
        "home"
            | "login"
            | "signup"
            | "join"
            | "about"
            | "features"
            | "pricing"
            | "enterprise"
            | "explore"
            | "topics"
            | "settings"
            | "security"
            | "privacy"
            | "terms"
            | "share"
            | "intent"
            | "search"
            | "i"
            | "s"
            | "org"
            | "orgs"
            | "users"
            | "apps"
            | "marketplace"
            | "sponsors"
            | "solutions"
            | "company"
            | "contact"
            | "help"
            | "docs"
            | "status"
            | "blog"
    )
}
