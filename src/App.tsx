import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FolderClock,
  Globe,
  Plus,
  Search,
  Shield,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type {
  AuthConfig,
  CaseSnapshot,
  CaseSummary,
  DepthLevel,
  EnvStatus,
  GraphNode,
  IntelTab,
  InvestigationInput,
  NodeStatus,
  StreamEvent,
} from "./types";
import { classifyIntel } from "./lib/classify";

const DEPTH_PRESETS: Array<{
  level: DepthLevel;
  label: string;
  short: string;
  est: string;
  estSeconds: number;
  hint: string;
}> = [
  {
    level: 1,
    label: "Quick",
    short: "L1 Quick",
    est: "~25s",
    estSeconds: 25,
    hint: "Fast surface check across primary handles and direct profiles",
  },
  {
    level: 2,
    label: "Standard",
    short: "L2 Standard",
    est: "~1m",
    estSeconds: 65,
    hint: "Balanced multi-source sweep: social, web, contacts, services & Tor",
  },
  {
    level: 3,
    label: "Deep",
    short: "L3 Deep",
    est: "~2m",
    estSeconds: 115,
    hint: "Expanded social, legal/corporate records, PDFs, services & Tor search",
  },
  {
    level: 4,
    label: "Max",
    short: "L4 Max",
    est: "~3m",
    estSeconds: 175,
    hint: "Exhaustive multi-pass sweep across every local engine, PDF & Tor seed",
  },
];

function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

function formatEtaText(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `~${m}m ${rem}s left` : `~${m}m left`;
}
import {
  deepenNode,
  exportDossierHtml,
  getAuthConfig,
  getCaseSnapshot,
  getEnvironmentStatus,
  isTauriRuntime,
  listCases,
  listenInvestigationEvents,
  purgeAllCases,
  purgeCase,
  saveAuthConfig,
  setNodeStatus,
  startInvestigation,
} from "./lib/tauri";
import { IdentityBrief } from "./components/IdentityBrief";
import { IdentityGraph } from "./components/IdentityGraph";
import { FindingsStream } from "./components/FindingsStream";
import { ConfigToolsModal } from "./components/ConfigToolsModal";
import { ConfirmPurgeDialog } from "./components/ConfirmPurgeDialog";

const DEFAULT_CONFIG: AuthConfig = {
  tor_socks_url: "socks5h://127.0.0.1:9050",
  proxy_url: null,
  local_corpus_dir: null,
  custom_onion_seeds: [],
};

function mergeById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function deriveQuickStats(snap: CaseSnapshot): CaseSnapshot["stats"] {
  const activeNodes = snap.nodes.filter(
    (n) => n.status !== "dismissed" && n.status !== "quarantined"
  );
  const confirmedAnchors = activeNodes.filter(
    (n) => n.layer === "anchor" || n.status === "confirmed"
  ).length;
  const verifiedFindings = snap.findings.filter(
    (f) => f.consensus_count >= 2 || f.confidence >= 0.72
  ).length;
  const darkwebHits = snap.findings.filter((f) => f.category === "darkweb").length;
  const breachHits = snap.findings.filter((f) => f.category === "breach").length;
  const toolsCompleted = snap.tool_runs.filter(
    (t) => t.state === "done" || t.state === "skipped" || t.state === "error"
  ).length;

  return {
    total_nodes: activeNodes.length,
    confirmed_anchors: confirmedAnchors,
    verified_findings: verifiedFindings,
    low_conf_findings: Math.max(0, snap.findings.length - verifiedFindings),
    darkweb_hits: darkwebHits,
    breach_hits: breachHits,
    tools_completed: toolsCompleted,
    tools_total: snap.tool_runs.length,
  };
}

