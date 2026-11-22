use futures::stream::{self, StreamExt};
use regex::Regex;
use reqwest::header::RANGE;
use reqwest::Client;
use std::collections::HashSet;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct PdfMetadata {
    pub url: String,
    pub file_name: String,
    pub author: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub title: Option<String>,
    pub creation_date: Option<String>,
    pub internal_usernames: Vec<String>,
    pub emails: Vec<String>,
}

/// Discover public PDF URLs directly from a target domain's standard public pages
/// (homepage, about, press, investors, team, leadership, sitemap) with zero external APIs.
pub async fn discover_domain_pdfs(client: &Client, domain: &str) -> Vec<String> {
    let clean_dom = domain
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if clean_dom.is_empty() {
        return Vec::new();
    }

    let probe_paths = [
        "",
        "/about",
        "/press",
        "/newsroom",
        "/investors",
        "/leadership",
        "/team",
        "/security",
        "/sitemap.xml",
    ];

    let pages: Vec<(String, String)> = stream::iter(probe_paths.into_iter())
        .map(|path| {
            let client = client.clone();
            let base = format!("https://{}", clean_dom);
            let url = format!("{}{}", base, path);
            async move {
                let resp = client
                    .get(&url)
                    .timeout(Duration::from_secs(6))
                    .send()
                    .await
                    .ok()?;
                if !resp.status().is_success() {
                    return None;
                }
                let text = resp.text().await.ok()?;
                let capped: String = text.chars().take(250_000).collect();
                Some((base, capped))
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect();

    let mut seen = HashSet::new();
    let mut pdf_urls = Vec::new();

    for (base, html) in pages {
        for link in extract_pdf_links(&base, &html) {
            if seen.insert(link.clone()) {
                pdf_urls.push(link);
                if pdf_urls.len() >= 6 {
                    return pdf_urls;
                }
            }
        }
    }

    pdf_urls
}

/// Discover public `.pdf` resume/CV/paper/deck links directly from discovered personal sites,
/// portfolios, blogs, or GitHub repository pages (works even when only a Full Name is supplied).
pub async fn discover_page_pdfs(client: &Client, page_urls: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut pdf_urls = Vec::new();
    for raw_url in page_urls.iter().take(6) {
        let trimmed = raw_url.trim();
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            continue;
        }
        if trimmed.to_lowercase().contains(".pdf") {
            if seen.insert(trimmed.to_string()) {
                pdf_urls.push(trimmed.to_string());
            }
            continue;
        }
        let Ok(resp) = client
            .get(trimmed)
            .timeout(Duration::from_secs(6))
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(text) = resp.text().await else {
            continue;
        };
        let capped: String = text.chars().take(200_000).collect();
        let origin = trimmed.split('/').take(3).collect::<Vec<_>>().join("/");
        for link in extract_pdf_links(&origin, &capped) {
            if seen.insert(link.clone()) {
                pdf_urls.push(link);
                if pdf_urls.len() >= 6 {
                    return pdf_urls;
                }
            }
        }
    }
    pdf_urls
}

/// Extract `.pdf` links (absolute or root-relative) from raw HTML or XML text.
pub fn extract_pdf_links(base_url: &str, text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let base = base_url.trim_end_matches('/');

    if let Ok(re) = Regex::new(
        r#"(?i)(?:href|src|loc)\s*[=>]\s*["']?((?:https?://[^\s"'<>]+|/[^\s"'<>]+)\.pdf(?:\?[^\s"'<>]*)?)["'<]?"#,
    ) {
        for cap in re.captures_iter(text) {
            if let Some(m) = cap.get(1) {
                let raw = m.as_str().trim();
                let resolved = if raw.starts_with("http://") || raw.starts_with("https://") {
                    raw.to_string()
                } else if raw.starts_with('/') {
                    format!("{}{}", base, raw)
                } else {
                    continue;
                };
                if seen.insert(resolved.clone()) {
                    out.push(resolved);
                    if out.len() >= 10 {
                        break;
                    }
                }
            }
        }
    }

    out
}

/// Fetch up to 2 MB of a public PDF directly via HTTP and extract metadata in pure Rust.
pub async fn fetch_and_parse_pdf(client: &Client, url: &str) -> Option<PdfMetadata> {
    let resp = client
        .get(url)
        .header(RANGE, "bytes=0-2097151")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    // Guard against huge responses if the origin ignored the Range header
    if let Some(len) = resp.content_length() {
        if len > 4_194_304 {
            return None;
        }
    }

    let bytes = resp.bytes().await.ok()?;
    let slice = &bytes[..bytes.len().min(2_097_152)];
    let header_window = &slice[..slice.len().min(1024)];
    if !header_window.windows(4).any(|w| w == b"%PDF") {
        return None;
    }

    Some(parse_pdf_metadata(url, slice))
}

/// Pure-Rust PDF Info Dictionary + XMP metadata parser.
/// Handles literal `(...)` strings, UTF-16BE/LE hex `<FEFF...>` strings, XMP XML tags,
/// internal OS paths (`C:\Users\...`, `/Users/...`, `/home/...`), and embedded emails.
pub fn parse_pdf_metadata(url: &str, bytes: &[u8]) -> PdfMetadata {
    let file_name = url
        .split('?')
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("document.pdf")
        .to_string();

    let mut meta = PdfMetadata {
        url: url.to_string(),
        file_name,
        author: extract_pdf_dict_string(bytes, b"/Author"),
        creator: extract_pdf_dict_string(bytes, b"/Creator"),
        producer: extract_pdf_dict_string(bytes, b"/Producer"),
        title: extract_pdf_dict_string(bytes, b"/Title"),
        creation_date: extract_pdf_dict_string(bytes, b"/CreationDate"),
        ..Default::default()
    };

    // Also inspect uncompressed XMP metadata streams (commonly present even in compressed PDFs)
    let lossy = String::from_utf8_lossy(bytes);
    if meta.author.is_none() {
        meta.author = extract_xmp_dc_tag(&lossy, "dc:creator");
    }
    if meta.creator.is_none() {
        meta.creator = extract_xmp_simple_tag(&lossy, "xmp:CreatorTool")
            .or_else(|| extract_xmp_simple_tag(&lossy, "xap:CreatorTool"));
    }
    if meta.producer.is_none() {
        meta.producer = extract_xmp_simple_tag(&lossy, "pdf:Producer");
    }
    if meta.title.is_none() {
        meta.title = extract_xmp_dc_tag(&lossy, "dc:title");
    }

    // Collect candidate text blobs to scan for OS usernames and emails
    let mut text_blobs: Vec<String> = Vec::new();
    for field in [&meta.author, &meta.creator, &meta.producer, &meta.title]
        .into_iter()
        .flatten()
    {
        text_blobs.push(field.clone());
    }
    if let Some(xmp_start) = lossy.find("<x:xmpmeta") {
        let xmp_chunk = if let Some(rel_end) = lossy[xmp_start..].find("</x:xmpmeta>") {
            lossy[xmp_start..xmp_start + rel_end + 12].to_string()
        } else {
            lossy[xmp_start..].chars().take(16_384).collect()
        };
        text_blobs.push(xmp_chunk);
    }

    let combined = text_blobs.join("\n");
    let mut seen_users = HashSet::new();
    let mut seen_emails = HashSet::new();

    // Scan internal local file paths for leaked OS usernames
    if let Ok(path_re) = Regex::new(
        r"(?i)(?:[A-Za-z]:[\\/]Users[\\/]|/Users/|/home/)([A-Za-z0-9._\-]{2,40})(?:[\\/]|$)",
    ) {
        for cap in path_re.captures_iter(&combined) {
            if let Some(m) = cap.get(1) {
                let user = m.as_str().trim().to_string();
                let low = user.to_lowercase();
                if !matches!(
                    low.as_str(),
                    "public" | "default" | "administrator" | "admin" | "root" | "runner" | "shared"
                ) && seen_users.insert(low)
                {
                    meta.internal_usernames.push(user);
                }
            }
        }
    }

    // Scan metadata text for embedded email addresses
    if let Ok(em_re) =
        Regex::new(r"(?i)\b([A-Za-z0-9._%+\-]{2,64}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,12})\b")
    {
        for cap in em_re.captures_iter(&combined) {
            if let Some(m) = cap.get(1) {
                let em = m.as_str().to_lowercase();
                if !is_metadata_noise_email(&em) && seen_emails.insert(em.clone()) {
                    meta.emails.push(em);
                }
            }
        }
    }

    meta
}

fn extract_pdf_dict_string(bytes: &[u8], key: &[u8]) -> Option<String> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let pos = bytes[offset..]
            .windows(key.len())
            .position(|w| w == key)
            .map(|p| offset + p)?;
        let after = pos + key.len();
        if after >= bytes.len() {
            return None;
        }
        // Ensure key isn't just a prefix of a longer PDF name (like /AuthorName)
        let next_b = bytes[after];
        if next_b.is_ascii_alphanumeric() || next_b == b'_' {
            offset = after;
            continue;
        }

        let mut i = after;
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n') {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }

        if bytes[i] == b'(' {
            if let Some(decoded) = parse_pdf_literal_string(&bytes[i + 1..]) {
                let clean = sanitize_meta_value(&decoded);
                if !clean.is_empty() {
                    return Some(clean);
                }
            }
        } else if bytes[i] == b'<' && bytes.get(i + 1) != Some(&b'<') {
            if let Some(decoded) = parse_pdf_hex_string(&bytes[i + 1..]) {
                let clean = sanitize_meta_value(&decoded);
                if !clean.is_empty() {
                    return Some(clean);
                }
            }
        }

        offset = after;
    }
    None
}

