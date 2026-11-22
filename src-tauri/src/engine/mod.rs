pub mod dns_gravatar;
pub mod doc_meta;
pub mod git_raw;
pub mod hkp;
pub mod html_extractor;
pub mod local_corpus;
pub mod permutator;
pub mod sidecar;
pub mod tor_darkweb;
pub mod wmn;

use crate::db::Database;
use crate::models::{
    normalize_node_id, AuthConfig, Finding, GraphEdge, GraphNode, InvestigationInput, StreamEvent,
    ToolRunStatus,
};
use chrono::Utc;
use reqwest::{Client, Proxy};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const EVENT_NAME: &str = "investigation://event";

pub fn build_http_client(auth: &AuthConfig) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5));

    if let Some(ref p) = auth.proxy_url {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let proxy = Proxy::all(trimmed)
                .map_err(|e| format!("Invalid proxy URL '{}': {}", trimmed, e))?;
            builder = builder.proxy(proxy);
        }
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

struct InvestigationContext {
    case_id: String,
    db: Arc<Database>,
    app: AppHandle,
}

impl InvestigationContext {
    fn emit_stage(&self, stage: &str, message: &str, progress: u8) {
        let _ = self.app.emit(
            EVENT_NAME,
            StreamEvent::Stage {
                case_id: self.case_id.clone(),
                stage: stage.to_string(),
                message: message.to_string(),
                progress,
                eta_seconds: None,
                elapsed_seconds: None,
            },
        );
    }

    fn emit_tool(&self, tool: &str, state: &str, hits: usize, detail: &str) {
        let status = ToolRunStatus {
            tool: tool.to_string(),
            state: state.to_string(),
            hits,
            detail: detail.to_string(),
        };
        let _ = self.db.upsert_tool_run(&self.case_id, &status);
        let _ = self.app.emit(
            EVENT_NAME,
            StreamEvent::ToolStatus {
                case_id: self.case_id.clone(),
                tool: status.tool,
                state: status.state,
                hits: status.hits,
                detail: status.detail,
            },
        );
    }

    fn add_node(&self, node: GraphNode) -> Option<GraphNode> {
        match self.db.upsert_node(&self.case_id, &node) {
            Ok(merged) => {
                let _ = self.app.emit(
                    EVENT_NAME,
                    StreamEvent::Node {
                        case_id: self.case_id.clone(),
                        node: merged.clone(),
                    },
                );
                Some(merged)
            }
            Err(_) => None,
        }
    }

    fn add_edge(&self, source: &str, target: &str, relation: &str, confidence: f32, tool: &str) {
        let edge_id = format!("{}__{}__{}", source, relation, target);
        let edge = GraphEdge {
            id: edge_id,
            source: source.to_string(),
            target: target.to_string(),
            relation: relation.to_string(),
            confidence,
            sources: vec![tool.to_string()],
        };
        if let Ok(merged) = self.db.upsert_edge(&self.case_id, &edge) {
            let _ = self.app.emit(
                EVENT_NAME,
                StreamEvent::Edge {
                    case_id: self.case_id.clone(),
                    edge: merged,
                },
            );
        }
    }

    fn add_finding(&self, finding: Finding) {
        if let Ok(merged) = self.db.upsert_finding(&self.case_id, &finding) {
            let _ = self.app.emit(
                EVENT_NAME,
                StreamEvent::Finding {
                    case_id: self.case_id.clone(),
                    finding: merged,
                },
            );
        }
    }
}

