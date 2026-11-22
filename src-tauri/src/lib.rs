pub mod commands;
pub mod db;
pub mod engine;
pub mod export;
pub mod models;

use commands::AppState;
use db::Database;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = Database::default_db_path();
    let database = Database::open(&db_path).expect("Failed to initialize TAUF SQLite database");

    tauri::Builder::default()
        .manage(AppState {
            db: Arc::new(database),
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_investigation,
            commands::deepen_node,
            commands::set_node_status,
            commands::get_case_snapshot,
            commands::list_cases,
            commands::purge_case,
            commands::purge_all_cases,
            commands::get_environment_status,
            commands::save_auth_config,
            commands::get_auth_config,
            commands::export_dossier_html,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TAUF application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{
        dns_gravatar, doc_meta, git_raw, hkp, html_extractor, local_corpus, permutator,
        tor_darkweb, wmn,
    };
    use crate::models::{
        normalize_node_id, AuthConfig, Finding, GraphEdge, GraphNode, InvestigationInput,
        StreamEvent,
    };
    use base64::Engine as _;
    use std::collections::HashMap;

    #[test]
    fn test_sqlite_dedup_consensus_and_purge() {
        let db = Database::open_in_memory().unwrap();
        let input = InvestigationInput {
            full_name: "Jane Doe".to_string(),
            org: Some("Acme Corp".to_string()),
            email: None,
            handle: None,
            phone: None,
            domain: Some("acme.example".to_string()),
            passive_only: true,
            enable_tor: false,
            strict_anonymity: None,
            max_depth: 2,
            depth_level: 2,
        };
        db.create_case("case-1", &input, "2026-01-01T00:00:00Z")
            .unwrap();

        let node_id = normalize_node_id("email", "Jane@Acme.Example");
        assert_eq!(node_id, "email:jane@acme.example");

        let n1 = GraphNode {
            id: node_id.clone(),
            kind: "email".to_string(),
            label: "jane@acme.example".to_string(),
            sublabel: Some("OpenPGP HKP".to_string()),
            layer: "anchor".to_string(),
            confidence: 0.72,
            status: "unverified".to_string(),
            sources: vec!["openpgp-hkp".to_string()],
            metadata: HashMap::new(),
            url: None,
            depth: 1,
        };
        let n2 = GraphNode {
            sources: vec!["git-raw-gpg".to_string()],
            confidence: 0.75,
            ..n1.clone()
        };

        db.upsert_node("case-1", &n1).unwrap();
        let merged = db.upsert_node("case-1", &n2).unwrap();
        assert_eq!(merged.sources.len(), 2);
        assert!(merged.confidence > 0.75);

        let f1 = Finding {
            id: "finding:email:jane".to_string(),
            node_id: node_id.clone(),
            title: "Email Anchor".to_string(),
            category: "anchor".to_string(),
            severity: "medium".to_string(),
            confidence: 0.70,
            consensus_count: 1,
            sources: vec!["openpgp-hkp".to_string()],
            summary: "Found in HKP".to_string(),
            pivot_trail: vec![
                "Name: Jane Doe".to_string(),
                "HKP -> jane@acme.example".to_string(),
            ],
            url: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            sensitive_fields: vec!["jane@acme.example".to_string()],
        };
        let f2 = Finding {
            sources: vec!["git-raw-gpg".to_string()],
            ..f1.clone()
        };
        db.upsert_finding("case-1", &f1).unwrap();
        let fm = db.upsert_finding("case-1", &f2).unwrap();
        assert_eq!(fm.consensus_count, 2);
        assert!(fm.confidence > 0.70);

        let e = GraphEdge {
            id: "e1".to_string(),
            source: "person:jane_doe".to_string(),
            target: node_id.clone(),
            relation: "owns_email".to_string(),
            confidence: 0.80,
            sources: vec!["openpgp-hkp".to_string()],
        };
        db.upsert_edge("case-1", &e).unwrap();

        let snap = db.set_node_status("case-1", &node_id, "confirmed").unwrap();
        assert_eq!(snap.stats.confirmed_anchors, 1);
        assert_eq!(snap.stats.verified_findings, 1);

        let html_redacted = export::render_dossier_html(&snap, true);
        assert!(!html_redacted.contains("jane@acme.example"));
        assert!(html_redacted.contains("REDACTED BRIEF"));

        db.purge_case("case-1").unwrap();
        assert!(db.list_cases().unwrap().is_empty());
    }

    #[test]
    fn test_auth_config_zero_api_keys() {
        let db = Database::open_in_memory().unwrap();
        let cfg = AuthConfig {
            tor_socks_url: Some("socks5h://127.0.0.1:9050".to_string()),
            proxy_url: None,
            local_corpus_dir: Some("C:\\corpus".to_string()),
            custom_onion_seeds: vec![
                "http://exampleonionaddress.onion/search?q={query}".to_string()
            ],
        };
        db.save_auth_config(&cfg).unwrap();
        let loaded = db.get_auth_config().unwrap();
        assert_eq!(
            loaded.tor_socks_url.as_deref(),
            Some("socks5h://127.0.0.1:9050")
        );
        assert_eq!(loaded.local_corpus_dir.as_deref(), Some("C:\\corpus"));
        assert_eq!(loaded.custom_onion_seeds.len(), 1);
    }

    #[test]
    fn test_permutator_and_hkp_parser() {
        let handles = permutator::generate_handles("Ada Lovelace", Some("@adalove"));
        assert_eq!(handles[0].handle, "adalove");
        assert!(handles.iter().any(|h| h.handle == "alovelace"));
        assert!(handles.iter().any(|h| h.handle == "adalovelace"));

        let emails = permutator::generate_corporate_emails("Ada Lovelace", "analytical.org", None);
        assert!(emails
            .iter()
            .any(|e| e.email == "ada.lovelace@analytical.org"));

        let hkp_sample = "info:1:1\npub:ABCD1234EFGH5678:1:4096:1700000000::\nuid:Ada%20Lovelace%20%3Cada%40analytical.org%3E:1700000000::\n";
        let recs = hkp::parse_hkp_mr(hkp_sample);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].uids[0].email.as_deref(), Some("ada@analytical.org"));
    }

    #[test]
    fn test_raw_pgp_tag13_uid_extraction() {
        // Construct a minimal RFC 4880 new-format Packet Tag 13 (User ID)
        let uid = b"Grace Hopper <grace@navy.mil>";
        let mut pkt = vec![0xC0 | 13, uid.len() as u8];
        pkt.extend_from_slice(uid);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&pkt);
        let armor = format!(
            "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n{}\n=ABCD\n-----END PGP PUBLIC KEY BLOCK-----\n",
            b64
        );
        let (uids, emails) = git_raw::extract_uids_from_pgp_armor(&armor);
        assert_eq!(uids, vec!["Grace Hopper <grace@navy.mil>"]);
        assert_eq!(emails, vec!["grace@navy.mil"]);
    }

    #[test]
    fn test_html_extractor_and_local_corpus_redaction() {
        let html = r#"
        <html><head>
        <meta property="og:title" content="Grace Hopper" />
        <script type="application/ld+json">{"@type":"Person","email":"mailto:grace@compiler.org","worksFor":{"name":"COBOL Labs"},"sameAs":["https://github.com/ghopper"]}</script>
        </head><body><a rel="me" href="https://keybase.io/ghopper">Keybase</a></body></html>
        "#;
        let parsed = html_extractor::parse_profile_html(html);
        assert_eq!(parsed.title.as_deref(), Some("Grace Hopper"));
        assert!(parsed.emails.contains(&"grace@compiler.org".to_string()));
        assert!(parsed.orgs.contains(&"COBOL Labs".to_string()));
        assert!(parsed
            .cross_handles
            .iter()
            .any(|(p, h)| p == "GitHub" && h == "ghopper"));

        let (redacted, is_cred) = local_corpus::redact_corpus_line(
            "grace@compiler.org:SuperSecret123!",
            "grace@compiler.org",
        );
        assert!(is_cred);
        assert!(!redacted.contains("SuperSecret123!"));
        assert!(redacted.contains("REDACTED_CREDENTIAL_FIELD"));
    }

    #[test]
    fn test_tor_socks5h_and_wmn_zero_api_audit() {
        assert_eq!(
            tor_darkweb::ensure_socks5h("socks5://127.0.0.1:9050"),
            "socks5h://127.0.0.1:9050"
        );
        let sites = wmn::load_curated_sites();
        assert!(sites.len() >= 75);
        for site in &sites {
            assert!(
                !site.uri_check.contains("/api/") && !site.uri_check.contains("api."),
                "Found forbidden external API URL in wmn_curated.json: {}",
                site.uri_check
            );
        }

        let dns_pkt = dns_gravatar::build_dns_query("example.com", 15);
        assert!(dns_pkt.len() > 12);

        let ev = StreamEvent::Stage {
            case_id: "c1".to_string(),
            stage: "stage0".to_string(),
            message: "ok".to_string(),
            progress: 10,
            eta_seconds: Some(45),
            elapsed_seconds: Some(5),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"kind\":\"stage\""));
    }

    #[test]
    fn test_pdf_doc_metadata_extraction() {
        // 1. Literal /Author + internal Windows path inside /Title
        let pdf_lit = b"%PDF-1.7\n1 0 obj\n<< /Author (Jane Doe) /Creator (Microsoft Word) /Title (C:\\Users\\jdoe_admin\\Desktop\\Board_Deck.docx) >>\nendobj";
        let m1 = doc_meta::parse_pdf_metadata("https://acme.example/deck.pdf", pdf_lit);
        assert_eq!(m1.author.as_deref(), Some("Jane Doe"));
        assert_eq!(m1.creator.as_deref(), Some("Microsoft Word"));
        assert!(m1.internal_usernames.contains(&"jdoe_admin".to_string()));

        // 2. UTF-16BE hex string /Author <FEFF...> ("Ada")
        let pdf_hex = b"%PDF-1.6\n<< /Author <FEFF004100640061> /Producer (LibreOffice) >>";
        let m2 = doc_meta::parse_pdf_metadata("https://acme.example/brief.pdf", pdf_hex);
        assert_eq!(m2.author.as_deref(), Some("Ada"));
        assert_eq!(m2.producer.as_deref(), Some("LibreOffice"));

        // 3. Uncompressed XMP <dc:creator> + embedded email
        let pdf_xmp = b"%PDF-1.7\n<x:xmpmeta><rdf:RDF><rdf:Description><dc:creator><rdf:Seq><rdf:li>Grace Hopper</rdf:li></rdf:Seq></dc:creator><xmp:CreatorTool>Keynote 14</xmp:CreatorTool><dc:description>Contact grace.hopper@acme.example</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>";
        let m3 = doc_meta::parse_pdf_metadata("https://acme.example/keynote.pdf", pdf_xmp);
        assert_eq!(m3.author.as_deref(), Some("Grace Hopper"));
        assert_eq!(m3.creator.as_deref(), Some("Keynote 14"));
        assert!(m3.emails.contains(&"grace.hopper@acme.example".to_string()));
    }
}