fn parse_pdf_literal_string(bytes: &[u8]) -> Option<String> {
    let mut out: Vec<u8> = Vec::new();
    let mut depth = 1usize;
    let mut i = 0usize;
    let limit = bytes.len().min(1024);

    while i < limit {
        let b = bytes[i];
        if b == b'\\' {
            i += 1;
            if i >= limit {
                break;
            }
            match bytes[i] {
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'b' => out.push(0x08),
                b'f' => out.push(0x0C),
                b'(' | b')' | b'\\' => out.push(bytes[i]),
                b'\r' => {
                    if bytes.get(i + 1) == Some(&b'\n') {
                        i += 1;
                    }
                }
                b'\n' => {}
                c if (b'0'..=b'7').contains(&c) => {
                    let mut oct = (c - b'0') as u16;
                    for _ in 0..2 {
                        if let Some(&next) = bytes.get(i + 1) {
                            if (b'0'..=b'7').contains(&next) {
                                oct = oct * 8 + (next - b'0') as u16;
                                i += 1;
                            } else {
                                break;
                            }
                        }
                    }
                    out.push((oct & 0xFF) as u8);
                }
                other => out.push(other),
            }
            i += 1;
            continue;
        }

        if b == b'(' {
            depth += 1;
            out.push(b);
        } else if b == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(decode_pdf_bytes(&out));
            }
            out.push(b);
        } else {
            out.push(b);
        }
        i += 1;
    }

    None
}

