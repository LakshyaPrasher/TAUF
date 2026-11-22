use futures::stream::{self, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Deserialize)]
pub struct WmnCatalog {
    pub sites: Vec<WmnSite>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WmnSite {
    pub name: String,
    pub category: String,
    pub uri_check: String,
    pub uri_pretty: String,
    pub e_code: u16,
    pub e_string: String,
    pub m_string: String,
    pub m_code: u16,
}

#[derive(Debug, Clone)]
pub struct WmnHit {
    pub site_name: String,
    pub category: String,
    pub handle: String,
    pub url: String,
    pub confidence: f32,
}

const WMN_CURATED_JSON: &str = include_str!("../../resources/wmn_curated.json");

pub fn load_curated_sites() -> Vec<WmnSite> {
    serde_json::from_str::<WmnCatalog>(WMN_CURATED_JSON)
        .map(|c| c.sites)
        .unwrap_or_default()
}

/// Execute curated direct-HTML WhatsMyName checks concurrently in native Rust.
pub async fn run_wmn_for_handle(
    client: &Client,
    handle: &str,
    max_concurrency: usize,
) -> Vec<WmnHit> {
    let sites = load_curated_sites();
    let sem = Arc::new(Semaphore::new(max_concurrency.max(4)));
    let handle_owned = handle.trim().trim_start_matches('@').to_string();

    if handle_owned.len() < 2 {
        return Vec::new();
    }

    let results: Vec<Option<WmnHit>> = stream::iter(sites.into_iter())
        .map(|site| {
            let client = client.clone();
            let sem = sem.clone();
            let h = handle_owned.clone();
            async move {
                let _permit = sem.acquire_owned().await.ok()?;
                check_single_site(&client, &site, &h).await
            }
        })
        .buffer_unordered(max_concurrency.max(4))
        .collect()
        .await;

    results.into_iter().flatten().collect()
}

async fn check_single_site(client: &Client, site: &WmnSite, handle: &str) -> Option<WmnHit> {
    let encoded = urlencoding::encode(handle);
    let check_url = site.uri_check.replace("{account}", &encoded);
    let pretty_url = site.uri_pretty.replace("{account}", &encoded);

    let resp = client
        .get(&check_url)
        .timeout(Duration::from_secs(7))
        .send()
        .await
        .ok()?;

    let status = resp.status().as_u16();
    if status == site.m_code && site.m_code != site.e_code {
        return None;
    }
    if status != site.e_code {
        return None;
    }

    let body = resp.text().await.ok()?;
    let body_lower = body.to_lowercase();

    // False-positive guard 1: explicit missing string present
    if !site.m_string.is_empty() && body_lower.contains(&site.m_string.to_lowercase()) {
        return None;
    }

    // False-positive guard 2: expected existence signature must be present
    if !site.e_string.is_empty() && !body_lower.contains(&site.e_string.to_lowercase()) {
        return None;
    }

    // False-positive guard 3: soft-404 / WAF / login wall detection
    let soft_404_markers = [
        "page not found",
        "this account doesn't exist",
        "user does not exist",
        "sorry, this page isn't available",
        "cloudflare ray id",
        "just a moment...",
    ];
    if soft_404_markers.iter().any(|m| body_lower.contains(m)) {
        return None;
    }

    // Higher confidence when the exact handle appears inside the returned profile page
    let handle_in_body = body_lower.contains(&handle.to_lowercase());
    let confidence = if handle_in_body { 0.72 } else { 0.56 };

    Some(WmnHit {
        site_name: site.name.clone(),
        category: site.category.clone(),
        handle: handle.to_string(),
        url: pretty_url,
        confidence,
    })
}
