use crate::models::{
    compute_stats, merge_confidence, AuthConfig, CaseSnapshot, CaseSummary, Finding, GraphEdge,
    GraphNode, InvestigationInput, ToolRunStatus,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create DB directory: {}", e))?;
        }
        let conn =
            Connection::open(path).map_err(|e| format!("Failed to open SQLite database: {}", e))?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_schema()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory SQLite DB: {}", e))?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_schema()?;
        Ok(db)
    }

    pub fn default_db_path() -> PathBuf {
        let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("TAUF").join("tauf.sqlite")
    }

    fn init_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS cases (
                case_id TEXT PRIMARY KEY,
                full_name TEXT NOT NULL,
                input_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS nodes (
                case_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                label TEXT NOT NULL,
                sublabel TEXT,
                layer TEXT NOT NULL,
                confidence REAL NOT NULL,
                status TEXT NOT NULL,
                sources_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                url TEXT,
                depth INTEGER NOT NULL,
                PRIMARY KEY (case_id, node_id),
                FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS edges (
                case_id TEXT NOT NULL,
                edge_id TEXT NOT NULL,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                relation TEXT NOT NULL,
                confidence REAL NOT NULL,
                sources_json TEXT NOT NULL,
                PRIMARY KEY (case_id, edge_id),
                FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS findings (
                case_id TEXT NOT NULL,
                finding_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                title TEXT NOT NULL,
                category TEXT NOT NULL,
                severity TEXT NOT NULL,
                confidence REAL NOT NULL,
                consensus_count INTEGER NOT NULL,
                sources_json TEXT NOT NULL,
                summary TEXT NOT NULL,
                pivot_trail_json TEXT NOT NULL,
                url TEXT,
                timestamp TEXT NOT NULL,
                sensitive_fields_json TEXT NOT NULL,
                PRIMARY KEY (case_id, finding_id),
                FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tool_runs (
                case_id TEXT NOT NULL,
                tool TEXT NOT NULL,
                state TEXT NOT NULL,
                hits INTEGER NOT NULL,
                detail TEXT NOT NULL,
                PRIMARY KEY (case_id, tool),
                FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS auth_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                config_json TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| format!("Failed to initialize SQLite schema: {}", e))?;
        Ok(())
    }

    pub fn create_case(
        &self,
        case_id: &str,
        input: &InvestigationInput,
        created_at: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let input_json = serde_json::to_string(input).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO cases (case_id, full_name, input_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![case_id, input.full_name, input_json, created_at],
        )
        .map_err(|e| format!("Failed to create case: {}", e))?;
        Ok(())
    }

    /// Upsert a node with deterministic deduplication, source merging, metadata merging, and consensus boost.
    pub fn upsert_node(&self, case_id: &str, incoming: &GraphNode) -> Result<GraphNode, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing: Option<(
            String,
            Option<String>,
            String,
            f32,
            String,
            String,
            String,
            Option<String>,
            u8,
        )> = conn
            .query_row(
                "SELECT label, sublabel, layer, confidence, status, sources_json, metadata_json, url, depth
                 FROM nodes WHERE case_id = ?1 AND node_id = ?2",
                params![case_id, incoming.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get::<_, f64>(3)? as f32,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get::<_, i64>(8)? as u8,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let merged = if let Some((
            ex_label,
            ex_sublabel,
            ex_layer,
            ex_conf,
            ex_status,
            ex_sources_json,
            ex_meta_json,
            ex_url,
            ex_depth,
        )) = existing
        {
            let mut sources: Vec<String> =
                serde_json::from_str(&ex_sources_json).unwrap_or_default();
            for s in &incoming.sources {
                if !sources.contains(s) {
                    sources.push(s.clone());
                }
            }
            let mut metadata: HashMap<String, String> =
                serde_json::from_str(&ex_meta_json).unwrap_or_default();
            for (k, v) in &incoming.metadata {
                if !v.is_empty() {
                    metadata.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
            let confidence = merge_confidence(ex_conf, incoming.confidence, sources.len());
            // Keep confirmed or dismissed human decisions sticky; otherwise upgrade if incoming is confirmed.
            let status = if ex_status == "confirmed" || ex_status == "dismissed" {
                ex_status
            } else if incoming.status == "confirmed" {
                "confirmed".to_string()
            } else {
                ex_status
            };
            let layer = if ex_layer == "seed" || ex_layer == "darkweb" {
                ex_layer
            } else if incoming.layer == "darkweb" || incoming.layer == "anchor" {
                incoming.layer.clone()
            } else {
                ex_layer
            };
            GraphNode {
                id: incoming.id.clone(),
                kind: incoming.kind.clone(),
                label: if ex_label.len() >= incoming.label.len() {
                    ex_label
                } else {
                    incoming.label.clone()
                },
                sublabel: ex_sublabel.or_else(|| incoming.sublabel.clone()),
                layer,
                confidence,
                status,
                sources,
                metadata,
                url: ex_url.or_else(|| incoming.url.clone()),
                depth: ex_depth.min(incoming.depth),
            }
        } else {
            incoming.clone()
        };

        let sources_json = serde_json::to_string(&merged.sources).map_err(|e| e.to_string())?;
        let metadata_json = serde_json::to_string(&merged.metadata).map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO nodes (case_id, node_id, kind, label, sublabel, layer, confidence, status, sources_json, metadata_json, url, depth)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(case_id, node_id) DO UPDATE SET
               label = excluded.label,
               sublabel = excluded.sublabel,
               layer = excluded.layer,
               confidence = excluded.confidence,
               status = excluded.status,
               sources_json = excluded.sources_json,
               metadata_json = excluded.metadata_json,
               url = excluded.url,
               depth = excluded.depth",
            params![
                case_id,
                merged.id,
                merged.kind,
                merged.label,
                merged.sublabel,
                merged.layer,
                merged.confidence as f64,
                merged.status,
                sources_json,
                metadata_json,
                merged.url,
                merged.depth as i64
            ],
        )
        .map_err(|e| format!("Failed to upsert node: {}", e))?;

        Ok(merged)
    }

    pub fn upsert_edge(&self, case_id: &str, incoming: &GraphEdge) -> Result<GraphEdge, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing: Option<(f32, String)> = conn
            .query_row(
                "SELECT confidence, sources_json FROM edges WHERE case_id = ?1 AND edge_id = ?2",
                params![case_id, incoming.id],
                |row| Ok((row.get::<_, f64>(0)? as f32, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let merged = if let Some((ex_conf, ex_sources_json)) = existing {
            let mut sources: Vec<String> =
                serde_json::from_str(&ex_sources_json).unwrap_or_default();
            for s in &incoming.sources {
                if !sources.contains(s) {
                    sources.push(s.clone());
                }
            }
            let confidence = merge_confidence(ex_conf, incoming.confidence, sources.len());
            GraphEdge {
                id: incoming.id.clone(),
                source: incoming.source.clone(),
                target: incoming.target.clone(),
                relation: incoming.relation.clone(),
                confidence,
                sources,
            }
        } else {
            incoming.clone()
        };

        let sources_json = serde_json::to_string(&merged.sources).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO edges (case_id, edge_id, source, target, relation, confidence, sources_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(case_id, edge_id) DO UPDATE SET
               confidence = excluded.confidence,
               sources_json = excluded.sources_json",
            params![
                case_id,
                merged.id,
                merged.source,
                merged.target,
                merged.relation,
                merged.confidence as f64,
                sources_json
            ],
        )
        .map_err(|e| format!("Failed to upsert edge: {}", e))?;

        Ok(merged)
    }

    /// Upsert finding with multi-tool consensus counting and confidence elevation.
    pub fn upsert_finding(&self, case_id: &str, incoming: &Finding) -> Result<Finding, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing: Option<(f32, String, String, String, Option<String>, String)> = conn
            .query_row(
                "SELECT confidence, sources_json, summary, pivot_trail_json, url, sensitive_fields_json
                 FROM findings WHERE case_id = ?1 AND finding_id = ?2",
                params![case_id, incoming.id],
                |row| {
                    Ok((
                        row.get::<_, f64>(0)? as f32,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let merged = if let Some((
            ex_conf,
            ex_sources_json,
            ex_summary,
            ex_trail_json,
            ex_url,
            ex_sens_json,
        )) = existing
        {
            let mut sources: Vec<String> =
                serde_json::from_str(&ex_sources_json).unwrap_or_default();
            for s in &incoming.sources {
                if !sources.contains(s) {
                    sources.push(s.clone());
                }
            }
            let consensus_count = sources.len().max(1) as u32;
            let confidence = merge_confidence(ex_conf, incoming.confidence, sources.len());

            let ex_trail: Vec<String> = serde_json::from_str(&ex_trail_json).unwrap_or_default();
            let pivot_trail = if incoming.pivot_trail.len() > ex_trail.len() {
                incoming.pivot_trail.clone()
            } else {
                ex_trail
            };

            let mut sensitive_fields: Vec<String> =
                serde_json::from_str(&ex_sens_json).unwrap_or_default();
            for sf in &incoming.sensitive_fields {
                if !sensitive_fields.contains(sf) {
                    sensitive_fields.push(sf.clone());
                }
            }

            let summary = if incoming.summary.len() > ex_summary.len() {
                incoming.summary.clone()
            } else {
                ex_summary
            };

            Finding {
                id: incoming.id.clone(),
                node_id: incoming.node_id.clone(),
                title: incoming.title.clone(),
                category: incoming.category.clone(),
                severity: incoming.severity.clone(),
                confidence,
                consensus_count,
                sources,
                summary,
                pivot_trail,
                url: ex_url.or_else(|| incoming.url.clone()),
                timestamp: incoming.timestamp.clone(),
                sensitive_fields,
            }
        } else {
            let mut f = incoming.clone();
            f.consensus_count = f.sources.len().max(1) as u32;
            f
        };

        let sources_json = serde_json::to_string(&merged.sources).map_err(|e| e.to_string())?;
        let trail_json = serde_json::to_string(&merged.pivot_trail).map_err(|e| e.to_string())?;
        let sens_json =
            serde_json::to_string(&merged.sensitive_fields).map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO findings (case_id, finding_id, node_id, title, category, severity, confidence, consensus_count, sources_json, summary, pivot_trail_json, url, timestamp, sensitive_fields_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(case_id, finding_id) DO UPDATE SET
               confidence = excluded.confidence,
               consensus_count = excluded.consensus_count,
               sources_json = excluded.sources_json,
               summary = excluded.summary,
               pivot_trail_json = excluded.pivot_trail_json,
               url = excluded.url,
               sensitive_fields_json = excluded.sensitive_fields_json",
            params![
                case_id,
                merged.id,
                merged.node_id,
                merged.title,
                merged.category,
                merged.severity,
                merged.confidence as f64,
                merged.consensus_count as i64,
                sources_json,
                merged.summary,
                trail_json,
                merged.url,
                merged.timestamp,
                sens_json
            ],
        )
        .map_err(|e| format!("Failed to upsert finding: {}", e))?;

        Ok(merged)
    }

    pub fn upsert_tool_run(&self, case_id: &str, status: &ToolRunStatus) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO tool_runs (case_id, tool, state, hits, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(case_id, tool) DO UPDATE SET
               state = excluded.state,
               hits = excluded.hits,
               detail = excluded.detail",
            params![
                case_id,
                status.tool,
                status.state,
                status.hits as i64,
                status.detail
            ],
        )
        .map_err(|e| format!("Failed to upsert tool run: {}", e))?;
        Ok(())
    }

    pub fn set_node_status(
        &self,
        case_id: &str,
        node_id: &str,
        status: &str,
    ) -> Result<CaseSnapshot, String> {
        if !matches!(status, "confirmed" | "dismissed" | "unverified") {
            return Err(format!(
                "Invalid status '{}'. Expected 'confirmed', 'dismissed', or 'unverified'.",
                status
            ));
        }
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let updated = conn
                .execute(
                    "UPDATE nodes SET status = ?1 WHERE case_id = ?2 AND node_id = ?3",
                    params![status, case_id, node_id],
                )
                .map_err(|e| format!("Failed to update node status: {}", e))?;
            if updated == 0 {
                return Err(format!(
                    "Node '{}' not found in case '{}'",
                    node_id, case_id
                ));
            }
        }
        self.get_case_snapshot(case_id)
    }

    pub fn get_node(&self, case_id: &str, node_id: &str) -> Result<Option<GraphNode>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT node_id, kind, label, sublabel, layer, confidence, status, sources_json, metadata_json, url, depth
             FROM nodes WHERE case_id = ?1 AND node_id = ?2",
            params![case_id, node_id],
            |row| {
                let sources_json: String = row.get(7)?;
                let meta_json: String = row.get(8)?;
                Ok(GraphNode {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    label: row.get(2)?,
                    sublabel: row.get(3)?,
                    layer: row.get(4)?,
                    confidence: row.get::<_, f64>(5)? as f32,
                    status: row.get(6)?,
                    sources: serde_json::from_str(&sources_json).unwrap_or_default(),
                    metadata: serde_json::from_str(&meta_json).unwrap_or_default(),
                    url: row.get(9)?,
                    depth: row.get::<_, i64>(10)? as u8,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn get_case_snapshot(&self, case_id: &str) -> Result<CaseSnapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let (input_json, created_at): (String, String) = conn
            .query_row(
                "SELECT input_json, created_at FROM cases WHERE case_id = ?1",
                params![case_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Case '{}' not found", case_id))?;

        let input: InvestigationInput =
            serde_json::from_str(&input_json).map_err(|e| e.to_string())?;

        let mut node_stmt = conn
            .prepare(
                "SELECT node_id, kind, label, sublabel, layer, confidence, status, sources_json, metadata_json, url, depth
                 FROM nodes WHERE case_id = ?1 ORDER BY depth ASC, confidence DESC",
            )
            .map_err(|e| e.to_string())?;
        let nodes: Vec<GraphNode> = node_stmt
            .query_map(params![case_id], |row| {
                let sources_json: String = row.get(7)?;
                let meta_json: String = row.get(8)?;
                Ok(GraphNode {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    label: row.get(2)?,
                    sublabel: row.get(3)?,
                    layer: row.get(4)?,
                    confidence: row.get::<_, f64>(5)? as f32,
                    status: row.get(6)?,
                    sources: serde_json::from_str(&sources_json).unwrap_or_default(),
                    metadata: serde_json::from_str(&meta_json).unwrap_or_default(),
                    url: row.get(9)?,
                    depth: row.get::<_, i64>(10)? as u8,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let mut edge_stmt = conn
            .prepare(
                "SELECT edge_id, source, target, relation, confidence, sources_json
                 FROM edges WHERE case_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let edges: Vec<GraphEdge> = edge_stmt
            .query_map(params![case_id], |row| {
                let sources_json: String = row.get(5)?;
                Ok(GraphEdge {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    target: row.get(2)?,
                    relation: row.get(3)?,
                    confidence: row.get::<_, f64>(4)? as f32,
                    sources: serde_json::from_str(&sources_json).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let mut finding_stmt = conn
            .prepare(
                "SELECT finding_id, node_id, title, category, severity, confidence, consensus_count, sources_json, summary, pivot_trail_json, url, timestamp, sensitive_fields_json
                 FROM findings WHERE case_id = ?1 ORDER BY consensus_count DESC, confidence DESC",
            )
            .map_err(|e| e.to_string())?;
        let findings: Vec<Finding> = finding_stmt
            .query_map(params![case_id], |row| {
                let sources_json: String = row.get(7)?;
                let trail_json: String = row.get(9)?;
                let sens_json: String = row.get(12)?;
                Ok(Finding {
                    id: row.get(0)?,
                    node_id: row.get(1)?,
                    title: row.get(2)?,
                    category: row.get(3)?,
                    severity: row.get(4)?,
                    confidence: row.get::<_, f64>(5)? as f32,
                    consensus_count: row.get::<_, i64>(6)? as u32,
                    sources: serde_json::from_str(&sources_json).unwrap_or_default(),
                    summary: row.get(8)?,
                    pivot_trail: serde_json::from_str(&trail_json).unwrap_or_default(),
                    url: row.get(10)?,
                    timestamp: row.get(11)?,
                    sensitive_fields: serde_json::from_str(&sens_json).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let mut tool_stmt = conn
            .prepare("SELECT tool, state, hits, detail FROM tool_runs WHERE case_id = ?1 ORDER BY tool ASC")
            .map_err(|e| e.to_string())?;
        let tool_runs: Vec<ToolRunStatus> = tool_stmt
            .query_map(params![case_id], |row| {
                Ok(ToolRunStatus {
                    tool: row.get(0)?,
                    state: row.get(1)?,
                    hits: row.get::<_, i64>(2)? as usize,
                    detail: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let stats = compute_stats(&nodes, &findings, &tool_runs);

        Ok(CaseSnapshot {
            case_id: case_id.to_string(),
            input,
            created_at,
            nodes,
            edges,
            findings,
            tool_runs,
            stats,
        })
    }

    pub fn list_cases(&self) -> Result<Vec<CaseSummary>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT c.case_id, c.full_name, c.created_at,
                        (SELECT COUNT(*) FROM nodes n WHERE n.case_id = c.case_id AND n.status != 'dismissed') as node_count,
                        (SELECT COUNT(*) FROM findings f WHERE f.case_id = c.case_id) as finding_count,
                        (SELECT COUNT(*) FROM findings f WHERE f.case_id = c.case_id AND (f.category = 'darkweb' OR f.category = 'breach')) as darkweb_count
                 FROM cases c
                 ORDER BY c.created_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(CaseSummary {
                    case_id: row.get(0)?,
                    full_name: row.get(1)?,
                    created_at: row.get(2)?,
                    node_count: row.get::<_, i64>(3)? as usize,
                    finding_count: row.get::<_, i64>(4)? as usize,
                    darkweb_count: row.get::<_, i64>(5)? as usize,
                })
            })
            .map_err(|e| e.to_string())?;

        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn purge_case(&self, case_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM cases WHERE case_id = ?1", params![case_id])
            .map_err(|e| format!("Failed to purge case: {}", e))?;
        Ok(())
    }

    pub fn purge_all_cases(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM cases", [])
            .map_err(|e| format!("Failed to purge all cases: {}", e))?;
        let _ = conn.execute("VACUUM", []);
        Ok(())
    }

    pub fn save_auth_config(&self, config: &AuthConfig) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO auth_config (id, config_json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json",
            params![json],
        )
        .map_err(|e| format!("Failed to save auth config: {}", e))?;
        Ok(())
    }

    pub fn get_auth_config(&self) -> Result<AuthConfig, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let json: Option<String> = conn
            .query_row(
                "SELECT config_json FROM auth_config WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match json {
            Some(j) => serde_json::from_str(&j).map_err(|e| e.to_string()),
            None => Ok(AuthConfig::default()),
        }
    }
}