fn parse_pdf_hex_string(bytes: &[u8]) -> Option<String> {
    let mut hex_chars: Vec<u8> = Vec::new();
    for &b in bytes.iter().take(2048) {
        if b == b'>' {
            break;
        }
        if b.is_ascii_hexdigit() {
            hex_chars.push(b);
        } else if !b.is_ascii_whitespace() {
            return None;
        }
    }
    if hex_chars.is_empty() {
        return None;
    }
    if hex_chars.len() % 2 == 1 {
        hex_chars.push(b'0');
    }
    let hex_str = std::str::from_utf8(&hex_chars).ok()?;
    let decoded = hex::decode(hex_str).ok()?;
    Some(decode_pdf_bytes(&decoded))
}

fn decode_pdf_bytes(raw: &[u8]) -> String {
    if raw.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if raw.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|&b| b as char).collect(),
    }
}

fn sanitize_meta_value(raw: &str) -> String {
    raw.trim()
        .replace('\0', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_xmp_dc_tag(xml: &str, tag: &str) -> Option<String> {
    let pat = format!(
        r"(?is)<{}[^>]*>.*?<rdf:li[^>]*>([^<]{{1,200}})</rdf:li>.*?</{}>",
        regex::escape(tag),
        regex::escape(tag)
    );
    if let Ok(re) = Regex::new(&pat) {
        if let Some(m) = re.captures(xml).and_then(|c| c.get(1)) {
            let clean = sanitize_meta_value(m.as_str());
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    extract_xmp_simple_tag(xml, tag)
}

fn extract_xmp_simple_tag(xml: &str, tag: &str) -> Option<String> {
    let pat = format!(
        r"(?is)<{}[^>]*>([^<]{{1,200}})</{}>",
        regex::escape(tag),
        regex::escape(tag)
    );
    if let Ok(re) = Regex::new(&pat) {
        if let Some(m) = re.captures(xml).and_then(|c| c.get(1)) {
            let clean = sanitize_meta_value(m.as_str());
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    None
}

fn is_metadata_noise_email(email: &str) -> bool {
    let blocked_domains = [
        "adobe.com",
        "w3.org",
        "purl.org",
        "schema.org",
        "example.com",
        "example.org",
        "creativecommons.org",
    ];
    if let Some(dom) = email.split('@').nth(1) {
        if blocked_domains
            .iter()
            .any(|b| dom == *b || dom.ends_with(&format!(".{}", b)))
        {
            return true;
        }
    }
    email.starts_with("noreply@") || email.starts_with("no-reply@")
}
