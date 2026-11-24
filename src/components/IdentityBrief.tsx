import { useMemo } from "react";
import { Check, ExternalLink, GitFork, RotateCcw, X } from "lucide-react";
import type {
  CaseSnapshot,
  EnvStatus,
  GraphNode,
  IntelTab,
  NodeStatus,
  ToolRunStatus,
} from "../types";
import type { ClassifiedIntel } from "../lib/classify";
import { redactNodeLabel, redactText } from "../lib/redact";

interface IdentityBriefProps {
  snapshot: CaseSnapshot;
  intel: ClassifiedIntel;
  activeTab: IntelTab;
  selectedNode: GraphNode | null;
  redact: boolean;
  isRunning: boolean;
  stageMessage: string;
  stageProgress: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  envStatus: EnvStatus | null;
  deepeningNodeId: string | null;
  onSelectTab: (tab: IntelTab) => void;
  onDeepenNode: (nodeId: string) => void;
  onSetNodeStatus: (nodeId: string, status: NodeStatus) => void;
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

function formatEta(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `~${m}m ${rem}s left` : `~${m}m left`;
}

function computeExposureScore(intel: ClassifiedIntel): {
  score: number;
  tone: "low" | "moderate" | "elevated" | "critical";
  label: string;
} {
  const raw = Math.min(
    100,
    Math.round(
      intel.counts.contacts * 15 +
        intel.counts.accounts * 7 +
        intel.counts.records * 5 +
        intel.onionHits.length * 24 +
        intel.corpusHits.length * 20 +
        intel.pasteHits.length * 14 +
        intel.cryptoKeys.length * 6
    )
  );

  if (raw >= 75) return { score: raw, tone: "critical", label: "High exposure" };
  if (raw >= 45) return { score: raw, tone: "elevated", label: "Elevated" };
  if (raw >= 20) return { score: raw, tone: "moderate", label: "Moderate" };
  return { score: raw, tone: "low", label: "Low footprint" };
}

const CHALLENGE_DETAIL_RE =
  /(captcha|challenge|rate[- ]?limit|throttl|declined|403|202|429|blocked|failover|fallback|strict_anonymity)/i;

function shouldShowDetailNote(run: ToolRunStatus): boolean {
  if (!run.detail || run.state === "running" || run.state === "queued") {
    return false;
  }
  if (run.state === "error") return true;
  return CHALLENGE_DETAIL_RE.test(run.detail);
}

function formatEngineStatus(run: ToolRunStatus): {
  text: string;
  tone: "hits" | "running" | "muted" | "warn" | "error";
} {
  const detail = (run.detail || "").toLowerCase();
  const hasChallenge = CHALLENGE_DETAIL_RE.test(detail);

  if (run.state === "running") {
    return { text: "running", tone: "running" };
  }
  if (run.state === "queued") {
    return { text: "queued", tone: "muted" };
  }
  if (run.state === "done") {
    if (run.hits > 0) {
      return {
        text: `${run.hits} hit${run.hits === 1 ? "" : "s"}`,
        tone: hasChallenge ? "warn" : "hits",
      };
    }
    if (hasChallenge) {
      return { text: "rate-limited", tone: "warn" };
    }
    return { text: "0 hits", tone: "muted" };
  }
  if (run.state === "error") {
    if (detail.includes("tor") || detail.includes("strict")) {
      return { text: "Tor blocked", tone: "warn" };
    }
    if (hasChallenge) {
      return { text: "challenged", tone: "warn" };
    }
    return { text: "error", tone: "error" };
  }

  if (detail.includes("quick depth") || detail.includes("(l1)")) {
    return { text: "L1 skip", tone: "muted" };
  }
  if (detail.includes("phone")) return { text: "needs phone", tone: "muted" };
  if (detail.includes("email")) return { text: "needs email", tone: "muted" };
  if (
    detail.includes("domain") ||
    detail.includes("site") ||
    detail.includes("pdf")
  ) {
    return { text: "no domains", tone: "muted" };
  }
  if (
    detail.includes("tor") &&
    (detail.includes("offline") ||
      detail.includes("not running") ||
      detail.includes("unavailable") ||
      detail.includes("unreachable"))
  ) {
    return { text: "Tor offline", tone: "warn" };
  }
  if (detail.includes("tor") && detail.includes("disabled")) {
    return { text: "Tor off", tone: "muted" };
  }
  if (detail.includes("passive")) return { text: "passive", tone: "muted" };
  if (detail.includes("not installed") || detail.includes("missing")) {
    return { text: "missing", tone: "muted" };
  }
  if (detail.includes("empty") || detail.includes("folder")) {
    return { text: "empty dir", tone: "muted" };
  }
  if (hasChallenge) return { text: "challenged", tone: "warn" };
  return { text: "skipped", tone: "muted" };
}

export function IdentityBrief({
  snapshot,
  intel,
  activeTab,
  selectedNode,
  redact,
  isRunning,
  stageMessage,
  stageProgress,
  elapsedSeconds,
  etaSeconds,
  envStatus,
  deepeningNodeId,
  onSelectTab,
  onDeepenNode,
  onSetNodeStatus,
}: IdentityBriefProps) {
  const exposure = useMemo(() => computeExposureScore(intel), [intel]);

  const completedTools = snapshot.tool_runs.filter(
    (t) => t.state === "done" || t.state === "skipped" || t.state === "error"
  ).length;
  const totalTools = snapshot.tool_runs.length;
  const progressPct = isRunning
    ? Math.max(
        6,
        Math.min(
          97,
          stageProgress ||
            Math.round((completedTools / Math.max(1, totalTools)) * 100)
        )
      )
    : 100;

  const etaLabel = isRunning ? formatEta(etaSeconds) : null;

  return (
    <aside className="zone-brief" aria-label="Identity brief and local engines">
      {/* 1. Target Name + Exposure Snapshot (4 crisp numbers matching the 4 tabs 1:1) */}
      <div className="brief-section">
        <div className="target-header">
          <div className="target-identity">
            <h1 className="target-name">{snapshot.input.full_name}</h1>
            <p className="target-sub">
              {snapshot.input.org
                ? snapshot.input.org
                : snapshot.input.domain
                ? snapshot.input.domain
                : snapshot.input.passive_only
                ? "Passive local engines"
                : `Depth ${snapshot.input.depth_level ?? 2} · Full local engines`}
            </p>
          </div>
          <div className={`exposure-score tone-${exposure.tone}`}>
            <span className="score-num tabular">{exposure.score}</span>
            <span className="score-label">{exposure.label}</span>
          </div>
        </div>

        <div className="brief-metrics" role="group" aria-label="Category counts">
          <button
            type="button"
            className={`metric-cell metric-btn ${
              activeTab === "contacts" ? "is-active" : ""
            }`}
            onClick={() => onSelectTab("contacts")}
          >
            <span className="metric-value tabular">
              {intel.counts.contacts}
            </span>
            <span className="metric-label">Contacts</span>
          </button>

          <button
            type="button"
            className={`metric-cell metric-btn ${
              activeTab === "accounts" ? "is-active" : ""
            }`}
            onClick={() => onSelectTab("accounts")}
          >
            <span className="metric-value tabular">
              {intel.counts.accounts}
            </span>
            <span className="metric-label">Accounts</span>
          </button>

          <button
            type="button"
            className={`metric-cell metric-btn ${
              activeTab === "records" ? "is-active" : ""
            }`}
            onClick={() => onSelectTab("records")}
          >
            <span className="metric-value tabular">{intel.counts.records}</span>
            <span className="metric-label">Records</span>
          </button>

          <button
            type="button"
            className={`metric-cell metric-btn ${
              activeTab === "darkweb" ? "is-active" : ""
            }`}
            onClick={() => onSelectTab("darkweb")}
          >
            <span
              className={`metric-value tabular ${
                intel.counts.darkweb > 0 ? "text-crimson" : ""
              }`}
            >
              {intel.counts.darkweb}
            </span>
            <span className="metric-label">Dark web</span>
          </button>
        </div>
      </div>

      {/* 2. Compact Selected Item Quick Actions (ONLY when a node is selected) */}
      {selectedNode && selectedNode.layer !== "seed" && (
        <div className="brief-section brief-selected-card">
          <div className="selected-card-head">
            <div className="selected-card-title-wrap">
              <span className={`layer-dot layer-${selectedNode.layer}`} />
              <span className="selected-card-title">
                {redactNodeLabel(
                  selectedNode.label,
                  selectedNode.kind,
                  redact
                )}
              </span>
            </div>
            {selectedNode.url && (
              <a
                href={selectedNode.url}
                target="_blank"
                rel="noreferrer"
                className="card-icon-btn"
                title="Open source URL"
                aria-label="Open source URL"
              >
                <ExternalLink size={13} strokeWidth={1.5} />
              </a>
            )}
          </div>

          <p className="selected-card-why">
            {redactText(
              selectedNode.metadata?.site_purpose ||
                selectedNode.metadata?.match_reason ||
                selectedNode.sublabel ||
                `${Math.round(selectedNode.confidence * 100)}% confidence`,
              redact,
              selectedNode.metadata?.onion_host
                ? [selectedNode.metadata.onion_host]
                : []
            )}
          </p>
          {selectedNode.metadata?.where_found && (
            <p className="selected-card-where mono">
              {redactText(
                selectedNode.metadata.where_found,
                redact,
                selectedNode.metadata?.onion_host
                  ? [selectedNode.metadata.onion_host]
                  : []
              )}
            </p>
          )}

          <div className="quick-btn-row">
            <button
              type="button"
              className="btn-primary-xs"
              disabled={deepeningNodeId === selectedNode.id}
              onClick={() => onDeepenNode(selectedNode.id)}
            >
              <GitFork size={12} strokeWidth={1.5} />
              <span>
                {deepeningNodeId === selectedNode.id
                  ? "Deepening..."
                  : "Deepen"}
              </span>
            </button>
            {(selectedNode.status === "unverified" ||
              selectedNode.status === "quarantined") && (
              <button
                type="button"
                className="btn-ghost-xs"
                onClick={() => onSetNodeStatus(selectedNode.id, "confirmed")}
              >
                <Check size={12} strokeWidth={1.5} />
                <span>Confirm</span>
              </button>
            )}
            {selectedNode.status !== "dismissed" &&
            selectedNode.status !== "quarantined" ? (
              <button
                type="button"
                className="btn-ghost-xs"
                onClick={() => onSetNodeStatus(selectedNode.id, "dismissed")}
              >
                <X size={12} strokeWidth={1.5} />
                <span>Dismiss</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn-ghost-xs"
                onClick={() => onSetNodeStatus(selectedNode.id, "unverified")}
              >
                <RotateCcw size={12} strokeWidth={1.5} />
                <span>Restore</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3. Clean Local Engines Progress List with Live Elapsed & ETA */}
      <div className="brief-section brief-engines">
        <div className="section-head">
          <h2 className="section-title">Local engines</h2>
          <div className="engine-head-right">
            <span
              className={`tor-mini-badge mono ${
                envStatus?.tor_socks_available ? "is-live" : ""
              }`}
            >
              {envStatus?.tor_socks_available ? "Tor" : "Direct"}
            </span>
            <span className="mono muted-value tabular">
              {completedTools}/{totalTools || 0}
            </span>
          </div>
        </div>

        <div
          className="progress-track"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="progress-fill"
            style={{ transform: `scaleX(${progressPct / 100})` }}
          />
        </div>

        <div className="stage-meta-row">
          <p className="stage-caption">
            {isRunning
              ? stageMessage || "Running local sovereign engines"
              : elapsedSeconds > 0
              ? `Complete in ${formatClock(elapsedSeconds)} — zero external APIs`
              : "Local pass complete — zero external APIs"}
          </p>
          {isRunning && (
            <span className="stage-clock mono tabular">
              {formatClock(elapsedSeconds)}
              {etaLabel ? ` · ${etaLabel}` : ""}
            </span>
          )}
        </div>

        <ul className="tool-strip">
          {snapshot.tool_runs.map((run) => {
            const badge = formatEngineStatus(run);
            const showNote = shouldShowDetailNote(run);
            return (
              <li
                key={run.tool}
                className={`tool-row ${showNote ? "has-detail" : ""}`}
                title={run.detail || run.tool}
              >
                <div className="tool-row-main">
                  <span
                    className={`run-dot run-${run.state}`}
                    aria-label={run.state}
                  />
                  <span className="tool-name mono">{run.tool}</span>
                  <span
                    className={`tool-hits mono tabular tone-${badge.tone}`}
                  >
                    {badge.text}
                  </span>
                </div>
                {showNote && (
                  <div className="tool-detail-note">{run.detail}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