/// Full sovereign direct-from-laptop multi-stage OSINT investigation pipeline.
/// ZERO external paid or free OSINT APIs.
pub async fn run_investigation(
    app: AppHandle,
    db: Arc<Database>,
    case_id: String,
    input: InvestigationInput,
    auth: AuthConfig,
) {
    let ctx = InvestigationContext {
        case_id: case_id.clone(),
        db: db.clone(),
        app: app.clone(),
    };

    let client = match build_http_client(&auth) {
        Ok(c) => c,
        Err(e) => {
            ctx.emit_tool("http-client", "error", 0, &e);
            finish_case(&ctx);
            return;
        }
    };

    let now = Utc::now().to_rfc3339();
    let seed_id = normalize_node_id("person", &input.full_name);

    // -------------------------------------------------------------------------
    // Stage 0: Seed Registration & Smart Handle/Email Permutation
    // -------------------------------------------------------------------------
    ctx.emit_stage(
        "stage0",
        "Registering identity seed & generating handle/email permutations",
        8,
    );

    let mut seed_meta = HashMap::new();
    seed_meta.insert(
        "mode".to_string(),
        if input.passive_only {
            "passive_only"
        } else {
            "active_adjacent"
        }
        .to_string(),
    );
    if let Some(ref org) = input.org {
        if !org.trim().is_empty() {
            seed_meta.insert("organization".to_string(), org.trim().to_string());
        }
    }

    ctx.add_node(GraphNode {
        id: seed_id.clone(),
        kind: "person".to_string(),
        label: input.full_name.trim().to_string(),
        sublabel: input.org.clone().filter(|s| !s.trim().is_empty()),
        layer: "seed".to_string(),
        confidence: 1.0,
        status: "confirmed".to_string(),
        sources: vec!["seed".to_string()],
        metadata: seed_meta,
        url: None,
        depth: 0,
    });

    let mut known_emails: Vec<String> = Vec::new();
    let mut known_handles: Vec<String> = Vec::new();
    let mut known_domains: Vec<String> = Vec::new();
    let mut seen_emails = HashSet::new();
    let mut seen_handles = HashSet::new();
    let mut seen_domains = HashSet::new();

    if let Some(ref org) = input.org {
        let clean = org.trim();
        if !clean.is_empty() {
            let org_id = normalize_node_id("org", clean);
            ctx.add_node(GraphNode {
                id: org_id.clone(),
                kind: "org".to_string(),
                label: clean.to_string(),
                sublabel: Some("Provided Organization".to_string()),
                layer: "anchor".to_string(),
                confidence: 0.95,
                status: "confirmed".to_string(),
                sources: vec!["seed".to_string()],
                metadata: HashMap::new(),
                url: None,
                depth: 0,
            });
            ctx.add_edge(&seed_id, &org_id, "affiliated_with", 0.95, "seed");
        }
    }

    if let Some(ref em) = input.email {
        let clean = em.trim().to_lowercase();
        if clean.contains('@') && seen_emails.insert(clean.clone()) {
            known_emails.push(clean.clone());
            let em_id = normalize_node_id("email", &clean);
            ctx.add_node(GraphNode {
                id: em_id.clone(),
                kind: "email".to_string(),
                label: clean.clone(),
                sublabel: Some("Provided Email".to_string()),
                layer: "anchor".to_string(),
                confidence: 0.98,
                status: "confirmed".to_string(),
                sources: vec!["seed".to_string()],
                metadata: HashMap::new(),
                url: None,
                depth: 0,
            });
            ctx.add_edge(&seed_id, &em_id, "owns_email", 0.98, "seed");
            if let Some(dom) = clean.split('@').nth(1) {
                if seen_domains.insert(dom.to_string()) {
                    known_domains.push(dom.to_string());
                }
            }
        }
    }

    if let Some(ref ph) = input.phone {
        let clean = ph.trim();
        if !clean.is_empty() {
            let ph_id = normalize_node_id("phone", clean);
            ctx.add_node(GraphNode {
                id: ph_id.clone(),
                kind: "phone".to_string(),
                label: clean.to_string(),
                sublabel: Some("Provided Phone".to_string()),
                layer: "anchor".to_string(),
                confidence: 0.95,
                status: "confirmed".to_string(),
                sources: vec!["seed".to_string()],
                metadata: HashMap::new(),
                url: None,
                depth: 0,
            });
            ctx.add_edge(&seed_id, &ph_id, "owns_phone", 0.95, "seed");
        }
    }

    if let Some(dom) = permutator::normalize_domain(input.domain.as_deref(), input.org.as_deref()) {
        if seen_domains.insert(dom.clone()) {
            known_domains.push(dom.clone());
        }
        let dom_id = normalize_node_id("domain", &dom);
        ctx.add_node(GraphNode {
            id: dom_id.clone(),
            kind: "domain".to_string(),
            label: dom.clone(),
            sublabel: Some("Target Domain".to_string()),
            layer: "anchor".to_string(),
            confidence: 0.92,
            status: "confirmed".to_string(),
            sources: vec!["seed".to_string()],
            metadata: HashMap::new(),
            url: Some(format!("https://{}", dom)),
            depth: 0,
        });
        ctx.add_edge(&seed_id, &dom_id, "domain_context", 0.92, "seed");
    }

    // Generate handle permutations
    ctx.emit_tool(
        "permutator",
        "running",
        0,
        "Generating ranked handle & email patterns",
    );
    let handle_candidates = permutator::generate_handles(&input.full_name, input.handle.as_deref());
    for cand in &handle_candidates {
        if seen_handles.insert(cand.handle.clone()) {
            known_handles.push(cand.handle.clone());
        }
        if cand.pattern == "seed_handle" {
            let h_id = normalize_node_id("handle", &cand.handle);
            ctx.add_node(GraphNode {
                id: h_id.clone(),
                kind: "handle".to_string(),
                label: format!("@{}", cand.handle),
                sublabel: Some("Provided Handle".to_string()),
                layer: "anchor".to_string(),
                confidence: 0.95,
                status: "confirmed".to_string(),
                sources: vec!["seed".to_string()],
                metadata: HashMap::new(),
                url: None,
                depth: 0,
            });
            ctx.add_edge(&seed_id, &h_id, "uses_handle", 0.95, "seed");
        }
    }

    let mut permuted_emails = Vec::new();
    for dom in &known_domains {
        for ec in
            permutator::generate_corporate_emails(&input.full_name, dom, input.email.as_deref())
        {
            permuted_emails.push(ec);
        }
    }
    ctx.emit_tool(
        "permutator",
        "done",
        handle_candidates.len() + permuted_emails.len(),
        &format!(
            "{} handle patterns, {} corporate email candidates",
            handle_candidates.len(),
            permuted_emails.len()
        ),
    );

    // -------------------------------------------------------------------------
    // Stage 0B: Direct Federated OpenPGP HKP Keyserver Lookup
    // -------------------------------------------------------------------------
    ctx.emit_stage(
        "hkp",
        "Querying federated OpenPGP HKP keyserver directly",
        18,
    );
    ctx.emit_tool(
        "openpgp-hkp",
        "running",
        0,
        "Direct HKP index lookup on Ubuntu keyserver",
    );

    let mut hkp_queries = vec![input.full_name.trim().to_string()];
    for em in &known_emails {
        hkp_queries.push(em.clone());
    }

    let mut hkp_hits = 0usize;
    let mut seen_pgp_keys = HashSet::new();
    for q in hkp_queries.iter().take(3) {
        if let Ok(records) = hkp::lookup_hkp(&client, q).await {
            for rec in records {
                if !seen_pgp_keys.insert(rec.key_id.clone()) {
                    continue;
                }
                let pgp_id = normalize_node_id("pgp_key", &rec.key_id);
                let short_key = if rec.key_id.len() > 16 {
                    rec.key_id[rec.key_id.len() - 16..].to_string()
                } else {
                    rec.key_id.clone()
                };
                let mut meta = HashMap::new();
                meta.insert("fingerprint".to_string(), rec.key_id.clone());
                meta.insert("key_length".to_string(), rec.key_len.clone());
                if !rec.flags.is_empty() {
                    meta.insert("flags".to_string(), rec.flags.clone());
                }

                ctx.add_node(GraphNode {
                    id: pgp_id.clone(),
                    kind: "pgp_key".to_string(),
                    label: format!("PGP 0x{}", short_key),
                    sublabel: rec.uids.first().map(|u| u.display_name.clone()),
                    layer: "anchor".to_string(),
                    confidence: 0.84,
                    status: "unverified".to_string(),
                    sources: vec!["openpgp-hkp".to_string()],
                    metadata: meta,
                    url: Some(format!(
                        "https://keyserver.ubuntu.com/pks/lookup?search=0x{}&fingerprint=on&op=index",
                        rec.key_id
                    )),
                    depth: 1,
                });
                ctx.add_edge(&seed_id, &pgp_id, "pgp_key_match", 0.84, "openpgp-hkp");
                hkp_hits += 1;

                for uid in &rec.uids {
                    if let Some(ref em) = uid.email {
                        let em_id = normalize_node_id("email", em);
                        let mut em_meta = HashMap::new();
                        em_meta.insert("pgp_uid".to_string(), uid.raw_uid.clone());
                        ctx.add_node(GraphNode {
                            id: em_id.clone(),
                            kind: "email".to_string(),
                            label: em.clone(),
                            sublabel: Some("OpenPGP Key UID".to_string()),
                            layer: "anchor".to_string(),
                            confidence: 0.86,
                            status: "unverified".to_string(),
                            sources: vec!["openpgp-hkp".to_string()],
                            metadata: em_meta,
                            url: None,
                            depth: 1,
                        });
                        ctx.add_edge(&pgp_id, &em_id, "certifies_email", 0.88, "openpgp-hkp");

                        ctx.add_finding(Finding {
                            id: format!("finding:hkp:{}:{}", short_key, em),
                            node_id: em_id.clone(),
                            title: format!("OpenPGP Key UID exposes {}", em),
                            category: "anchor".to_string(),
                            severity: "medium".to_string(),
                            confidence: 0.86,
                            consensus_count: 1,
                            sources: vec!["openpgp-hkp".to_string()],
                            summary: format!(
                                "Federated HKP keyserver returned key 0x{} binding UID '{}'.",
                                short_key, uid.raw_uid
                            ),
                            pivot_trail: vec![
                                format!("Name: {}", input.full_name.trim()),
                                format!("OpenPGP HKP -> 0x{}", short_key),
                                format!("UID -> {}", em),
                            ],
                            url: Some(format!(
                                "https://keyserver.ubuntu.com/pks/lookup?search=0x{}&fingerprint=on&op=index",
                                rec.key_id
                            )),
                            timestamp: now.clone(),
                            sensitive_fields: vec![em.clone(), rec.key_id.clone()],
                        });

                        if seen_emails.insert(em.clone()) {
                            known_emails.push(em.clone());
                        }
                        if let Some(local_part) = em.split('@').next() {
                            if local_part.len() >= 3 && seen_handles.insert(local_part.to_string())
                            {
                                known_handles.push(local_part.to_string());
                            }
                        }
                        if let Some(dom) = em.split('@').nth(1) {
                            if !is_free_mail_provider(dom) && seen_domains.insert(dom.to_string()) {
                                known_domains.push(dom.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    ctx.emit_tool(
        "openpgp-hkp",
        "done",
        hkp_hits,
        &format!("{} PGP key record(s) resolved via direct HKP", hkp_hits),
    );

    // -------------------------------------------------------------------------
    // Stage 0C: Direct DNS (MX/SPF/DMARC) & Gravatar Raw Hash Check
    // -------------------------------------------------------------------------
    ctx.emit_stage(
        "dns_gravatar",
        "Running direct UDP DNS & Gravatar hash probes",
        30,
    );
    ctx.emit_tool(
        "dns-gravatar",
        "running",
        0,
        "Direct UDP DNS MX/SPF/DMARC & Gravatar MD5 HEAD checks",
    );
    let mut dns_grav_hits = 0usize;

    for dom in known_domains.iter().take(4) {
        let rep = dns_gravatar::inspect_domain_dns(dom).await;
        if !rep.mx_records.is_empty() || rep.spf_record.is_some() || rep.dmarc_record.is_some() {
            let dom_id = normalize_node_id("domain", dom);
            let mut meta = HashMap::new();
            if !rep.mx_records.is_empty() {
                meta.insert("mx".to_string(), rep.mx_records.join(", "));
            }
            if let Some(ref spf) = rep.spf_record {
                meta.insert("spf".to_string(), spf.clone());
            }
            if let Some(ref dmarc) = rep.dmarc_record {
                meta.insert("dmarc".to_string(), dmarc.clone());
            }
            if let Some(ref prov) = rep.mail_provider_hint {
                meta.insert("mail_provider".to_string(), prov.clone());
            }

            ctx.add_node(GraphNode {
                id: dom_id.clone(),
                kind: "domain".to_string(),
                label: dom.clone(),
                sublabel: rep
                    .mail_provider_hint
                    .clone()
                    .or_else(|| Some("Verified DNS Domain".to_string())),
                layer: "anchor".to_string(),
                confidence: 0.85,
                status: "unverified".to_string(),
                sources: vec!["direct-dns".to_string()],
                metadata: meta,
                url: Some(format!("https://{}", dom)),
                depth: 1,
            });
            ctx.add_edge(&seed_id, &dom_id, "domain_dns", 0.80, "direct-dns");

            let dmarc_note = match &rep.dmarc_record {
                Some(d) => format!("DMARC present ({})", d),
                None => "No DMARC record detected (spoofing exposure)".to_string(),
            };
            let sev = if rep.dmarc_record.is_none() {
                "medium"
            } else {
                "info"
            };
            ctx.add_finding(Finding {
                id: format!("finding:dns:{}", dom),
                node_id: dom_id,
                title: format!(
                    "Domain DNS Posture: {} ({})",
                    dom,
                    rep.mail_provider_hint.as_deref().unwrap_or("Custom MX")
                ),
                category: "corporate".to_string(),
                severity: sev.to_string(),
                confidence: 0.88,
                consensus_count: 1,
                sources: vec!["direct-dns".to_string()],
                summary: format!(
                    "Direct UDP DNS inspection found {} MX record(s). {}.",
                    rep.mx_records.len(),
                    dmarc_note
                ),
                pivot_trail: vec![
                    format!("Name: {}", input.full_name.trim()),
                    format!("Domain -> {}", dom),
                    "Direct UDP DNS MX/TXT".to_string(),
                ],
                url: Some(format!("https://{}", dom)),
                timestamp: now.clone(),
                sensitive_fields: vec![dom.clone()],
            });
            dns_grav_hits += 1;
        }
    }

    // Gravatar raw MD5 image HEAD check on known + permuted corporate emails
    let mut grav_emails: Vec<String> = known_emails.clone();
    for pc in &permuted_emails {
        if !grav_emails.contains(&pc.email) {
            grav_emails.push(pc.email.clone());
        }
    }

    for em in grav_emails.iter().take(8) {
        if let Some((md5_hex, avatar_url)) =
            dns_gravatar::check_gravatar_raw_hash(&client, em).await
        {
            let em_id = normalize_node_id("email", em);
            let mut meta = HashMap::new();
            meta.insert("gravatar_md5".to_string(), md5_hex.clone());
            meta.insert("avatar_url".to_string(), avatar_url.clone());

            ctx.add_node(GraphNode {
                id: em_id.clone(),
                kind: "email".to_string(),
                label: em.clone(),
                sublabel: Some("Gravatar Hash Confirmed".to_string()),
                layer: "anchor".to_string(),
                confidence: 0.88,
                status: "unverified".to_string(),
                sources: vec!["gravatar-raw".to_string()],
                metadata: meta,
                url: Some(avatar_url.clone()),
                depth: 1,
            });
            ctx.add_edge(&seed_id, &em_id, "gravatar_confirmed", 0.88, "gravatar-raw");

            ctx.add_finding(Finding {
                id: format!("finding:gravatar:{}", em),
                node_id: em_id,
                title: format!("Active Gravatar Avatar Confirmed for {}", em),
                category: "anchor".to_string(),
                severity: "medium".to_string(),
                confidence: 0.88,
                consensus_count: 1,
                sources: vec!["gravatar-raw".to_string()],
                summary: format!(
                    "Direct HEAD check against Gravatar raw avatar hash ({}) returned HTTP 200, confirming active email ownership.",
                    &md5_hex[..12]
                ),
                pivot_trail: vec![
                    format!("Name: {}", input.full_name.trim()),
                    format!("Email -> {}", em),
                    "Gravatar Raw MD5 HEAD -> 200 OK".to_string(),
                ],
                url: Some(avatar_url),
                timestamp: now.clone(),
                sensitive_fields: vec![em.clone(), md5_hex],
            });
            if seen_emails.insert(em.clone()) {
                known_emails.push(em.clone());
            }
            dns_grav_hits += 1;
        }
    }

    ctx.emit_tool(
        "dns-gravatar",
        "done",
        dns_grav_hits,
        &format!("{} DNS & Gravatar hash confirmations", dns_grav_hits),
    );

    // -------------------------------------------------------------------------
    // Stage 1: Direct Raw Git/Code Identity Pivot (NO GitHub API!)
    // -------------------------------------------------------------------------
    ctx.emit_stage(
        "git_raw",
        "Probing direct GitHub HTML, raw .keys, and raw .gpg blocks",
        42,
    );
    ctx.emit_tool(
        "git-raw",
        "running",
        0,
        "Direct raw HTML + .keys + .gpg extraction (zero API)",
    );

    let mut git_hits = 0usize;
    let mut confirmed_profile_urls: Vec<(String, String, Vec<String>)> = Vec::new();
    let handles_to_probe: Vec<String> = known_handles.iter().take(4).cloned().collect();

    for handle in &handles_to_probe {
        let prof = git_raw::probe_github_raw(&client, handle).await;
        if prof.exists {
            let h_id = normalize_node_id("handle", handle);
            let mut h_meta = HashMap::new();
            if let Some(ref dn) = prof.display_name {
                h_meta.insert("display_name".to_string(), dn.clone());
            }
            if let Some(ref org) = prof.org {
                h_meta.insert("org".to_string(), org.clone());
            }
            if let Some(ref loc) = prof.location {
                h_meta.insert("location".to_string(), loc.clone());
            }
            if !prof.ssh_keys.is_empty() {
                h_meta.insert("ssh_key_count".to_string(), prof.ssh_keys.len().to_string());
            }

            let name_match = prof
                .display_name
                .as_deref()
                .map(|d| shares_name_token(d, &input.full_name))
                .unwrap_or(false);
            let conf = if name_match { 0.86 } else { 0.64 };

            ctx.add_node(GraphNode {
                id: h_id.clone(),
                kind: "handle".to_string(),
                label: format!("@{}", handle),
                sublabel: prof
                    .display_name
                    .clone()
                    .or_else(|| Some("GitHub Profile".to_string())),
                layer: if name_match { "anchor" } else { "surface" }.to_string(),
                confidence: conf,
                status: "unverified".to_string(),
                sources: vec!["git-raw".to_string()],
                metadata: h_meta,
                url: Some(prof.profile_url.clone()),
                depth: 1,
            });
            ctx.add_edge(&seed_id, &h_id, "github_profile", conf, "git-raw");
            git_hits += 1;

            let base_trail = vec![
                format!("Name: {}", input.full_name.trim()),
                format!("GitHub Raw -> @{}", handle),
            ];
            confirmed_profile_urls.push((
                h_id.clone(),
                prof.profile_url.clone(),
                base_trail.clone(),
            ));

            if !prof.ssh_keys.is_empty() {
                ctx.add_finding(Finding {
                    id: format!("finding:git-ssh:{}", handle),
                    node_id: h_id.clone(),
                    title: format!(
                        "{} Public SSH Key(s) Exposed on github.com/{}.keys",
                        prof.ssh_keys.len(),
                        handle
                    ),
                    category: "code".to_string(),
                    severity: "low".to_string(),
                    confidence: conf,
                    consensus_count: 1,
                    sources: vec!["git-raw".to_string()],
                    summary: format!(
                        "Direct fetch of /{}.keys returned: {}",
                        handle,
                        prof.ssh_keys.join("; ")
                    ),
                    pivot_trail: base_trail.clone(),
                    url: Some(format!("https://github.com/{}.keys", handle)),
                    timestamp: now.clone(),
                    sensitive_fields: vec![handle.clone()],
                });
            }

            for gpg_em in &prof.gpg_emails {
                let em_id = normalize_node_id("email", gpg_em);
                ctx.add_node(GraphNode {
                    id: em_id.clone(),
                    kind: "email".to_string(),
                    label: gpg_em.clone(),
                    sublabel: Some("Extracted from GitHub .gpg".to_string()),
                    layer: "anchor".to_string(),
                    confidence: 0.90,
                    status: "unverified".to_string(),
                    sources: vec!["git-raw-gpg".to_string()],
                    metadata: HashMap::new(),
                    url: Some(format!("https://github.com/{}.gpg", handle)),
                    depth: 1,
                });
                ctx.add_edge(&h_id, &em_id, "gpg_key_email", 0.90, "git-raw-gpg");

                let mut trail = base_trail.clone();
                trail.push(format!("Raw .gpg Packet 13 -> {}", gpg_em));
                ctx.add_finding(Finding {
                    id: format!("finding:git-gpg:{}:{}", handle, gpg_em),
                    node_id: em_id,
                    title: format!("Raw GitHub .gpg Key Exposes Email {}", gpg_em),
                    category: "code".to_string(),
                    severity: "high".to_string(),
                    confidence: 0.90,
                    consensus_count: 1,
                    sources: vec!["git-raw-gpg".to_string()],
                    summary: format!(
                        "Pure-Rust RFC 4880 parser decoded OpenPGP User ID packets directly from github.com/{}.gpg.",
                        handle
                    ),
                    pivot_trail: trail,
                    url: Some(format!("https://github.com/{}.gpg", handle)),
                    timestamp: now.clone(),
                    sensitive_fields: vec![gpg_em.clone()],
                });

                if seen_emails.insert(gpg_em.clone()) {
                    known_emails.push(gpg_em.clone());
                }
            }

            if let Some(ref org) = prof.org {
                let org_id = normalize_node_id("org", org);
                ctx.add_node(GraphNode {
                    id: org_id.clone(),
                    kind: "org".to_string(),
                    label: org.clone(),
                    sublabel: Some("GitHub Profile Org".to_string()),
                    layer: "anchor".to_string(),
                    confidence: 0.78,
                    status: "unverified".to_string(),
                    sources: vec!["git-raw".to_string()],
                    metadata: HashMap::new(),
                    url: None,
                    depth: 1,
                });
                ctx.add_edge(&h_id, &org_id, "works_at", 0.78, "git-raw");
            }

            for ext_url in prof.external_links.iter().take(4) {
                confirmed_profile_urls.push((h_id.clone(), ext_url.clone(), base_trail.clone()));
            }
        }
    }

    ctx.emit_tool(
        "git-raw",
        "done",
        git_hits,
        &format!(
            "{} direct GitHub HTML/.keys/.gpg profile(s) resolved",
            git_hits
        ),
    );

    // -------------------------------------------------------------------------
    // Stage 2: Native Rust Direct-HTML WhatsMyName Engine
    // -------------------------------------------------------------------------
    ctx.emit_stage(
        "wmn",
        "Executing native Rust WhatsMyName engine across 80 direct HTML platforms",
        56,
    );
    ctx.emit_tool(
        "wmn-native",
        "running",
        0,
        "Concurrent direct HTML profile checks",
    );

    let wmn_handles: Vec<String> = known_handles.iter().take(2).cloned().collect();
    let mut wmn_total_hits = 0usize;

    for handle in &wmn_handles {
        let h_id = normalize_node_id("handle", handle);
        let hits = wmn::run_wmn_for_handle(&client, handle, 14).await;
        for hit in hits {
            wmn_total_hits += 1;
            let acct_key = format!(
                "{}@{}",
                hit.site_name.to_lowercase(),
                hit.handle.to_lowercase()
            );
            let acct_id = normalize_node_id("account", &acct_key);

            let mut meta = HashMap::new();
            meta.insert("platform".to_string(), hit.site_name.clone());
            meta.insert("handle".to_string(), hit.handle.clone());

            ctx.add_node(GraphNode {
                id: acct_id.clone(),
                kind: "account".to_string(),
                label: format!("{} ({})", hit.site_name, hit.handle),
                sublabel: Some(hit.site_name.clone()),
                layer: "surface".to_string(),
                confidence: hit.confidence,
                status: "unverified".to_string(),
                sources: vec!["wmn-native".to_string()],
                metadata: meta,
                url: Some(hit.url.clone()),
                depth: 1,
            });

            // Link via handle node if present, else seed
            let parent_id = if db.get_node(&case_id, &h_id).ok().flatten().is_some() {
                h_id.clone()
            } else {
                seed_id.clone()
            };
            ctx.add_edge(
                &parent_id,
                &acct_id,
                "account_on",
                hit.confidence,
                "wmn-native",
            );

            let trail = vec![
                format!("Name: {}", input.full_name.trim()),
                format!("Handle -> @{}", hit.handle),
                format!("WhatsMyName -> {}", hit.site_name),
            ];

            ctx.add_finding(Finding {
                id: format!(
                    "finding:account:{}:{}",
                    hit.site_name.to_lowercase(),
                    hit.handle.to_lowercase()
                ),
                node_id: acct_id.clone(),
                title: format!("{} Account: @{}", hit.site_name, hit.handle),
                category: hit.category.clone(),
                severity: if hit.category == "code" || hit.category == "corporate" {
                    "low"
                } else {
                    "info"
                }
                .to_string(),
                confidence: hit.confidence,
                consensus_count: 1,
                sources: vec!["wmn-native".to_string()],
                summary: format!(
                    "Direct HTML signature check matched active {} profile for handle '{}'.",
                    hit.site_name, hit.handle
                ),
                pivot_trail: trail.clone(),
                url: Some(hit.url.clone()),
                timestamp: now.clone(),
                sensitive_fields: vec![hit.handle.clone()],
            });

            if confirmed_profile_urls.len() < 10 {
                confirmed_profile_urls.push((acct_id, hit.url, trail));
            }
        }
    }

    ctx.emit_tool(
        "wmn-native",
        "done",
        wmn_total_hits,
        &format!(
            "{} direct-HTML platform hit(s) across {} handle(s)",
            wmn_total_hits,
            wmn_handles.len()
        ),
    );

    // -------------------------------------------------------------------------
    // Stage 2B: Depth-2 Native HTML / Profile Deep Extractor (socid-extractor)
    // -------------------------------------------------------------------------
    let mut discovered_pdf_urls: Vec<String> = Vec::new();
    if input.max_depth >= 2 && !confirmed_profile_urls.is_empty() {
        ctx.emit_stage(
            "html_extractor",
            "Deep-extracting OpenGraph, JSON-LD sameAs & cross-handles (Depth 2)",
            70,
        );
        ctx.emit_tool(
            "html-extractor",
            "running",
            0,
            &format!(
                "Parsing {} confirmed profile HTML pages",
                confirmed_profile_urls.len().min(8)
            ),
        );

        let mut ext_hits = 0usize;
        let mut seen_extract_urls = HashSet::new();

        for (parent_node_id, url, base_trail) in confirmed_profile_urls.iter().take(8) {
            if !seen_extract_urls.insert(url.clone()) {
                continue;
            }
            if let Some(data) = html_extractor::extract_profile_html(&client, url).await {
                for sa in &data.same_as_urls {
                    if sa.to_lowercase().contains(".pdf") && !discovered_pdf_urls.contains(sa) {
                        discovered_pdf_urls.push(sa.clone());
                    }
                }
                for em in data.emails {
                    let em_id = normalize_node_id("email", &em);
                    ctx.add_node(GraphNode {
                        id: em_id.clone(),
                        kind: "email".to_string(),
                        label: em.clone(),
                        sublabel: Some("Extracted from Profile HTML".to_string()),
                        layer: "deep".to_string(),
                        confidence: 0.80,
                        status: "unverified".to_string(),
                        sources: vec!["html-extractor".to_string()],
                        metadata: HashMap::new(),
                        url: Some(url.clone()),
                        depth: 2,
                    });
                    ctx.add_edge(
                        parent_node_id,
                        &em_id,
                        "mentions_email",
                        0.80,
                        "html-extractor",
                    );

                    let mut trail = base_trail.clone();
                    trail.push(format!("HTML Extract -> {}", em));
                    ctx.add_finding(Finding {
                        id: format!("finding:html-email:{}", em),
                        node_id: em_id,
                        title: format!("Embedded Email Discovered: {}", em),
                        category: "anchor".to_string(),
                        severity: "medium".to_string(),
                        confidence: 0.80,
                        consensus_count: 1,
                        sources: vec!["html-extractor".to_string()],
                        summary: format!(
                            "Direct HTML/JSON-LD extraction from {} surfaced email '{}'.",
                            url, em
                        ),
                        pivot_trail: trail,
                        url: Some(url.clone()),
                        timestamp: now.clone(),
                        sensitive_fields: vec![em.clone()],
                    });

                    if seen_emails.insert(em.clone()) {
                        known_emails.push(em);
                    }
                    ext_hits += 1;
                }

                for (platform, cross_h) in data.cross_handles.into_iter().take(4) {
                    let acct_key = format!("{}@{}", platform.to_lowercase(), cross_h);
                    let acct_id = normalize_node_id("account", &acct_key);
                    ctx.add_node(GraphNode {
                        id: acct_id.clone(),
                        kind: "account".to_string(),
                        label: format!("{} ({})", platform, cross_h),
                        sublabel: Some("Cross-linked Profile".to_string()),
                        layer: "deep".to_string(),
                        confidence: 0.78,
                        status: "unverified".to_string(),
                        sources: vec!["html-extractor".to_string()],
                        metadata: HashMap::new(),
                        url: Some(url.clone()),
                        depth: 2,
                    });
                    ctx.add_edge(parent_node_id, &acct_id, "links_to", 0.78, "html-extractor");
                    if seen_handles.insert(cross_h) {
                        ext_hits += 1;
                    }
                }

                for org in data.orgs {
                    let org_id = normalize_node_id("org", &org);
                    ctx.add_node(GraphNode {
                        id: org_id.clone(),
                        kind: "org".to_string(),
                        label: org.clone(),
                        sublabel: Some("JSON-LD Affiliation".to_string()),
                        layer: "deep".to_string(),
                        confidence: 0.76,
                        status: "unverified".to_string(),
                        sources: vec!["html-extractor".to_string()],
                        metadata: HashMap::new(),
                        url: Some(url.clone()),
                        depth: 2,
                    });
                    ctx.add_edge(parent_node_id, &org_id, "works_for", 0.76, "html-extractor");
                    ext_hits += 1;
                }
            }
        }

        ctx.emit_tool(
            "html-extractor",
            "done",
            ext_hits,
            &format!("{} depth-2 identity pivot(s) extracted locally", ext_hits),
        );
    }

    // -------------------------------------------------------------------------
    // Stage 2C: Pure-Rust Public PDF Document Metadata Engine
    // -------------------------------------------------------------------------
    let mut pdf_targets = discovered_pdf_urls;
    let corp_domains: Vec<String> = known_domains
        .iter()
        .filter(|d| !is_free_mail_provider(d))
        .take(2)
        .cloned()
        .collect();

    if !corp_domains.is_empty() || !pdf_targets.is_empty() {
        ctx.emit_stage(
            "doc_meta",
            "Extracting author & toolchain metadata from public corporate PDFs",
            75,
        );
        ctx.emit_tool(
            "doc-meta",
            "running",
            0,
            "Scanning public pages for PDFs & parsing Info/XMP dictionaries",
        );

        for dom in &corp_domains {
            if pdf_targets.len() >= 5 {
                break;
            }
            for link in doc_meta::discover_domain_pdfs(&client, dom).await {
                if !pdf_targets.contains(&link) {
                    pdf_targets.push(link);
                    if pdf_targets.len() >= 5 {
                        break;
                    }
                }
            }
        }

        let mut doc_hits = 0usize;
        for pdf_url in pdf_targets.iter().take(5) {
            if let Some(meta) = doc_meta::fetch_and_parse_pdf(&client, pdf_url).await {
                let has_useful_meta = meta.author.is_some()
                    || meta.creator.is_some()
                    || !meta.internal_usernames.is_empty()
                    || !meta.emails.is_empty();
                if !has_useful_meta {
                    continue;
                }

                let doc_id = normalize_node_id("document", &meta.url);
                let mut doc_props = HashMap::new();
                if let Some(ref a) = meta.author {
                    doc_props.insert("author".to_string(), a.clone());
                }
                if let Some(ref c) = meta.creator {
                    doc_props.insert("creator".to_string(), c.clone());
                }
                if let Some(ref p) = meta.producer {
                    doc_props.insert("producer".to_string(), p.clone());
                }
                if let Some(ref dt) = meta.creation_date {
                    doc_props.insert("creation_date".to_string(), dt.clone());
                }

                let author_matches_target = meta
                    .author
                    .as_deref()
                    .map(|a| shares_name_token(a, &input.full_name))
                    .unwrap_or(false);
                let conf = if author_matches_target || !meta.emails.is_empty() {
                    0.86
                } else {
                    0.72
                };

                ctx.add_node(GraphNode {
                    id: doc_id.clone(),
                    kind: "document".to_string(),
                    label: meta.file_name.clone(),
                    sublabel: meta
                        .author
                        .clone()
                        .or_else(|| meta.creator.clone())
                        .or_else(|| Some("Public PDF Metadata".to_string())),
                    layer: if author_matches_target {
                        "anchor"
                    } else {
                        "deep"
                    }
                    .to_string(),
                    confidence: conf,
                    status: "unverified".to_string(),
                    sources: vec!["doc-meta".to_string()],
                    metadata: doc_props,
                    url: Some(meta.url.clone()),
                    depth: 2,
                });

                let parent_id = corp_domains
                    .first()
                    .map(|d| normalize_node_id("domain", d))
                    .filter(|id| db.get_node(&case_id, id).ok().flatten().is_some())
                    .unwrap_or_else(|| seed_id.clone());
                ctx.add_edge(&parent_id, &doc_id, "publishes_pdf", conf, "doc-meta");

                let mut details = Vec::new();
                if let Some(ref a) = meta.author {
                    details.push(format!("Author: {}", a));
                }
                if let Some(ref c) = meta.creator {
                    details.push(format!("Creator: {}", c));
                }
                if let Some(ref p) = meta.producer {
                    details.push(format!("Producer: {}", p));
                }
                if details.is_empty() {
                    details.push("embedded username/email indicators".to_string());
                }

                let mut sens = Vec::new();
                if let Some(ref a) = meta.author {
                    sens.push(a.clone());
                }

                ctx.add_finding(Finding {
                    id: format!("finding:pdf:{}", doc_id),
                    node_id: doc_id.clone(),
                    title: format!("Public PDF Metadata Leak: {}", meta.file_name),
                    category: "corporate".to_string(),
                    severity: if author_matches_target || !meta.internal_usernames.is_empty() {
                        "medium"
                    } else {
                        "low"
                    }
                    .to_string(),
                    confidence: conf,
                    consensus_count: 1,
                    sources: vec!["doc-meta".to_string()],
                    summary: format!(
                        "Pure-Rust PDF parser extracted {} from {}.",
                        details.join(" · "),
                        meta.file_name
                    ),
                    pivot_trail: vec![
                        format!("Name: {}", input.full_name.trim()),
                        format!("Public PDF -> {}", meta.file_name),
                        details
                            .first()
                            .cloned()
                            .unwrap_or_else(|| "PDF Info/XMP".to_string()),
                    ],
                    url: Some(meta.url.clone()),
                    timestamp: now.clone(),
                    sensitive_fields: sens,
                });
                doc_hits += 1;

                for u in meta.internal_usernames {
                    let u_id = normalize_node_id("handle", &u);
                    ctx.add_node(GraphNode {
                        id: u_id.clone(),
                        kind: "handle".to_string(),
                        label: format!("@{}", u),
                        sublabel: Some("PDF Internal Path Username".to_string()),
                        layer: "deep".to_string(),
                        confidence: 0.82,
                        status: "unverified".to_string(),
                        sources: vec!["doc-meta".to_string()],
                        metadata: HashMap::new(),
                        url: Some(meta.url.clone()),
                        depth: 2,
                    });
                    ctx.add_edge(&doc_id, &u_id, "leaks_username", 0.82, "doc-meta");
                    if seen_handles.insert(u.to_lowercase()) {
                        known_handles.push(u.to_lowercase());
                    }
                    doc_hits += 1;
                }

                for em in meta.emails {
                    let em_id = normalize_node_id("email", &em);
                    ctx.add_node(GraphNode {
                        id: em_id.clone(),
                        kind: "email".to_string(),
                        label: em.clone(),
                        sublabel: Some("Embedded PDF Metadata Email".to_string()),
                        layer: "anchor".to_string(),
                        confidence: 0.85,
                        status: "unverified".to_string(),
                        sources: vec!["doc-meta".to_string()],
                        metadata: HashMap::new(),
                        url: Some(meta.url.clone()),
                        depth: 2,
                    });
                    ctx.add_edge(&doc_id, &em_id, "mentions_email", 0.85, "doc-meta");
                    if seen_emails.insert(em.clone()) {
                        known_emails.push(em);
                    }
                    doc_hits += 1;
                }
            }
        }

        ctx.emit_tool(
            "doc-meta",
            "done",
            doc_hits,
            &format!(
                "Parsed {} public PDF(s) — {} metadata artifact(s)",
                pdf_targets.len().min(5),
                doc_hits
            ),
        );
    } else {
        ctx.emit_tool(
            "doc-meta",
            "skipped",
            0,
            "No corporate domain or public PDF links discovered to inspect",
        );
    }

    // -------------------------------------------------------------------------
    // Stage 3A: Direct Native Rust Tor SOCKS5 Engine (socks5h://)
    // -------------------------------------------------------------------------
    let mut search_terms: Vec<String> = vec![input.full_name.trim().to_string()];
    search_terms.extend(known_emails.iter().take(4).cloned());
    search_terms.extend(known_handles.iter().take(3).cloned());
    if let Some(ref ph) = input.phone {
        if !ph.trim().is_empty() {
            search_terms.push(ph.trim().to_string());
        }
    }

    if input.enable_tor {
        ctx.emit_stage(
            "tor_darkweb",
            "Probing local Tor SOCKS5h daemon & crawling configured .onion seeds",
            80,
        );
        ctx.emit_tool(
            "tor-socks5h",
            "running",
            0,
            "Checking local 127.0.0.1:9050 / 9150",
        );

        let tor_status = tor_darkweb::detect_local_tor(auth.tor_socks_url.as_deref());
        if !tor_status.available {
            ctx.emit_tool(
                "tor-socks5h",
                "skipped",
                0,
                "No local Tor SOCKS5 daemon detected on 127.0.0.1:9050 or 9150 — start Tor/Tor Browser to crawl .onion seeds",
            );
        } else if auth.custom_onion_seeds.is_empty() {
            ctx.emit_tool(
                "tor-socks5h",
                "done",
                0,
                &format!(
                    "Tor SOCKS5h ready at {} — add .onion seed URLs in Config & Tools to crawl hidden services",
                    tor_status.endpoint.as_deref().unwrap_or("socks5h://127.0.0.1:9050")
                ),
            );
        } else {
            let endpoint = tor_status.endpoint.unwrap();
            match tor_darkweb::crawl_onion_seeds_over_tor(
                &endpoint,
                &auth.custom_onion_seeds,
                &search_terms,
            )
            .await
            {
                Ok(hits) => {
                    let count = hits.len();
                    for hit in hits {
                        let onion_id = normalize_node_id("onion", &hit.onion_url);
                        let mut meta = HashMap::new();
                        meta.insert("matched_term".to_string(), hit.matched_term.clone());
                        meta.insert("title".to_string(), hit.title.clone());
                        meta.insert("transport".to_string(), endpoint.clone());

                        ctx.add_node(GraphNode {
                            id: onion_id.clone(),
                            kind: "onion".to_string(),
                            label: hit.title.clone(),
                            sublabel: Some("Tor .onion Mention".to_string()),
                            layer: "darkweb".to_string(),
                            confidence: 0.84,
                            status: "unverified".to_string(),
                            sources: vec!["tor-socks5h".to_string()],
                            metadata: meta,
                            url: Some(hit.onion_url.clone()),
                            depth: 2,
                        });
                        ctx.add_edge(&seed_id, &onion_id, "onion_mention", 0.84, "tor-socks5h");

                        ctx.add_finding(Finding {
                            id: format!("finding:onion:{}", onion_id),
                            node_id: onion_id,
                            title: format!("Tor Hidden Service Mention: {}", hit.title),
                            category: "darkweb".to_string(),
                            severity: "critical".to_string(),
                            confidence: 0.84,
                            consensus_count: 1,
                            sources: vec!["tor-socks5h".to_string()],
                            summary: format!(
                                "Direct socks5h:// crawl matched '{}' — excerpt: \"{}\"",
                                hit.matched_term, hit.snippet
                            ),
                            pivot_trail: vec![
                                format!("Name: {}", input.full_name.trim()),
                                format!("Tor socks5h -> {}", hit.matched_term),
                                hit.onion_url.clone(),
                            ],
                            url: Some(hit.onion_url),
                            timestamp: now.clone(),
                            sensitive_fields: vec![hit.matched_term, hit.snippet],
                        });
                    }
                    ctx.emit_tool(
                        "tor-socks5h",
                        "done",
                        count,
                        &format!(
                            "Crawled {} .onion seed(s) via {} — {} hit(s)",
                            auth.custom_onion_seeds.len(),
                            endpoint,
                            count
                        ),
                    );
                }
                Err(e) => {
                    ctx.emit_tool("tor-socks5h", "error", 0, &e);
                }
            }
        }
    } else {
        ctx.emit_tool("tor-socks5h", "skipped", 0, "Tor / Dark Web toggle is OFF");
    }

    // -------------------------------------------------------------------------
    // Stage 3B: Local Sovereign Corpus Scanner (Offline Breach/Paste Folder)
    // -------------------------------------------------------------------------
    if let Some(ref corpus_dir) = auth.local_corpus_dir {
        let trimmed = corpus_dir.trim().to_string();
        if !trimmed.is_empty() {
            ctx.emit_stage(
                "local_corpus",
                "Scanning local offline breach/paste corpus folder",
                86,
            );
            ctx.emit_tool(
                "local-corpus",
                "running",
                0,
                &format!("Scanning {}", trimmed),
            );

            let terms_clone = search_terms.clone();
            let dir_clone = trimmed.clone();
            let scan_res = tokio::task::spawn_blocking(move || {
                local_corpus::scan_local_corpus(&dir_clone, &terms_clone)
            })
            .await;

            match scan_res {
                Ok(Ok(hits)) => {
                    let count = hits.len();
                    for hit in hits {
                        let b_id = normalize_node_id(
                            "breach",
                            &format!("{}:{}", hit.file_name, hit.matched_term),
                        );
                        let mut meta = HashMap::new();
                        meta.insert("file".to_string(), hit.file_path.clone());
                        meta.insert("line".to_string(), hit.line_number.to_string());
                        meta.insert("matched".to_string(), hit.matched_term.clone());

                        ctx.add_node(GraphNode {
                            id: b_id.clone(),
                            kind: "breach".to_string(),
                            label: format!("Corpus: {}", hit.file_name),
                            sublabel: Some(format!("Line {} · Redacted", hit.line_number)),
                            layer: "darkweb".to_string(),
                            confidence: 0.92,
                            status: "unverified".to_string(),
                            sources: vec!["local-corpus".to_string()],
                            metadata: meta,
                            url: None,
                            depth: 2,
                        });
                        ctx.add_edge(&seed_id, &b_id, "corpus_exposure", 0.92, "local-corpus");

                        ctx.add_finding(Finding {
                            id: format!("finding:corpus:{}:{}", hit.file_name, hit.line_number),
                            node_id: b_id,
                            title: format!("Local Corpus Exposure in {} (line {})", hit.file_name, hit.line_number),
                            category: "breach".to_string(),
                            severity: if hit.has_credential_shape { "high" } else { "medium" }.to_string(),
                            confidence: 0.92,
                            consensus_count: 1,
                            sources: vec!["local-corpus".to_string()],
                            summary: format!(
                                "Matched '{}' in local authorized corpus file '{}'. Metadata preview: {}",
                                hit.matched_term, hit.file_name, hit.redacted_preview
                            ),
                            pivot_trail: vec![
                                format!("Name: {}", input.full_name.trim()),
                                format!("Local Corpus -> {}", hit.file_name),
                                format!("Match -> {}", hit.matched_term),
                            ],
                            url: None,
                            timestamp: now.clone(),
                            sensitive_fields: vec![hit.matched_term, hit.redacted_preview],
                        });
                    }
                    ctx.emit_tool(
                        "local-corpus",
                        "done",
                        count,
                        &format!("Scanned local folder — {} redacted exposure hit(s)", count),
                    );
                }
                Ok(Err(e)) => ctx.emit_tool("local-corpus", "error", 0, &e),
                Err(e) => ctx.emit_tool("local-corpus", "error", 0, &e.to_string()),
            }
        }
    } else {
        ctx.emit_tool(
            "local-corpus",
            "skipped",
            0,
            "No local corpus folder configured (set in Config & Tools for offline breach scanning)",
        );
    }

    // -------------------------------------------------------------------------
    // Stage 4: Local Open-Source Sidecar Bridge (Installed Laptop CLI Tools)
    // -------------------------------------------------------------------------
    ctx.emit_stage(
        "sidecar",
        "Invoking detected local open-source CLI sidecar tools",
        92,
    );
    let sidecar_handles: Vec<String> = known_handles.iter().take(2).cloned().collect();
    let sidecar_emails: Vec<String> = known_emails.iter().take(3).cloned().collect();

    let _ =
        sidecar::run_sidecar_bridge(
            &input,
            &auth,
            &sidecar_handles,
            &sidecar_emails,
            |ev| match ev.kind.as_str() {
                "tool_status" => {
                    ctx.emit_tool(
                        &ev.tool,
                        ev.state.as_deref().unwrap_or("done"),
                        ev.hits.unwrap_or(0),
                        ev.detail.as_deref().unwrap_or(""),
                    );
                }
                "finding" | "node" => {
                    let entity_kind = ev.entity_kind.as_deref().unwrap_or("account");
                    let label = ev.label.clone().unwrap_or_else(|| ev.tool.clone());
                    let node_id = normalize_node_id(entity_kind, &label);
                    let layer = match ev.category.as_deref() {
                        Some("darkweb") | Some("breach") => "darkweb",
                        Some("anchor") => "anchor",
                        _ => "surface",
                    };
                    let conf = ev.confidence.unwrap_or(0.74);

                    ctx.add_node(GraphNode {
                        id: node_id.clone(),
                        kind: entity_kind.to_string(),
                        label: label.clone(),
                        sublabel: Some(format!("Sidecar: {}", ev.tool)),
                        layer: layer.to_string(),
                        confidence: conf,
                        status: "unverified".to_string(),
                        sources: vec![ev.tool.clone()],
                        metadata: HashMap::new(),
                        url: ev.url.clone(),
                        depth: 1,
                    });
                    ctx.add_edge(&seed_id, &node_id, "sidecar_match", conf, &ev.tool);

                    ctx.add_finding(Finding {
                        id: format!("finding:sidecar:{}:{}", entity_kind, node_id),
                        node_id,
                        title: format!("{} via {}", label, ev.tool),
                        category: ev.category.unwrap_or_else(|| "account".to_string()),
                        severity: if layer == "darkweb" { "high" } else { "low" }.to_string(),
                        confidence: conf,
                        consensus_count: 1,
                        sources: vec![ev.tool.clone()],
                        summary: ev.summary.unwrap_or_else(|| {
                            format!("Local sidecar tool '{}' corroborated '{}'.", ev.tool, label)
                        }),
                        pivot_trail: vec![
                            format!("Name: {}", input.full_name.trim()),
                            format!("Sidecar ({}) -> {}", ev.tool, label),
                        ],
                        url: ev.url,
                        timestamp: Utc::now().to_rfc3339(),
                        sensitive_fields: vec![label],
                    });
                }
                _ => {}
            },
        )
        .await;

    finish_case(&ctx);
}

/// Confirm an anchor node and run a targeted deeper pivot on that specific handle/email/domain/account.
pub async fn run_deepen_node(
    app: AppHandle,
    db: Arc<Database>,
    case_id: String,
    node_id: String,
    auth: AuthConfig,
) {
    let ctx = InvestigationContext {
        case_id: case_id.clone(),
        db: db.clone(),
        app: app.clone(),
    };

    let Ok(Some(node)) = db.get_node(&case_id, &node_id) else {
        return;
    };

    // Confirm the node first
    let _ = db.set_node_status(&case_id, &node_id, "confirmed");
    if let Ok(Some(updated)) = db.get_node(&case_id, &node_id) {
        let _ = app.emit(
            EVENT_NAME,
            StreamEvent::Node {
                case_id: case_id.clone(),
                node: updated,
            },
        );
    }

    let Ok(client) = build_http_client(&auth) else {
        return;
    };
    let now = Utc::now().to_rfc3339();
    ctx.emit_stage(
        "deepen",
        &format!("Deepening confirmed anchor: {}", node.label),
        25,
    );

    match node.kind.as_str() {
        "handle" => {
            let handle = node.label.trim().trim_start_matches('@').to_string();
            ctx.emit_tool(
                "deepen-pivot",
                "running",
                0,
                &format!("Deepening @{} across WMN & GitHub raw", handle),
            );

            let prof = git_raw::probe_github_raw(&client, &handle).await;
            let mut hits = 0usize;
            for em in prof.gpg_emails {
                let em_id = normalize_node_id("email", &em);
                ctx.add_node(GraphNode {
                    id: em_id.clone(),
                    kind: "email".to_string(),
                    label: em.clone(),
                    sublabel: Some("Deepened GitHub .gpg Email".to_string()),
                    layer: "deep".to_string(),
                    confidence: 0.92,
                    status: "unverified".to_string(),
                    sources: vec!["deepen-git-gpg".to_string()],
                    metadata: HashMap::new(),
                    url: Some(format!("https://github.com/{}.gpg", handle)),
                    depth: (node.depth + 1).min(2),
                });
                ctx.add_edge(&node_id, &em_id, "gpg_key_email", 0.92, "deepen-git-gpg");
                ctx.add_finding(Finding {
                    id: format!("finding:deepen-gpg:{}:{}", handle, em),
                    node_id: em_id,
                    title: format!("Deepened Pivot: GPG Email {}", em),
                    category: "anchor".to_string(),
                    severity: "high".to_string(),
                    confidence: 0.92,
                    consensus_count: 1,
                    sources: vec!["deepen-git-gpg".to_string()],
                    summary: format!(
                        "Confirmed handle @{} exposed email {} in raw .gpg key block.",
                        handle, em
                    ),
                    pivot_trail: vec![
                        format!("Confirmed: @{}", handle),
                        format!("GitHub .gpg -> {}", em),
                    ],
                    url: Some(format!("https://github.com/{}.gpg", handle)),
                    timestamp: now.clone(),
                    sensitive_fields: vec![em],
                });
                hits += 1;
            }

            let wmn_hits = wmn::run_wmn_for_handle(&client, &handle, 16).await;
            for hit in wmn_hits {
                let acct_id =
                    normalize_node_id("account", &format!("{}@{}", hit.site_name, hit.handle));
                ctx.add_node(GraphNode {
                    id: acct_id.clone(),
                    kind: "account".to_string(),
                    label: format!("{} ({})", hit.site_name, hit.handle),
                    sublabel: Some(hit.site_name.clone()),
                    layer: "deep".to_string(),
                    confidence: (hit.confidence + 0.08).min(0.95),
                    status: "unverified".to_string(),
                    sources: vec!["deepen-wmn".to_string()],
                    metadata: HashMap::new(),
                    url: Some(hit.url.clone()),
                    depth: (node.depth + 1).min(2),
                });
                ctx.add_edge(&node_id, &acct_id, "account_on", 0.80, "deepen-wmn");
                ctx.add_finding(Finding {
                    id: format!(
                        "finding:account:{}:{}",
                        hit.site_name.to_lowercase(),
                        hit.handle.to_lowercase()
                    ),
                    node_id: acct_id,
                    title: format!("{} Account: @{}", hit.site_name, hit.handle),
                    category: hit.category,
                    severity: "low".to_string(),
                    confidence: (hit.confidence + 0.08).min(0.95),
                    consensus_count: 1,
                    sources: vec!["deepen-wmn".to_string()],
                    summary: format!(
                        "Targeted deepen pivot confirmed {} profile for @{}.",
                        hit.site_name, hit.handle
                    ),
                    pivot_trail: vec![
                        format!("Confirmed: @{}", handle),
                        format!("WhatsMyName -> {}", hit.site_name),
                    ],
                    url: Some(hit.url),
                    timestamp: now.clone(),
                    sensitive_fields: vec![hit.handle],
                });
                hits += 1;
            }
            ctx.emit_tool(
                "deepen-pivot",
                "done",
                hits,
                &format!("Deepened @{} -> {} hit(s)", handle, hits),
            );
        }
        "email" => {
            let email = node.label.trim().to_lowercase();
            ctx.emit_tool(
                "deepen-pivot",
                "running",
                0,
                &format!("Deepening {} via HKP, Gravatar & local part handle", email),
            );
            let mut hits = 0usize;

            if let Ok(recs) = hkp::lookup_hkp(&client, &email).await {
                for rec in recs {
                    let pgp_id = normalize_node_id("pgp_key", &rec.key_id);
                    ctx.add_node(GraphNode {
                        id: pgp_id.clone(),
                        kind: "pgp_key".to_string(),
                        label: format!(
                            "PGP 0x{}",
                            &rec.key_id[rec.key_id.len().saturating_sub(16)..]
                        ),
                        sublabel: Some("OpenPGP Key".to_string()),
                        layer: "deep".to_string(),
                        confidence: 0.90,
                        status: "unverified".to_string(),
                        sources: vec!["deepen-hkp".to_string()],
                        metadata: HashMap::new(),
                        url: Some(format!(
                            "https://keyserver.ubuntu.com/pks/lookup?search=0x{}&op=index",
                            rec.key_id
                        )),
                        depth: (node.depth + 1).min(2),
                    });
                    ctx.add_edge(&node_id, &pgp_id, "pgp_key_match", 0.90, "deepen-hkp");
                    hits += 1;
                }
            }

            if let Some((md5_hex, avatar_url)) =
                dns_gravatar::check_gravatar_raw_hash(&client, &email).await
            {
                ctx.add_finding(Finding {
                    id: format!("finding:gravatar:{}", email),
                    node_id: node_id.clone(),
                    title: format!("Active Gravatar Confirmed for {}", email),
                    category: "anchor".to_string(),
                    severity: "medium".to_string(),
                    confidence: 0.90,
                    consensus_count: 1,
                    sources: vec!["deepen-gravatar".to_string()],
                    summary: format!(
                        "Direct Gravatar MD5 HEAD confirmed active profile hash {}.",
                        &md5_hex[..12]
                    ),
                    pivot_trail: vec![
                        format!("Confirmed: {}", email),
                        "Gravatar MD5 HEAD -> 200 OK".to_string(),
                    ],
                    url: Some(avatar_url),
                    timestamp: now.clone(),
                    sensitive_fields: vec![email.clone()],
                });
                hits += 1;
            }

            // Pivot on email local-part as a handle
            if let Some(local_part) = email.split('@').next() {
                if local_part.len() >= 3 {
                    let wmn_hits = wmn::run_wmn_for_handle(&client, local_part, 14).await;
                    for hit in wmn_hits {
                        let acct_id = normalize_node_id(
                            "account",
                            &format!("{}@{}", hit.site_name, hit.handle),
                        );
                        ctx.add_node(GraphNode {
                            id: acct_id.clone(),
                            kind: "account".to_string(),
                            label: format!("{} ({})", hit.site_name, hit.handle),
                            sublabel: Some("From Email Local-Part".to_string()),
                            layer: "deep".to_string(),
                            confidence: hit.confidence,
                            status: "unverified".to_string(),
                            sources: vec!["deepen-wmn".to_string()],
                            metadata: HashMap::new(),
                            url: Some(hit.url.clone()),
                            depth: (node.depth + 1).min(2),
                        });
                        ctx.add_edge(
                            &node_id,
                            &acct_id,
                            "local_part_account",
                            hit.confidence,
                            "deepen-wmn",
                        );
                        hits += 1;
                    }
                }
            }

            ctx.emit_tool(
                "deepen-pivot",
                "done",
                hits,
                &format!("Deepened {} -> {} pivot(s)", email, hits),
            );
        }
        _ => {
            if let Some(ref url) = node.url {
                ctx.emit_tool(
                    "deepen-pivot",
                    "running",
                    0,
                    &format!("Deep-extracting HTML from {}", url),
                );
                let mut hits = 0usize;
                if let Some(ext) = html_extractor::extract_profile_html(&client, url).await {
                    for em in ext.emails {
                        let em_id = normalize_node_id("email", &em);
                        ctx.add_node(GraphNode {
                            id: em_id.clone(),
                            kind: "email".to_string(),
                            label: em.clone(),
                            sublabel: Some("HTML Deep Extract".to_string()),
                            layer: "deep".to_string(),
                            confidence: 0.84,
                            status: "unverified".to_string(),
                            sources: vec!["deepen-html".to_string()],
                            metadata: HashMap::new(),
                            url: Some(url.clone()),
                            depth: (node.depth + 1).min(2),
                        });
                        ctx.add_edge(&node_id, &em_id, "mentions_email", 0.84, "deepen-html");
                        hits += 1;
                    }
                    for (plat, h) in ext.cross_handles {
                        let acct_id = normalize_node_id("account", &format!("{}@{}", plat, h));
                        ctx.add_node(GraphNode {
                            id: acct_id.clone(),
                            kind: "account".to_string(),
                            label: format!("{} ({})", plat, h),
                            sublabel: Some("Cross-linked Profile".to_string()),
                            layer: "deep".to_string(),
                            confidence: 0.80,
                            status: "unverified".to_string(),
                            sources: vec!["deepen-html".to_string()],
                            metadata: HashMap::new(),
                            url: Some(url.clone()),
                            depth: (node.depth + 1).min(2),
                        });
                        ctx.add_edge(&node_id, &acct_id, "links_to", 0.80, "deepen-html");
                        hits += 1;
                    }
                }
                ctx.emit_tool(
                    "deepen-pivot",
                    "done",
                    hits,
                    &format!("Deepened {} -> {} pivot(s)", node.label, hits),
                );
            }
        }
    }

    finish_case(&ctx);
}

fn finish_case(ctx: &InvestigationContext) {
    ctx.emit_stage("completed", "Investigation complete", 100);
    if let Ok(snap) = ctx.db.get_case_snapshot(&ctx.case_id) {
        let _ = ctx.app.emit(
            EVENT_NAME,
            StreamEvent::Completed {
                case_id: ctx.case_id.clone(),
                summary: snap.stats,
            },
        );
    }
}

fn shares_name_token(candidate: &str, full_name: &str) -> bool {
    let cand_lower = candidate.to_lowercase();
    full_name
        .split_whitespace()
        .map(|w| w.trim().to_lowercase())
        .filter(|w| w.len() >= 3)
        .any(|tok| cand_lower.contains(&tok))
}

fn is_free_mail_provider(domain: &str) -> bool {
    matches!(
        domain,
        "gmail.com"
            | "googlemail.com"
            | "outlook.com"
            | "hotmail.com"
            | "live.com"
            | "yahoo.com"
            | "icloud.com"
            | "me.com"
            | "proton.me"
            | "protonmail.com"
            | "fastmail.com"
            | "aol.com"
            | "gmx.com"
            | "yandex.com"
            | "tutanota.com"
    )
}
