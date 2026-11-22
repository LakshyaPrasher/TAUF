use crate::models::{AuthConfig, InvestigationInput, SidecarToolInfo};
use serde::Deserialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

#[derive(Debug, Clone, Deserialize)]
pub struct SidecarEvent {
    pub kind: String, // "tool_status" | "finding" | "node"
    pub tool: String,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub hits: Option<usize>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub entity_kind: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub confidence: Option<f32>,
    #[serde(default)]
    pub match_tier: Option<String>,
    #[serde(default)]
    pub match_reason: Option<String>,
    #[serde(default)]
    pub metadata: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub summary: Option<String>,
}

/// Locate Python 3 interpreter, auto-preferring local `sidecar/.venv/Scripts/python.exe`.
pub fn find_python() -> Option<String> {
    if let Some(script) = find_bridge_script() {
        if let Some(sidecar_dir) = script.parent() {
            let venv_win = sidecar_dir.join(".venv").join("Scripts").join("python.exe");
            if venv_win.exists() {
                return Some(venv_win.to_string_lossy().to_string());
            }
            let venv_unix = sidecar_dir.join(".venv").join("bin").join("python");
            if venv_unix.exists() {
                return Some(venv_unix.to_string_lossy().to_string());
            }
        }
    }
    for candidate in ["python", "python3", "py"] {
        if let Ok(out) = Command::new(candidate).arg("--version").output() {
            if out.status.success() {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

/// Locate `sidecar/bridge.py` relative to workspace root, executable dir, or src-tauri parent.
pub fn find_bridge_script() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("sidecar").join("bridge.py"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("sidecar").join("bridge.py"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("sidecar").join("bridge.py"));
            if let Some(p1) = dir.parent() {
                candidates.push(p1.join("sidecar").join("bridge.py"));
                if let Some(p2) = p1.parent() {
                    candidates.push(p2.join("sidecar").join("bridge.py"));
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

/// Default catalog of sovereign local open-source OSINT tools (zero external paid/free OSINT API tools).
pub fn default_sidecar_catalog() -> Vec<SidecarToolInfo> {
    vec![
        tool_info("maigret", "account", "passive", "pip install maigret"),
        tool_info(
            "sherlock",
            "account",
            "passive",
            "pip install sherlock-project",
        ),
        tool_info(
            "blackbird",
            "account",
            "passive",
            "git clone https://github.com/p1ngul1n0/blackbird",
        ),
        tool_info(
            "social-analyzer",
            "account",
            "passive",
            "pip install social-analyzer",
        ),
        tool_info(
            "socid-extractor",
            "anchor",
            "passive",
            "pip install socid-extractor",
        ),
        tool_info("holehe", "account", "active_adjacent", "pip install holehe"),
        tool_info(
            "ignorant",
            "account",
            "active_adjacent",
            "pip install ignorant",
        ),
        tool_info(
            "crosslinked",
            "corporate",
            "passive",
            "git clone https://github.com/m8sec/CrossLinked",
        ),
        tool_info(
            "instaloader",
            "account",
            "passive",
            "pip install instaloader",
        ),
        tool_info(
            "onionsearch",
            "darkweb",
            "passive",
            "pip install onionsearch",
        ),
        tool_info(
            "torbot",
            "darkweb",
            "passive",
            "git clone https://github.com/DedSecInside/TorBot",
        ),
        tool_info(
            "h8mail",
            "breach",
            "passive",
            "pip install h8mail (local-corpus mode only)",
        ),
    ]
}

fn tool_info(name: &str, category: &str, mode: &str, hint: &str) -> SidecarToolInfo {
    SidecarToolInfo {
        name: name.to_string(),
        installed: false,
        category: category.to_string(),
        mode: mode.to_string(),
        install_hint: hint.to_string(),
    }
}

/// Probe which local OSS sidecar tools are installed on this laptop via `sidecar/bridge.py --probe`.
pub fn probe_sidecar_tools() -> (Option<String>, Vec<SidecarToolInfo>) {
    let python = find_python();
    let Some(py) = python.clone() else {
        return (None, default_sidecar_catalog());
    };
    let Some(script) = find_bridge_script() else {
        return (Some(py), default_sidecar_catalog());
    };

    let output = Command::new(&py)
        .arg(&script)
        .arg("--probe")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            if let Ok(tools) = serde_json::from_slice::<Vec<SidecarToolInfo>>(&out.stdout) {
                if !tools.is_empty() {
                    return (Some(py), tools);
                }
            }
        }
    }

    (Some(py), default_sidecar_catalog())
}

/// Execute `sidecar/bridge.py --run` asynchronously and stream parsed JSONL events via callback.
pub async fn run_sidecar_bridge<F>(
    input: &InvestigationInput,
    auth: &AuthConfig,
    handles: &[String],
    emails: &[String],
    mut on_event: F,
) -> Result<(), String>
where
    F: FnMut(SidecarEvent),
{
    let Some(py) = find_python() else {
        return Ok(());
    };
    let Some(script) = find_bridge_script() else {
        return Ok(());
    };

    let payload = serde_json::json!({
        "full_name": input.full_name,
        "org": input.org,
        "domain": input.domain,
        "phone": input.phone,
        "handles": handles,
        "emails": emails,
        "passive_only": input.passive_only,
        "enable_tor": input.enable_tor,
        "strict_anonymity": input.strict_anonymity.unwrap_or(false),
        "tor_socks_url": auth.tor_socks_url,
        "proxy_url": auth.proxy_url,
        "local_corpus_dir": auth.local_corpus_dir,
    });

    let mut child = TokioCommand::new(&py)
        .arg(&script)
        .arg("--run")
        .arg("--payload")
        .arg(payload.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch sidecar bridge: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(ev) = serde_json::from_str::<SidecarEvent>(trimmed) {
                on_event(ev);
            }
        }
    }

    let _ = child.wait().await;
    Ok(())
}
