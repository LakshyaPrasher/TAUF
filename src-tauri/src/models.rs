use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn default_passive_only() -> bool {
    true
}

fn default_max_depth() -> u8 {
    2
}

fn default_depth_level() -> u8 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestigationInput {
    pub full_name: String,
    #[serde(default)]
    pub org: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default = "default_passive_only")]
    pub passive_only: bool,
    #[serde(default)]
    pub enable_tor: bool,
    #[serde(default)]
    pub strict_anonymity: Option<bool>,
    #[serde(default = "default_max_depth")]
    pub max_depth: u8,
    #[serde(default = "default_depth_level")]
    pub depth_level: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub sublabel: Option<String>,
    pub layer: String,
    pub confidence: f32,
    pub status: String,
    pub sources: Vec<String>,
    pub metadata: HashMap<String, String>,
    pub url: Option<String>,
    pub depth: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub relation: String,
    pub confidence: f32,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub node_id: String,
    pub title: String,
    pub category: String,
    pub severity: String,
    pub confidence: f32,
    pub consensus_count: u32,
    pub sources: Vec<String>,
    pub summary: String,
    pub pivot_trail: Vec<String>,
    pub url: Option<String>,
    pub timestamp: String,
    pub sensitive_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseSnapshot {
    pub case_id: String,
    pub input: InvestigationInput,
    pub created_at: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub findings: Vec<Finding>,
    pub tool_runs: Vec<ToolRunStatus>,
    pub stats: CaseStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseSummary {
    pub case_id: String,
    pub full_name: String,
    pub created_at: String,
    pub node_count: usize,
    pub finding_count: usize,
    pub darkweb_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CaseStats {
    pub total_nodes: usize,
    pub confirmed_anchors: usize,
    pub verified_findings: usize,
    pub low_conf_findings: usize,
    pub darkweb_hits: usize,
    pub breach_hits: usize,
    pub tools_completed: usize,
    pub tools_total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRunStatus {
    pub tool: String,
    pub state: String,
    pub hits: usize,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvStatus {
    pub tor_socks_available: bool,
    pub tor_endpoint: Option<String>,
    #[serde(default)]
    pub tor_exit_ip: Option<String>,
    #[serde(default)]
    pub anonymity_active: bool,
    #[serde(default)]
    pub anonymity_mode: String,
    pub python_path: Option<String>,
    pub sidecar_tools: Vec<SidecarToolInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarToolInfo {
    pub name: String,
    pub installed: bool,
    pub category: String,
    pub mode: String,
    pub install_hint: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthConfig {
    #[serde(default)]
    pub tor_socks_url: Option<String>,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub local_corpus_dir: Option<String>,
    #[serde(default)]
    pub custom_onion_seeds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    Stage {
        case_id: String,
        stage: String,
        message: String,
        progress: u8,
        #[serde(default)]
        eta_seconds: Option<u32>,
        #[serde(default)]
        elapsed_seconds: Option<u32>,
    },
    Node {
        case_id: String,
        node: GraphNode,
    },
    Edge {
        case_id: String,
        edge: GraphEdge,
    },
    Finding {
        case_id: String,
        finding: Finding,
    },
    ToolStatus {
        case_id: String,
        tool: String,
        state: String,
        hits: usize,
        detail: String,
    },
    Completed {
        case_id: String,
        summary: CaseStats,
    },
}

/// Normalize a node identity key for deterministic deduplication across stages and tools.
pub fn normalize_node_id(kind: &str, value: &str) -> String {
    let clean_kind = kind.trim().to_lowercase();
    let clean_val: String = value
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | '+' | ':') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let collapsed = clean_val
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    format!("{}:{}", clean_kind, collapsed)
}

/// Boost confidence smoothly when multiple independent sources confirm the same entity/finding.
pub fn merge_confidence(existing: f32, incoming: f32, source_count: usize) -> f32 {
    let base = existing.max(incoming);
    let bonus = ((source_count.saturating_sub(1)) as f32 * 0.08).min(0.24);
    (base + bonus).clamp(0.05, 0.99)
}

pub fn compute_stats(
    nodes: &[GraphNode],
    findings: &[Finding],
    tool_runs: &[ToolRunStatus],
) -> CaseStats {
    let active_nodes: Vec<&GraphNode> = nodes.iter().filter(|n| n.status != "dismissed").collect();
    let dismissed_ids: std::collections::HashSet<&str> = nodes
        .iter()
        .filter(|n| n.status == "dismissed")
        .map(|n| n.id.as_str())
        .collect();

    let active_findings: Vec<&Finding> = findings
        .iter()
        .filter(|f| !dismissed_ids.contains(f.node_id.as_str()))
        .collect();

    let confirmed_anchors = active_nodes
        .iter()
        .filter(|n| n.status == "confirmed" || (n.layer == "anchor" && n.confidence >= 0.72))
        .count();

    let verified_findings = active_findings
        .iter()
        .filter(|f| f.consensus_count >= 2 || f.confidence >= 0.70)
        .count();

    let low_conf_findings = active_findings.len().saturating_sub(verified_findings);

    let darkweb_hits = active_findings
        .iter()
        .filter(|f| f.category == "darkweb")
        .count();

    let breach_hits = active_findings
        .iter()
        .filter(|f| f.category == "breach")
        .count();

    let tools_completed = tool_runs
        .iter()
        .filter(|t| matches!(t.state.as_str(), "done" | "skipped" | "error"))
        .count();

    CaseStats {
        total_nodes: active_nodes.len(),
        confirmed_anchors,
        verified_findings,
        low_conf_findings,
        darkweb_hits,
        breach_hits,
        tools_completed,
        tools_total: tool_runs.len(),
    }
}
