export type NodeLayer = "seed" | "anchor" | "surface" | "deep" | "darkweb";

export type NodeStatus = "confirmed" | "dismissed" | "quarantined" | "unverified";

export type MatchTier = "verified" | "probable" | "collision";

export type DepthLevel = 1 | 2 | 3 | 4;

export type FindingCategory =
  | "anchor"
  | "account"
  | "corporate"
  | "code"
  | "service"
  | "record"
  | "darkweb"
  | "breach";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type ToolRunState = "queued" | "running" | "done" | "skipped" | "error";

export interface InvestigationInput {
  full_name: string;
  org: string | null;
  email: string | null;
  handle: string | null;
  phone: string | null;
  domain: string | null;
  passive_only: boolean;
  enable_tor: boolean;
  strict_anonymity?: boolean;
  depth_level?: DepthLevel;
  max_depth: number;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  sublabel: string | null;
  layer: NodeLayer;
  confidence: number;
  status: NodeStatus;
  sources: string[];
  metadata: Record<string, string>;
  url: string | null;
  depth: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  confidence: number;
  sources: string[];
}

export interface Finding {
  id: string;
  node_id: string;
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: number;
  consensus_count: number;
  sources: string[];
  summary: string;
  pivot_trail: string[];
  url: string | null;
  timestamp: string;
  sensitive_fields: string[];
}

export interface ToolRunStatus {
  tool: string;
  state: ToolRunState;
  hits: number;
  detail: string;
}

export interface CaseStats {
  total_nodes: number;
  confirmed_anchors: number;
  verified_findings: number;
  low_conf_findings: number;
  darkweb_hits: number;
  breach_hits: number;
  tools_completed: number;
  tools_total: number;
}

export interface CaseSnapshot {
  case_id: string;
  input: InvestigationInput;
  created_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  findings: Finding[];
  tool_runs: ToolRunStatus[];
  stats: CaseStats;
}

export interface CaseSummary {
  case_id: string;
  full_name: string;
  created_at: string;
  node_count: number;
  finding_count: number;
  darkweb_count: number;
}

export interface SidecarToolInfo {
  name: string;
  installed: boolean;
  category: string;
  mode: string;
  install_hint: string;
}

export interface EnvStatus {
  tor_socks_available: boolean;
  tor_endpoint: string | null;
  tor_exit_ip?: string | null;
  anonymity_active?: boolean;
  anonymity_mode?: string;
  python_path: string | null;
  sidecar_tools: SidecarToolInfo[];
}

/**
 * Sovereign local laptop configuration — zero external API keys or SaaS tokens.
 */
export interface AuthConfig {
  tor_socks_url: string | null;
  proxy_url: string | null;
  local_corpus_dir: string | null;
  custom_onion_seeds: string[];
}

export type StreamEvent =
  | {
      kind: "stage";
      case_id: string;
      stage: string;
      message: string;
      progress: number;
      eta_seconds?: number | null;
      elapsed_seconds?: number | null;
      depth_level?: number | null;
    }
  | {
      kind: "node";
      case_id: string;
      node: GraphNode;
    }
  | {
      kind: "edge";
      case_id: string;
      edge: GraphEdge;
    }
  | {
      kind: "finding";
      case_id: string;
      finding: Finding;
    }
  | {
      kind: "tool_status";
      case_id: string;
      tool: string;
      state: ToolRunState;
      hits: number;
      detail: string;
    }
  | {
      kind: "completed";
      case_id: string;
      summary: CaseStats;
    };

export type IntelTab = "contacts" | "accounts" | "records" | "darkweb";
