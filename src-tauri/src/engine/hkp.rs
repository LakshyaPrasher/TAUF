use regex::Regex;
use reqwest::Client;
use std::collections::HashSet;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct HkpKeyRecord {
    pub key_id: String,
    pub algo: String,
    pub key_len: String,
    pub created_epoch: String,
    pub flags: String,
    pub uids: Vec<HkpUid>,
}

#[derive(Debug, Clone)]
pub struct HkpUid {
    pub raw_uid: String,
    pub display_name: String,
    pub email: Option<String>,
}

/// Direct federated OpenPGP HKP protocol lookup (RFC / Hockeypuck machine-readable index).
/// Zero third-party OSINT APIs — speaks standard HKP directly from the laptop.
pub async fn lookup_hkp(client: &Client, query: &str) -> Result<Vec<HkpKeyRecord>, String> {
    let encoded = urlencoding::encode(query.trim());
    let url = format!(
        "https://keyserver.ubuntu.com/pks/lookup?op=index&options=mr&search={}",
        encoded
    );

    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("HKP request failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read HKP body: {}", e))?;

    Ok(parse_hkp_mr(&body))
}

/// Parse standard HKP machine-readable response (`pub:` and `uid:` lines).
pub fn parse_hkp_mr(body: &str) -> Vec<HkpKeyRecord> {
    let email_re = Regex::new(r"<([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})>").unwrap();
    let mut records = Vec::new();
    let mut current: Option<HkpKeyRecord> = None;
    let mut seen_keys = HashSet::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("pub:") {
            if let Some(rec) = current.take() {
                if !rec.uids.is_empty() {
                    records.push(rec);
                }
            }
            let parts: Vec<&str> = trimmed.split(':').collect();
            if parts.len() >= 2 {
                let key_id = parts[1].to_string();
                if !key_id.is_empty() && seen_keys.insert(key_id.clone()) {
                    current = Some(HkpKeyRecord {
                        key_id,
                        algo: parts.get(2).copied().unwrap_or("").to_string(),
                        key_len: parts.get(3).copied().unwrap_or("").to_string(),
                        created_epoch: parts.get(4).copied().unwrap_or("").to_string(),
                        flags: parts.get(6).copied().unwrap_or("").to_string(),
                        uids: Vec::new(),
                    });
                }
            }
        } else if trimmed.starts_with("uid:") {
            if let Some(ref mut rec) = current {
                let parts: Vec<&str> = trimmed.split(':').collect();
                if let Some(encoded_uid) = parts.get(1) {
                    let decoded = urlencoding::decode(encoded_uid)
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| (*encoded_uid).to_string());
                    let email = email_re
                        .captures(&decoded)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str().to_lowercase());
                    let display_name = email_re.replace(&decoded, "").trim().to_string();
                    rec.uids.push(HkpUid {
                        raw_uid: decoded,
                        display_name,
                        email,
                    });
                }
            }
        }
    }

    if let Some(rec) = current {
        if !rec.uids.is_empty() {
            records.push(rec);
        }
    }

    records.truncate(12);
    records
}
