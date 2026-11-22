use crate::db::Database;
use crate::engine::{self, sidecar, tor_darkweb};
use crate::export;
use crate::models::{AuthConfig, CaseSnapshot, CaseSummary, EnvStatus, InvestigationInput};
use chrono::Utc;
use std::sync::Arc;
use tauri::{AppHandle, State};
use uuid::Uuid;

pub struct AppState {
    pub db: Arc<Database>,
}

#[tauri::command]
pub async fn start_investigation(
    app: AppHandle,
    state: State<'_, AppState>,
    input: InvestigationInput,
) -> Result<String, String> {
    if input.full_name.trim().is_empty() {
        return Err("Full Name is required to start an investigation.".to_string());
    }

    let case_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    state.db.create_case(&case_id, &input, &created_at)?;
    let auth = state.db.get_auth_config().unwrap_or_default();

    let db = state.db.clone();
    let cid = case_id.clone();
    tokio::spawn(async move {
        engine::run_investigation(app, db, cid, input, auth).await;
    });

    Ok(case_id)
}

#[tauri::command]
pub async fn deepen_node(
    app: AppHandle,
    state: State<'_, AppState>,
    case_id: String,
    node_id: String,
) -> Result<(), String> {
    let exists = state.db.get_node(&case_id, &node_id)?;
    if exists.is_none() {
        return Err(format!(
            "Node '{}' not found in case '{}'",
            node_id, case_id
        ));
    }

    let auth = state.db.get_auth_config().unwrap_or_default();
    let db = state.db.clone();
    tokio::spawn(async move {
        engine::run_deepen_node(app, db, case_id, node_id, auth).await;
    });

    Ok(())
}

#[tauri::command]
pub fn set_node_status(
    state: State<'_, AppState>,
    case_id: String,
    node_id: String,
    status: String,
) -> Result<CaseSnapshot, String> {
    state.db.set_node_status(&case_id, &node_id, &status)
}

#[tauri::command]
pub fn get_case_snapshot(
    state: State<'_, AppState>,
    case_id: String,
) -> Result<CaseSnapshot, String> {
    state.db.get_case_snapshot(&case_id)
}

#[tauri::command]
pub fn list_cases(state: State<'_, AppState>) -> Result<Vec<CaseSummary>, String> {
    state.db.list_cases()
}

#[tauri::command]
pub fn purge_case(state: State<'_, AppState>, case_id: String) -> Result<(), String> {
    state.db.purge_case(&case_id)
}

#[tauri::command]
pub fn purge_all_cases(state: State<'_, AppState>) -> Result<(), String> {
    state.db.purge_all_cases()
}

#[tauri::command]
pub async fn get_environment_status(state: State<'_, AppState>) -> Result<EnvStatus, String> {
    let auth = state.db.get_auth_config().unwrap_or_default();
    let tor_url = auth.tor_socks_url.clone();
    let proxy_url = auth.proxy_url.clone();

    tokio::task::spawn_blocking(move || {
        let tor = tor_darkweb::detect_local_tor(tor_url.as_deref());
        let (python_path, sidecar_tools) = sidecar::probe_sidecar_tools();
        let anonymity_active = tor.available
            || proxy_url
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
        let anonymity_mode = if tor.available {
            "tor_socks5h".to_string()
        } else if proxy_url
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            "custom_proxy".to_string()
        } else {
            "direct".to_string()
        };
        EnvStatus {
            tor_socks_available: tor.available,
            tor_endpoint: tor.endpoint,
            tor_exit_ip: None,
            anonymity_active,
            anonymity_mode,
            python_path,
            sidecar_tools,
        }
    })
    .await
    .map_err(|e| format!("Failed to probe environment: {}", e))
}

#[tauri::command]
pub fn save_auth_config(state: State<'_, AppState>, config: AuthConfig) -> Result<(), String> {
    state.db.save_auth_config(&config)
}

#[tauri::command]
pub fn get_auth_config(state: State<'_, AppState>) -> Result<AuthConfig, String> {
    state.db.get_auth_config()
}

#[tauri::command]
pub fn export_dossier_html(
    state: State<'_, AppState>,
    case_id: String,
    redact: bool,
) -> Result<String, String> {
    let snapshot = state.db.get_case_snapshot(&case_id)?;
    Ok(export::render_dossier_html(&snapshot, redact))
}
