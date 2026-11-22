import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, X } from "lucide-react";
import type { AuthConfig, EnvStatus } from "../types";
import { bindDialogLightDismiss, closeModalDialog } from "../lib/topLayer";

interface ConfigToolsModalProps {
  open: boolean;
  config: AuthConfig;
  envStatus: EnvStatus | null;
  onClose: () => void;
  onSave: (config: AuthConfig) => Promise<void>;
  onRefreshEnv: () => Promise<void>;
}

export function ConfigToolsModal({
  open,
  config,
  envStatus,
  onClose,
  onSave,
  onRefreshEnv,
}: ConfigToolsModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  const [torUrl, setTorUrl] = useState(config.tor_socks_url ?? "");
  const [proxyUrl, setProxyUrl] = useState(config.proxy_url ?? "");
  const [corpusDir, setCorpusDir] = useState(config.local_corpus_dir ?? "");
  const [onionSeedsText, setOnionSeedsText] = useState(
    config.custom_onion_seeds.join("\n")
  );
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setTorUrl(config.tor_socks_url ?? "");
    setProxyUrl(config.proxy_url ?? "");
    setCorpusDir(config.local_corpus_dir ?? "");
    setOnionSeedsText(config.custom_onion_seeds.join("\n"));
    setSaveError(null);
  }, [config, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const unbind = bindDialogLightDismiss(dialog, onClose);
    return unbind;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      void closeModalDialog(dialog);
    }
  }, [open]);

  const handleClose = () => {
    void closeModalDialog(dialogRef.current);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedNotice(false);
    setSaveError(null);
    try {
      const seeds = onionSeedsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      await onSave({
        tor_socks_url: torUrl.trim() || null,
        proxy_url: proxyUrl.trim() || null,
        local_corpus_dir: corpusDir.trim() || null,
        custom_onion_seeds: seeds,
      });
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 2000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save local config"
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshEnv();
    } finally {
      setRefreshing(false);
    }
  };

  const installedCount =
    envStatus?.sidecar_tools.filter((t) => t.installed).length ?? 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog modal-config"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <div className="modal-head">
        <div>
          <h2 id={titleId} className="modal-title">
            Local engines &amp; sovereign config
          </h2>
          <p className="modal-sub">
            Zero external OSINT APIs. All queries execute directly from this
            machine.
          </p>
        </div>
        <button
          type="button"
          className="icon-ctrl"
          onClick={handleClose}
          aria-label="Close dialog"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="modal-body">
        <form onSubmit={handleSubmit} className="config-form">
          <div className="sovereign-strip">
            <ShieldCheck size={16} strokeWidth={1.5} />
            <span>
              100% local execution — no paid or free third-party OSINT API keys
              required or stored.
            </span>
          </div>

          <div className="field-grid">
            <label className="field-group">
              <span className="field-label">Local Tor SOCKS5 endpoint</span>
              <input
                type="text"
                className="text-input mono"
                value={torUrl}
                onChange={(e) => setTorUrl(e.target.value)}
                placeholder="socks5h://127.0.0.1:9050"
              />
              <span className="field-hint">
                Uses socks5h:// so .onion DNS resolves inside Tor with zero
                local leak.
              </span>
            </label>

            <label className="field-group">
              <span className="field-label">Optional local proxy</span>
              <input
                type="text"
                className="text-input mono"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://127.0.0.1:8080 or socks5h://..."
              />
              <span className="field-hint">
                Routes direct HTTP checks through a local proxy when set.
              </span>
            </label>
          </div>

          <label className="field-group">
            <span className="field-label">
              Offline local corpus directory
            </span>
            <input
              type="text"
              className="text-input mono"
              value={corpusDir}
              onChange={(e) => setCorpusDir(e.target.value)}
              placeholder="C:\Users\analyst\authorized-corpus"
            />
            <span className="field-hint">
              Folder of authorized local text, CSV, or JSON files scanned 100%
              offline.
            </span>
          </label>

          <label className="field-group">
            <span className="field-label">
              Custom .onion search or directory seed URLs
            </span>
            <textarea
              className="text-area mono"
              rows={3}
              value={onionSeedsText}
              onChange={(e) => setOnionSeedsText(e.target.value)}
              placeholder="http://exampleonionaddress.onion/search?q={query}"
            />
            <span className="field-hint">
              One URL per line. Queried over local Tor SOCKS5 when Tor mode is
              enabled.
            </span>
          </label>

          <div className="form-actions">
            <button type="submit" className="btn-primary-sm" disabled={saving}>
              {saving ? "Saving..." : "Save local config"}
            </button>
            {savedNotice && (
              <span className="saved-notice">Configuration saved</span>
            )}
            {saveError && (
              <span className="error-notice">{saveError}</span>
            )}
          </div>
        </form>

        <div className="env-section">
          <div className="env-head">
            <div>
              <h3 className="section-title">Local laptop environment</h3>
              <p className="muted-caption">
                Native sovereign engines are built in; detected Python OSS
                tools extend coverage locally.
              </p>
            </div>
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw
                size={14}
                strokeWidth={1.5}
                className={refreshing ? "spin-icon" : ""}
              />
              <span>Rescan</span>
            </button>
          </div>

          <div className="env-summary-row">
            <div className="env-stat">
              <span
                className={`run-dot ${
                  envStatus?.tor_socks_available ? "run-done" : "run-skipped"
                }`}
              />
              <span>
                Tor SOCKS5:{" "}
                <strong className="mono">
                  {envStatus?.tor_socks_available
                    ? envStatus.tor_exit_ip
                      ? `${envStatus.tor_endpoint ?? "Active"} · Exit ${envStatus.tor_exit_ip}`
                      : envStatus.tor_endpoint ?? "Active"
                    : "Not running locally"}
                </strong>
              </span>
            </div>
            <div className="env-stat">
              <span className="muted-label">Python:</span>
              <span className="mono muted-value">
                {envStatus?.python_path ?? "Not detected"}
              </span>
            </div>
            <div className="env-stat">
              <span className="muted-label">OSS tools:</span>
              <span className="mono tabular">
                {installedCount}/{envStatus?.sidecar_tools.length ?? 0} ready
              </span>
            </div>
          </div>

          {envStatus && envStatus.sidecar_tools.length > 0 ? (
            <div className="tools-table-wrap">
              <table className="tools-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Category</th>
                    <th>Mode</th>
                    <th>Status / install</th>
                  </tr>
                </thead>
                <tbody>
                  {envStatus.sidecar_tools.map((tool) => (
                    <tr key={tool.name}>
                      <td className="mono">{tool.name}</td>
                      <td>{tool.category}</td>
                      <td className="mono muted-value">
                        {tool.mode.replace(/_/g, " ")}
                      </td>
                      <td>
                        {tool.installed ? (
                          <span className="installed-tag">
                            <span className="run-dot run-done" />
                            Installed
                          </span>
                        ) : (
                          <code className="install-hint">
                            {tool.install_hint}
                          </code>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted-caption">
              Local TAUF backend is offline — start via{" "}
              <code className="inline-code">launch-tauf.vbs</code> or{" "}
              <code className="inline-code">npm start</code> to probe Tor and
              local Python OSS tools.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