function downloadHtmlFile(filename: string, html: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const inTauri = useMemo(() => isTauriRuntime(), []);

  // Query form state — Full Deep Mode armed out of the box
  const [fullName, setFullName] = useState("");
  const [org, setOrg] = useState("");
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [phone, setPhone] = useState("");
  const [domain, setDomain] = useState("");
  const [passiveOnly, setPassiveOnly] = useState(false);
  const [enableTor, setEnableTor] = useState(true);
  const [strictAnonymity, setStrictAnonymity] = useState(true);
  const [depthLevel, setDepthLevel] = useState<DepthLevel>(2);

  // Active workspace state
  const [snapshot, setSnapshot] = useState<CaseSnapshot | null>(null);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<IntelTab>("accounts");
  const [highlightTabOnGraph, setHighlightTabOnGraph] = useState(false);
  const [redact, setRedact] = useState(false);

  // Streaming & operation states
  const [isRunning, setIsRunning] = useState(false);
  const [stageMessage, setStageMessage] = useState("");
  const [stageProgress, setStageProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const traceStartMsRef = useRef<number | null>(null);
  const backendEtaSyncedRef = useRef<boolean>(false);
  const [deepeningNodeId, setDeepeningNodeId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [offlineBannerDismissed, setOfflineBannerDismissed] = useState(false);

  // Environment, config & history
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig>(DEFAULT_CONFIG);

  // Overlays / popovers
  const [configOpen, setConfigOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [casesPopoverOpen, setCasesPopoverOpen] = useState(false);

  const activeCaseIdRef = useRef<string | null>(null);
  activeCaseIdRef.current = activeCaseId;

  const userTouchedStrictRef = useRef(false);
  const contextPopoverRef = useRef<HTMLDivElement | null>(null);
  const casesPopoverRef = useRef<HTMLDivElement | null>(null);

  const optionalContextCount = useMemo(
    () =>
      [org, email, handle, phone, domain].filter((v) => v.trim().length > 0)
        .length,
    [org, email, handle, phone, domain]
  );

  // Derive clear live anonymity status pill state
  const anonymityDisplay = useMemo(() => {
    const torReady = Boolean(
      envStatus?.anonymity_active || envStatus?.tor_socks_available
    );
    const exitIp = envStatus?.tor_exit_ip;

    if (torReady && (strictAnonymity || enableTor)) {
      return {
        tone: "anon" as const,
        label: exitIp ? `Tor Anon · ${exitIp}` : "Tor Anon",
        title:
          "Outbound local engine traffic routed through Tor SOCKS5h (remote DNS). Click to toggle Strict Tor Anonymity.",
      };
    }
    if (strictAnonymity) {
      return {
        tone: "strict-offline" as const,
        label: "Tor Strict (Offline)",
        title:
          "Fail-closed anonymity active: direct clearnet requests are blocked while Tor is offline. Click to switch to Direct or start Tor.",
      };
    }
    return {
      tone: "direct" as const,
      label: "Direct",
      title:
        "Strict Tor Anonymity is off; local engines connect directly from this machine. Click to enforce Strict Tor Anonymity.",
    };
  }, [envStatus, strictAnonymity, enableTor]);

  const handleToggleStrictAnonymity = () => {
    userTouchedStrictRef.current = true;
    setStrictAnonymity((prev) => {
      const next = !prev;
      if (next) setEnableTor(true);
      return next;
    });
  };

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Close popovers on outside click or Escape
  useEffect(() => {
    if (!contextPopoverOpen && !casesPopoverOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextPopoverOpen(false);
        setCasesPopoverOpen(false);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        contextPopoverOpen &&
        contextPopoverRef.current &&
        !contextPopoverRef.current.contains(target)
      ) {
        setContextPopoverOpen(false);
      }
      if (
        casesPopoverOpen &&
        casesPopoverRef.current &&
        !casesPopoverRef.current.contains(target)
      ) {
        setCasesPopoverOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [contextPopoverOpen, casesPopoverOpen]);

  // Load initial local environment, config, and stored cases
  const refreshEnvironment = useCallback(async () => {
    try {
      const env = await getEnvironmentStatus();
      setEnvStatus(env);
      if (!userTouchedStrictRef.current && env.tor_socks_available) {
        setStrictAnonymity(true);
      }
      return env;
    } catch {
      return null;
    }
  }, []);

  const refreshCases = useCallback(async () => {
    try {
      const list = await listCases();
      setCases(list);
    } catch {
      // Ignore initial empty DB errors
    }
  }, []);

  useEffect(() => {
    let pollTimer: number | undefined;
    let cancelled = false;
    let attempts = 0;
    // Cold start: Tor often needs 15-30s to bootstrap after the app opens. Poll
    // every 2s for up to 30s until a SOCKS listener is reported, then stop.
    const POLL_MS = 2000;
    const MAX_ATTEMPTS = 15;
    const pollEnvironment = async () => {
      const env = await refreshEnvironment();
      if (cancelled) return;
      attempts += 1;
      const torReady = Boolean(env && (env.tor_socks_available || env.anonymity_active));
      if (torReady || !inTauri || attempts >= MAX_ATTEMPTS) return;
      pollTimer = window.setTimeout(() => {
        void pollEnvironment();
      }, POLL_MS);
    };
    void pollEnvironment();
    void refreshCases();
    void getAuthConfig()
      .then((cfg) => setAuthConfig(cfg))
      .catch(() => {});

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [refreshEnvironment, refreshCases, inTauri]);

  // Tick elapsed timer & smooth ETA countdown every second while running
  useEffect(() => {
    if (!isRunning) return;
    if (traceStartMsRef.current === null) {
      traceStartMsRef.current = Date.now();
    }
    const presetSec =
      DEPTH_PRESETS.find((d) => d.level === depthLevel)?.estSeconds ?? 60;

    const timer = window.setInterval(() => {
      const start = traceStartMsRef.current ?? Date.now();
      const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
      setElapsedSeconds(elapsed);
      setEtaSeconds((prev) => {
        if (backendEtaSyncedRef.current && prev !== null) {
          return Math.max(1, prev - 1);
        }
        return Math.max(2, presetSec - elapsed);
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isRunning, depthLevel]);

  // Subscribe to real-time investigation stream events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;

    const handleEvent = (ev: StreamEvent) => {
      if (!active) return;
      if (activeCaseIdRef.current && ev.case_id !== activeCaseIdRef.current) {
        return;
      }

      if (ev.kind === "stage") {
        setStageMessage(ev.message);
        setStageProgress(ev.progress);
        if (
          typeof ev.elapsed_seconds === "number" &&
          Number.isFinite(ev.elapsed_seconds)
        ) {
          setElapsedSeconds(Math.max(0, Math.round(ev.elapsed_seconds)));
          traceStartMsRef.current = Date.now() - ev.elapsed_seconds * 1000;
        }
        if (
          typeof ev.eta_seconds === "number" &&
          Number.isFinite(ev.eta_seconds)
        ) {
          backendEtaSyncedRef.current = true;
          setEtaSeconds(Math.max(0, Math.round(ev.eta_seconds)));
        }
        return;
      }

      if (ev.kind === "node") {
        setSnapshot((prev) => {
          if (!prev || prev.case_id !== ev.case_id) return prev;
          const nodes = mergeById(prev.nodes, ev.node);
          const next = { ...prev, nodes };
          return { ...next, stats: deriveQuickStats(next) };
        });
        return;
      }

      if (ev.kind === "edge") {
        setSnapshot((prev) => {
          if (!prev || prev.case_id !== ev.case_id) return prev;
          return { ...prev, edges: mergeById(prev.edges, ev.edge) };
        });
        return;
      }

      if (ev.kind === "finding") {
        setSnapshot((prev) => {
          if (!prev || prev.case_id !== ev.case_id) return prev;
          const findings = mergeById(prev.findings, ev.finding);
          const next = { ...prev, findings };
          return { ...next, stats: deriveQuickStats(next) };
        });
        return;
      }

      if (ev.kind === "tool_status") {
        setSnapshot((prev) => {
          if (!prev || prev.case_id !== ev.case_id) return prev;
          const existingIdx = prev.tool_runs.findIndex(
            (t) => t.tool === ev.tool
          );
          const updated = {
            tool: ev.tool,
            state: ev.state,
            hits: ev.hits,
            detail: ev.detail,
          };
          const tool_runs =
            existingIdx === -1
              ? [...prev.tool_runs, updated]
              : prev.tool_runs.map((t, i) => (i === existingIdx ? updated : t));
          const next = { ...prev, tool_runs };
          return { ...next, stats: deriveQuickStats(next) };
        });
        return;
      }

      if (ev.kind === "completed") {
        setIsRunning(false);
        setDeepeningNodeId(null);
        setStageProgress(100);
        setEtaSeconds(0);
        backendEtaSyncedRef.current = false;
        setSnapshot((prev) =>
          prev && prev.case_id === ev.case_id
            ? { ...prev, stats: ev.summary }
            : prev
        );
        void getCaseSnapshot(ev.case_id)
          .then((fresh) => {
            if (active && activeCaseIdRef.current === ev.case_id) {
              setSnapshot(fresh);
            }
          })
          .catch(() => {});
        void refreshCases();
      }
    };

    void listenInvestigationEvents(handleEvent).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [refreshCases]);

  const handleStartTrace = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedName = fullName.trim();
    if (!trimmedName) return;

    setContextPopoverOpen(false);
    setCasesPopoverOpen(false);
    setSelectedNodeId(null);
    setActiveTab(email.trim() || phone.trim() ? "contacts" : "accounts");
    setHighlightTabOnGraph(false);
    setIsRunning(true);
    setStageProgress(6);
    setElapsedSeconds(0);
    traceStartMsRef.current = Date.now();
    backendEtaSyncedRef.current = false;
    const presetEst =
      DEPTH_PRESETS.find((d) => d.level === depthLevel)?.estSeconds ?? 60;
    setEtaSeconds(presetEst);
    setStageMessage(
      `Starting Depth ${depthLevel} sweep across social, web, records & Tor`
    );

    const input: InvestigationInput = {
      full_name: trimmedName,
      org: org.trim() || null,
      email: email.trim() || null,
      handle: handle.trim() || null,
      phone: phone.trim() || null,
      domain: domain.trim() || null,
      passive_only: passiveOnly,
      enable_tor: enableTor,
      strict_anonymity: strictAnonymity,
      depth_level: depthLevel,
      max_depth: depthLevel >= 3 ? 3 : 2,
    };

    try {
      const caseId = await startInvestigation(input);
      setActiveCaseId(caseId);
      activeCaseIdRef.current = caseId;

      try {
        const snap = await getCaseSnapshot(caseId);
        setSnapshot(snap);
      } catch {
        setSnapshot({
          case_id: caseId,
          input,
          created_at: new Date().toISOString(),
          nodes: [
            {
              id: `person:${trimmedName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_|_$/g, "")}`,
              kind: "person",
              label: trimmedName,
              sublabel: input.org ?? "Identity seed",
              layer: "seed",
              confidence: 1,
              status: "confirmed",
              sources: ["operator_seed"],
              metadata: {},
              url: null,
              depth: 0,
            },
          ],
          edges: [],
          findings: [],
          tool_runs: [],
          stats: {
            total_nodes: 1,
            confirmed_anchors: 1,
            verified_findings: 0,
            low_conf_findings: 0,
            darkweb_hits: 0,
            breach_hits: 0,
            tools_completed: 0,
            tools_total: 0,
          },
        });
      }
      void refreshCases();
    } catch (err) {
      setIsRunning(false);
      showNotice(
        err instanceof Error ? err.message : "Failed to start local trace"
      );
    }
  };

  const handleOpenCase = async (caseId: string) => {
    setCasesPopoverOpen(false);
    try {
      const snap = await getCaseSnapshot(caseId);
      setActiveCaseId(snap.case_id);
      activeCaseIdRef.current = snap.case_id;
      setSnapshot(snap);
      setFullName(snap.input.full_name);
      setOrg(snap.input.org ?? "");
      setEmail(snap.input.email ?? "");
      setHandle(snap.input.handle ?? "");
      setPhone(snap.input.phone ?? "");
      setDomain(snap.input.domain ?? "");
      setPassiveOnly(snap.input.passive_only);
      setEnableTor(snap.input.enable_tor);
      if (typeof snap.input.strict_anonymity === "boolean") {
        setStrictAnonymity(snap.input.strict_anonymity);
      }
      if (
        snap.input.depth_level === 1 ||
        snap.input.depth_level === 2 ||
        snap.input.depth_level === 3 ||
        snap.input.depth_level === 4
      ) {
        setDepthLevel(snap.input.depth_level);
      }
      setSelectedNodeId(null);
      setActiveTab(
        snap.input.email || snap.input.phone ? "contacts" : "accounts"
      );
      setHighlightTabOnGraph(false);
      setIsRunning(false);
      setElapsedSeconds(0);
      setEtaSeconds(null);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "Could not load case");
    }
  };

  const handleDeepenNode = async (nodeId: string) => {
    if (!activeCaseId) return;
    setDeepeningNodeId(nodeId);
    setIsRunning(true);
    setStageMessage("Deepening confirmed anchor locally");
    try {
      await deepenNode(activeCaseId, nodeId);
      const fresh = await getCaseSnapshot(activeCaseId);
      setSnapshot(fresh);
    } catch (err) {
      setIsRunning(false);
      showNotice(err instanceof Error ? err.message : "Pivot deepen failed");
    } finally {
      setDeepeningNodeId(null);
    }
  };

  const handleSetNodeStatus = async (nodeId: string, status: NodeStatus) => {
    if (!activeCaseId) return;
    try {
      const updated = await setNodeStatus(activeCaseId, nodeId, status);
      setSnapshot(updated);
    } catch (err) {
      showNotice(
        err instanceof Error ? err.message : "Could not update node status"
      );
    }
  };

  const handleExportBrief = async () => {
    if (!activeCaseId || !snapshot) return;
    setExporting(true);
    try {
      const html = await exportDossierHtml(activeCaseId, redact);
      const slug = snapshot.input.full_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const suffix = redact ? "-redacted" : "";
      downloadHtmlFile(`tauf-${slug || "brief"}${suffix}.html`, html);
      showNotice(
        redact
          ? "Exported redacted HTML dossier"
          : "Exported self-contained HTML dossier"
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleSaveConfig = async (nextConfig: AuthConfig) => {
    await saveAuthConfig(nextConfig);
    setAuthConfig(nextConfig);
    await refreshEnvironment();
  };

  const handlePurgeCurrent = async () => {
    if (!activeCaseId) return;
    setPurging(true);
    try {
      await purgeCase(activeCaseId);
      setSnapshot(null);
      setActiveCaseId(null);
      activeCaseIdRef.current = null;
      setSelectedNodeId(null);
      await refreshCases();
      showNotice("Case purged from local database");
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "Purge failed");
    } finally {
      setPurging(false);
    }
  };

  const handlePurgeAll = async () => {
    setPurging(true);
    try {
      await purgeAllCases();
      setSnapshot(null);
      setActiveCaseId(null);
      activeCaseIdRef.current = null;
      setSelectedNodeId(null);
      setCases([]);
      showNotice("All local cases purged");
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "Purge all failed");
    } finally {
      setPurging(false);
    }
  };

  const intel = useMemo(
    () =>
      snapshot
        ? classifyIntel(snapshot.nodes, snapshot.edges, snapshot.findings)
        : null,
    [snapshot]
  );

  const selectedNode: GraphNode | null = useMemo(() => {
    if (!snapshot || !selectedNodeId) return null;
    return snapshot.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [snapshot, selectedNodeId]);

  const handleSelectTab = useCallback((tab: IntelTab) => {
    setSelectedNodeId(null);
    setActiveTab(tab);
    setHighlightTabOnGraph(true);
  }, []);

  const handleSelectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (nodeId) {
      setHighlightTabOnGraph(false);
    }
  }, []);

  const highlightedNodeIds = useMemo(() => {
    if (!intel || !highlightTabOnGraph || selectedNodeId) return null;
    return intel.tabNodeIds[activeTab];
  }, [intel, highlightTabOnGraph, selectedNodeId, activeTab]);

  const handleResetToLauncher = () => {
    setSnapshot(null);
    setActiveCaseId(null);
    activeCaseIdRef.current = null;
    setSelectedNodeId(null);
    setIsRunning(false);
  };

  return (
    <div className={`app-shell ${snapshot ? "mode-active" : "mode-landing"}`}>
      {!inTauri && !offlineBannerDismissed && (
        <div className="preview-bar is-offline" role="status">
          <span>
            Local TAUF backend is offline — start via{" "}
            <code className="inline-code">launch-tauf.vbs</code> or{" "}
            <code className="inline-code">npm start</code>.
          </span>
          <button
            type="button"
            className="preview-dismiss"
            onClick={() => setOfflineBannerDismissed(true)}
            aria-label="Dismiss offline backend notice"
          >
            Dismiss
          </button>
        </div>
      )}

      {!snapshot ? (
        /* ------------------------------------------------------------------ */
        /* LANDING / LAUNCH STATE — Ultra-clean single-input focus            */
        /* ------------------------------------------------------------------ */
        <main className="landing-main">
          <div className="landing-center">
            <header className="landing-brand">
              <img
                src="/logo.svg?v=6-aqua"
                alt="TAUF"
                className="brand-logo-img"
                width={44}
                height={44}
              />
              <span className="brand-wordmark">TAUF</span>

              <button
                type="button"
                className={`anon-pill anon-${anonymityDisplay.tone} landing-anon-pill`}
                onClick={handleToggleStrictAnonymity}
                title={anonymityDisplay.title}
                aria-pressed={strictAnonymity}
              >
                <span className="anon-dot" />
                <span className="mono">{anonymityDisplay.label}</span>
              </button>
            </header>

            <h1 className="landing-headline">
              Map an identity from a single full name
            </h1>
            <p className="landing-sub">
              Social profiles, contacts, legal &amp; corporate records, public
              PDFs, offline corpus, and Tor .onion search. Zero external APIs.
            </p>

            <form className="landing-form" onSubmit={handleStartTrace}>
              <div className="primary-input-row">
                <Search
                  size={18}
                  strokeWidth={1.5}
                  className="input-lead-icon"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  className="hero-name-input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Enter a person's full name"
                  autoFocus
                  required
                  aria-label="Person's full name"
                />
                <button
                  type="submit"
                  className="btn-trace-hero"
                  disabled={!fullName.trim() || isRunning}
                >
                  Trace
                </button>
              </div>

              {/* Clean 4-level Depth selector */}
              <div
                className="depth-selector"
                role="radiogroup"
                aria-label="Investigation depth"
              >
                {DEPTH_PRESETS.map((preset) => (
                  <button
                    key={preset.level}
                    type="button"
                    role="radio"
                    aria-checked={depthLevel === preset.level}
                    className={`depth-step ${
                      depthLevel === preset.level ? "is-active" : ""
                    }`}
                    onClick={() => setDepthLevel(preset.level)}
                    title={preset.hint}
                  >
                    <span className="depth-step-label">{preset.label}</span>
                    <span className="depth-step-est mono tabular">
                      {preset.est}
                    </span>
                  </button>
                ))}
              </div>

              {/* Quiet, optional, collapsible context */}
              <details className="optional-context">
                <summary className="optional-summary">
                  <ChevronRight
                    size={15}
                    strokeWidth={1.5}
                    className="disclosure-chevron"
                  />
                  <span>Add optional context</span>
                  {optionalContextCount > 0 && (
                    <span className="mono muted-value tabular">
                      {optionalContextCount} set
                    </span>
                  )}
                </summary>
                <div className="optional-grid">
                  <input
                    type="text"
                    className="context-input"
                    value={org}
                    onChange={(e) => setOrg(e.target.value)}
                    placeholder="Organization or company"
                    aria-label="Organization or company"
                  />
                  <input
                    type="email"
                    className="context-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email address"
                    aria-label="Email address"
                  />
                  <input
                    type="text"
                    className="context-input"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    placeholder="Known handle"
                    aria-label="Known handle"
                  />
                  <input
                    type="tel"
                    className="context-input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Phone number"
                    aria-label="Phone number"
                  />
                  <input
                    type="text"
                    className="context-input"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="Domain (e.g. company.com)"
                    aria-label="Domain"
                  />
                </div>
              </details>

              {/* Subtle inline controls */}
              <div className="landing-controls">
                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={strictAnonymity}
                    onChange={handleToggleStrictAnonymity}
                  />
                  <Globe size={14} strokeWidth={1.5} />
                  <span>Strict Tor anonymity</span>
                </label>

                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={passiveOnly}
                    onChange={(e) => setPassiveOnly(e.target.checked)}
                  />
                  <Shield size={14} strokeWidth={1.5} />
                  <span>Passive only</span>
                </label>

                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={enableTor}
                    onChange={(e) => setEnableTor(e.target.checked)}
                  />
                  <span
                    className={`run-dot ${
                      envStatus?.tor_socks_available
                        ? "run-done"
                        : "run-skipped"
                    }`}
                  />
                  <span>Tor / .onion</span>
                </label>

                <button
                  type="button"
                  className="inline-link-btn"
                  onClick={() => setConfigOpen(true)}
                >
                  <SlidersHorizontal size={14} strokeWidth={1.5} />
                  <span>Config &amp; tools</span>
                </button>
              </div>
            </form>

            {cases.length > 0 && (
              <div className="landing-recent">
                <span className="muted-label">Recent local cases</span>
                <div className="recent-list">
                  {cases.slice(0, 4).map((c) => (
                    <button
                      key={c.case_id}
                      type="button"
                      className="recent-chip"
                      onClick={() => void handleOpenCase(c.case_id)}
                    >
                      <span>{c.full_name}</span>
                      <span className="mono muted-value tabular">
                        {c.node_count} nodes
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      ) : (
        /* ------------------------------------------------------------------ */
        /* ACTIVE INVESTIGATION STATE — Compact top bar + cohesive 3-zone UI  */
        /* ------------------------------------------------------------------ */
        <>
          <header className="command-bar">
            <div className="bar-left">
              <button
                type="button"
                className="bar-brand"
                onClick={handleResetToLauncher}
                title="New investigation"
              >
                <img
                  src="/logo.svg?v=6-aqua"
                  alt="TAUF"
                  className="brand-logo-img brand-logo-sm"
                  width={26}
                  height={26}
                />
                <span className="bar-wordmark">TAUF</span>
              </button>

              <form className="bar-search-form" onSubmit={handleStartTrace}>
                <input
                  type="text"
                  className="bar-name-input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Full name"
                  aria-label="Person's full name"
                />

                <div className="popover-anchor" ref={contextPopoverRef}>
                  <button
                    type="button"
                    className={`bar-btn ${
                      optionalContextCount > 0 ? "is-accented" : ""
                    }`}
                    onClick={() => {
                      setContextPopoverOpen((o) => !o);
                      setCasesPopoverOpen(false);
                    }}
                    aria-expanded={contextPopoverOpen}
                  >
                    <Plus size={14} strokeWidth={1.5} />
                    <span>
                      Context
                      {optionalContextCount > 0
                        ? ` (${optionalContextCount})`
                        : ""}
                    </span>
                  </button>

                  {contextPopoverOpen && (
                    <div
                      className="floating-panel context-popover"
                      role="dialog"
                      aria-label="Optional context fields"
                    >
                      <div className="panel-head">
                        <span>Optional context</span>
                        {optionalContextCount > 0 && (
                          <button
                            type="button"
                            className="text-action"
                            onClick={() => {
                              setOrg("");
                              setEmail("");
                              setHandle("");
                              setPhone("");
                              setDomain("");
                            }}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="popover-fields">
                        <input
                          type="text"
                          className="context-input"
                          value={org}
                          onChange={(e) => setOrg(e.target.value)}
                          placeholder="Organization / company"
                        />
                        <input
                          type="email"
                          className="context-input"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="Email"
                        />
                        <input
                          type="text"
                          className="context-input"
                          value={handle}
                          onChange={(e) => setHandle(e.target.value)}
                          placeholder="Handle"
                        />
                        <input
                          type="tel"
                          className="context-input"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="Phone"
                        />
                        <input
                          type="text"
                          className="context-input"
                          value={domain}
                          onChange={(e) => setDomain(e.target.value)}
                          placeholder="Domain"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div
                  className="bar-depth-group"
                  role="radiogroup"
                  aria-label="Investigation depth"
                >
                  {DEPTH_PRESETS.map((p) => (
                    <button
                      key={p.level}
                      type="button"
                      role="radio"
                      aria-checked={depthLevel === p.level}
                      className={`bar-depth-btn mono ${
                        depthLevel === p.level ? "is-active" : ""
                      }`}
                      onClick={() => setDepthLevel(p.level)}
                      title={`${p.label} (${p.est}) — ${p.hint}`}
                    >
                      L{p.level}
                    </button>
                  ))}
                </div>

                <button
                  type="submit"
                  className="btn-trace-bar"
                  disabled={!fullName.trim() || isRunning}
                >
                  {isRunning ? "Tracing..." : "Trace"}
                </button>
              </form>
            </div>

            <div className="bar-right">
              <button
                type="button"
                className={`anon-pill anon-${anonymityDisplay.tone}`}
                onClick={handleToggleStrictAnonymity}
                aria-pressed={strictAnonymity}
                title={anonymityDisplay.title}
              >
                <span className="anon-dot" />
                <span className="mono">{anonymityDisplay.label}</span>
              </button>

              <button
                type="button"
                className={`bar-toggle ${passiveOnly ? "is-on" : ""}`}
                onClick={() => setPassiveOnly((v) => !v)}
                aria-pressed={passiveOnly}
                title="Restrict local engines to passive-only queries"
              >
                <Shield size={14} strokeWidth={1.5} />
                <span>Passive</span>
              </button>

              <button
                type="button"
                className={`bar-toggle ${redact ? "is-on-amber" : ""}`}
                onClick={() => setRedact((v) => !v)}
                aria-pressed={redact}
                title="Mask sensitive identifiers in-place across the entire view"
              >
                {redact ? (
                  <EyeOff size={14} strokeWidth={1.5} />
                ) : (
                  <Eye size={14} strokeWidth={1.5} />
                )}
                <span>Redact</span>
              </button>

              <span className="bar-sep" aria-hidden="true" />

              <button
                type="button"
                className="bar-btn"
                onClick={() => void handleExportBrief()}
                disabled={exporting}
                title="Export self-contained HTML executive brief"
              >
                <Download size={14} strokeWidth={1.5} />
                <span>Export</span>
              </button>

              <div className="popover-anchor" ref={casesPopoverRef}>
                <button
                  type="button"
                  className="bar-btn"
                  onClick={() => {
                    setCasesPopoverOpen((o) => !o);
                    setContextPopoverOpen(false);
                  }}
                  aria-expanded={casesPopoverOpen}
                  title="Recent local cases"
                >
                  <FolderClock size={14} strokeWidth={1.5} />
                  <span>Cases</span>
                  <ChevronDown size={13} strokeWidth={1.5} />
                </button>

                {casesPopoverOpen && (
                  <div
                    className="floating-panel cases-popover"
                    role="menu"
                    aria-label="Recent cases"
                  >
                    <div className="panel-head">
                      <span>Local cases</span>
                      <span className="mono muted-value tabular">
                        {cases.length}
                      </span>
                    </div>
                    {cases.length === 0 ? (
                      <p className="empty-hint">No saved cases yet.</p>
                    ) : (
                      <ul className="cases-menu">
                        {cases.map((c) => (
                          <li key={c.case_id}>
                            <button
                              type="button"
                              className={`case-menu-row ${
                                c.case_id === activeCaseId ? "is-current" : ""
                              }`}
                              onClick={() => void handleOpenCase(c.case_id)}
                            >
                              <span className="case-menu-name">
                                {c.full_name}
                              </span>
                              <span className="mono muted-value tabular">
                                {c.node_count}n · {c.finding_count}f
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                className="bar-btn"
                onClick={() => setConfigOpen(true)}
                title="Local engines and sovereign settings"
              >
                <SlidersHorizontal size={14} strokeWidth={1.5} />
                <span>Tools</span>
              </button>

              <button
                type="button"
                className="bar-btn bar-btn-danger"
                onClick={() => setPurgeOpen(true)}
                title="Purge local case data"
                aria-label="Purge local case data"
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </div>
          </header>

          {/* Live full-width slim progress bar + ticking Elapsed / ETA strip */}
          {isRunning && (
            <div className="live-progress-banner" role="status" aria-live="polite">
              <div className="live-progress-row">
                <span className="run-dot run-running" />
                <span className="live-progress-msg">
                  {stageMessage || "Running local sovereign engines"}
                </span>
                <span className="live-progress-clock mono tabular">
                  <span>Elapsed {formatClock(elapsedSeconds)}</span>
                  {formatEtaText(etaSeconds) && (
                    <>
                      <span>·</span>
                      <span className="text-amber">
                        {formatEtaText(etaSeconds)}
                      </span>
                    </>
                  )}
                  <span>·</span>
                  <span>{Math.max(6, Math.min(97, stageProgress))}%</span>
                </span>
              </div>
              <div className="live-progress-track">
                <div
                  className="live-progress-fill"
                  style={{
                    transform: `scaleX(${
                      Math.max(6, Math.min(97, stageProgress)) / 100
                    })`,
                  }}
                />
              </div>
            </div>
          )}

          <main className="workspace-grid">
            {intel && (
              <>
                <IdentityBrief
                  snapshot={snapshot}
                  intel={intel}
                  activeTab={activeTab}
                  selectedNode={selectedNode}
                  redact={redact}
                  isRunning={isRunning}
                  stageMessage={stageMessage}
                  stageProgress={stageProgress}
                  elapsedSeconds={elapsedSeconds}
                  etaSeconds={etaSeconds}
                  envStatus={envStatus}
                  deepeningNodeId={deepeningNodeId}
                  onSelectTab={handleSelectTab}
                  onDeepenNode={(id) => void handleDeepenNode(id)}
                  onSetNodeStatus={(id, status) =>
                    void handleSetNodeStatus(id, status)
                  }
                />

                <IdentityGraph
                  nodes={snapshot.nodes}
                  edges={snapshot.edges}
                  selectedNodeId={selectedNodeId}
                  highlightedNodeIds={highlightedNodeIds}
                  redact={redact}
                  isRunning={isRunning}
                  onSelectNode={handleSelectNode}
                />

                <FindingsStream
                  intel={intel}
                  nodes={snapshot.nodes}
                  toolRuns={snapshot.tool_runs}
                  activeTab={activeTab}
                  selectedNodeId={selectedNodeId}
                  redact={redact}
                  envStatus={envStatus}
                  deepeningNodeId={deepeningNodeId}
                  onTabChange={handleSelectTab}
                  onSelectNode={handleSelectNode}
                  onDeepenNode={(id) => void handleDeepenNode(id)}
                  onSetNodeStatus={(id, status) =>
                    void handleSetNodeStatus(id, status)
                  }
                />
              </>
            )}
          </main>
        </>
      )}

      {notice && (
        <div className="toast-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notification"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}

      <ConfigToolsModal
        open={configOpen}
        config={authConfig}
        envStatus={envStatus}
        onClose={() => setConfigOpen(false)}
        onSave={handleSaveConfig}
        onRefreshEnv={async () => {
          await refreshEnvironment();
        }}
      />

      <ConfirmPurgeDialog
        open={purgeOpen}
        caseName={snapshot?.input.full_name ?? null}
        totalCases={cases.length}
        busy={purging}
        onClose={() => setPurgeOpen(false)}
        onPurgeCurrent={handlePurgeCurrent}
        onPurgeAll={handlePurgeAll}
      />
    </div>
  );
}
export default App;
