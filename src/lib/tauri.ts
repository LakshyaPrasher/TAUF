import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AuthConfig,
  CaseSnapshot,
  CaseSummary,
  EnvStatus,
  InvestigationInput,
  NodeStatus,
  StreamEvent,
} from "../types";

export const BACKEND_OFFLINE_MESSAGE =
  "Local TAUF backend is offline — start via `launch-tauf.vbs` or `npm start`";

const DEFAULT_OFFLINE_CONFIG: AuthConfig = {
  tor_socks_url: "socks5h://127.0.0.1:9050",
  proxy_url: null,
  local_corpus_dir: null,
  custom_onion_seeds: [],
};

function isNativeTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function isLocalBackendRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as Record<string, unknown>).__TAUF_LOCAL__)
  );
}

export function isTauriRuntime(): boolean {
  return isNativeTauri() || isLocalBackendRuntime();
}

async function callBackend<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isNativeTauri()) {
    return invoke<T>(cmd, args);
  }
  if (!isLocalBackendRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }

  let resp: Response;
  try {
    resp = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
  } catch {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }

  let payload: { ok?: boolean; data?: T; error?: string } | null = null;
  try {
    payload = (await resp.json()) as {
      ok?: boolean;
      data?: T;
      error?: string;
    };
  } catch {
    payload = null;
  }

  if (!resp.ok || !payload?.ok) {
    throw new Error(
      payload?.error || `Local backend command '${cmd}' failed (${resp.status})`
    );
  }
  return payload.data as T;
}

// ---------------------------------------------------------------------------
// Public IPC API (100% aligned with Rust Tauri v2 & Sovereign Node backends)
// ---------------------------------------------------------------------------

export async function startInvestigation(
  input: InvestigationInput
): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<string>("start_investigation", { input });
}

export async function deepenNode(
  caseId: string,
  nodeId: string
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<void>("deepen_node", { caseId, nodeId });
}

export async function setNodeStatus(
  caseId: string,
  nodeId: string,
  status: NodeStatus
): Promise<CaseSnapshot> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<CaseSnapshot>("set_node_status", {
    caseId,
    nodeId,
    status,
  });
}

export async function getCaseSnapshot(caseId: string): Promise<CaseSnapshot> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<CaseSnapshot>("get_case_snapshot", { caseId });
}

export async function listCases(): Promise<CaseSummary[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return callBackend<CaseSummary[]>("list_cases");
}

export async function purgeCase(caseId: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<void>("purge_case", { caseId });
}

export async function purgeAllCases(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<void>("purge_all_cases");
}

export async function getEnvironmentStatus(): Promise<EnvStatus> {
  if (!isTauriRuntime()) {
    return {
      tor_socks_available: false,
      tor_endpoint: null,
      tor_exit_ip: null,
      anonymity_active: false,
      anonymity_mode: "offline",
      python_path: null,
      sidecar_tools: [],
    };
  }
  return callBackend<EnvStatus>("get_environment_status");
}

export async function saveAuthConfig(config: AuthConfig): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<void>("save_auth_config", { config });
}

export async function getAuthConfig(): Promise<AuthConfig> {
  if (!isTauriRuntime()) {
    return {
      ...DEFAULT_OFFLINE_CONFIG,
      custom_onion_seeds: [],
    };
  }
  return callBackend<AuthConfig>("get_auth_config");
}

export async function exportDossierHtml(
  caseId: string,
  redact: boolean
): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error(BACKEND_OFFLINE_MESSAGE);
  }
  return callBackend<string>("export_dossier_html", { caseId, redact });
}

export async function listenInvestigationEvents(
  handler: (event: StreamEvent) => void
): Promise<UnlistenFn> {
  if (isNativeTauri()) {
    return listen<StreamEvent>("investigation://event", (ev) => {
      handler(ev.payload);
    });
  }
  if (isLocalBackendRuntime()) {
    const es = new EventSource("/events");
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as StreamEvent;
        handler(parsed);
      } catch {
        // ignore malformed frame
      }
    };
    return () => {
      es.close();
    };
  }
  return () => {};
}
