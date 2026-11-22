import { useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  GitFork,
  Globe,
  KeyRound,
  Landmark,
  MapPin,
  Phone,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  EnvStatus,
  GraphNode,
  IntelTab,
  NodeStatus,
  ToolRunStatus,
} from "../types";
import type {
  AccountRecord,
  ClassifiedIntel,
  OnionRecord,
} from "../lib/classify";
import { redactNodeLabel, redactText } from "../lib/redact";

interface FindingsStreamProps {
  intel: ClassifiedIntel;
  nodes: GraphNode[];
  toolRuns?: ToolRunStatus[];
  activeTab: IntelTab;
  selectedNodeId: string | null;
  redact: boolean;
  envStatus: EnvStatus | null;
  deepeningNodeId: string | null;
  onTabChange: (tab: IntelTab) => void;
  onSelectNode: (nodeId: string | null) => void;
  onDeepenNode: (nodeId: string) => void;
  onSetNodeStatus: (nodeId: string, status: NodeStatus) => void;
}

const TAB_DEFS: Array<{ id: IntelTab; label: string }> = [
  { id: "contacts", label: "Contacts" },
  { id: "accounts", label: "Accounts" },
  { id: "records", label: "Records" },
  { id: "darkweb", label: "Dark web" },
];

function getOnionCategoryTone(category: string): string {
  const c = category.toLowerCase();
  if (c.includes("leak") || c.includes("breach") || c.includes("paste") || c.includes("dox")) {
    return "cat-danger";
  }
  if (c.includes("market") || c.includes("vendor") || c.includes("forum")) {
    return "cat-warn";
  }
  if (c.includes("directory") || c.includes("wiki") || c.includes("news") || c.includes("archive")) {
    return "cat-info";
  }
  return "cat-neutral";
}

export function FindingsStream({
  intel,
  nodes,
  toolRuns = [],
  activeTab,
  selectedNodeId,
  redact,
  envStatus,
  deepeningNodeId,
  onTabChange,
  onSelectNode,
  onDeepenNode,
  onSetNodeStatus,
}: FindingsStreamProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedAccountKey, setExpandedAccountKey] = useState<string | null>(
    null
  );

  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  const selectedNodeTab = selectedNodeId
    ? intel.nodeToTab.get(selectedNodeId) ?? null
    : null;

  const handleCopy = (key: string, value: string) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur));
      }, 1600);
    });
  };

  const renderAccountCard = (acc: AccountRecord, isCollision = false) => {
    const isSelected = selectedNodeId === acc.nodeId;
    const isExpanded = expandedAccountKey === acc.key || isSelected;
    const isDismissed = acc.status === "dismissed";

    const metaBits: string[] = [];
    if (acc.location) metaBits.push(redactText(acc.location, redact));
    if (acc.org) metaBits.push(redactText(acc.org, redact));
    if (acc.timezone) metaBits.push(acc.timezone);

    return (
      <article
        key={acc.key}
        className={`intel-card account-card ${isSelected ? "is-selected" : ""} ${
          isDismissed ? "is-dismissed" : ""
        } ${isCollision ? "is-collision" : ""}`}
      >
        <div
          className="account-card-main"
          role="button"
          tabIndex={0}
          onClick={() => {
            onSelectNode(acc.nodeId);
            setExpandedAccountKey((prev) =>
              prev === acc.key ? null : acc.key
            );
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelectNode(acc.nodeId);
              setExpandedAccountKey((prev) =>
                prev === acc.key ? null : acc.key
              );
            }
          }}
        >
          <div className="account-head">
            <div className="account-id">
              <span className="account-platform">{acc.platform}</span>
              <span className="account-handle mono">
                {redactText(acc.handle, redact)}
              </span>
            </div>

            <div className="account-head-right">
              <span className={`match-pill tier-${acc.tier}`}>
                {acc.matchLabel}
              </span>
              {acc.url && (
                <a
                  href={acc.url}
                  target="_blank"
                  rel="noreferrer"
                  className="card-icon-btn"
                  onClick={(e) => e.stopPropagation()}
                  title="Open profile"
                  aria-label={`Open ${acc.platform} profile`}
                >
                  <ExternalLink size={13} strokeWidth={1.5} />
                </a>
              )}
            </div>
          </div>

          {acc.displayName && (
            <div className="account-display-name">
              {redactText(acc.displayName, redact)}
            </div>
          )}

          {acc.bio && (
            <p className="account-bio">{redactText(acc.bio, redact)}</p>
          )}

          {metaBits.length > 0 && (
            <div className="account-facts">
              <MapPin size={11} strokeWidth={1.5} aria-hidden="true" />
              <span>{metaBits.join(" · ")}</span>
            </div>
          )}

          {(acc.website || acc.skills) && (
            <div className="account-extras">
              {acc.website && (
                <span className="extra-chip mono">
                  <Globe size={11} strokeWidth={1.5} aria-hidden="true" />
                  <span>
                    {acc.website.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
                  </span>
                </span>
              )}
              {acc.skills && <span className="extra-chip">{acc.skills}</span>}
            </div>
          )}
        </div>

        {isExpanded && (
          <div className="card-quick-actions">
            {acc.matchReason && (
              <span className="quick-reason">
                {redactText(acc.matchReason, redact)}
              </span>
            )}
            <div className="quick-btn-row">
              <button
                type="button"
                className="btn-primary-xs"
                disabled={deepeningNodeId === acc.nodeId}
                onClick={() => onDeepenNode(acc.nodeId)}
              >
                <GitFork size={12} strokeWidth={1.5} />
                <span>
                  {deepeningNodeId === acc.nodeId ? "Deepening..." : "Deepen"}
                </span>
              </button>
              {acc.status === "unverified" && (
                <button
                  type="button"
                  className="btn-ghost-xs"
                  onClick={() => onSetNodeStatus(acc.nodeId, "confirmed")}
                >
                  <Check size={12} strokeWidth={1.5} />
                  <span>Confirm</span>
                </button>
              )}
              {acc.status !== "dismissed" ? (
                <button
                  type="button"
                  className="btn-ghost-xs"
                  onClick={() => onSetNodeStatus(acc.nodeId, "dismissed")}
                >
                  <X size={12} strokeWidth={1.5} />
                  <span>Dismiss</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-ghost-xs"
                  onClick={() => onSetNodeStatus(acc.nodeId, "unverified")}
                >
                  <RotateCcw size={12} strokeWidth={1.5} />
                  <span>Restore</span>
                </button>
              )}
            </div>
          </div>
        )}
      </article>
    );
  };

  const renderOnionCard = (hit: OnionRecord, isBroad = false) => {
    const isSelected = selectedNodeId === hit.nodeId;
    const isDismissed = hit.status === "dismissed";
    const extraSensitive = hit.onionHost ? [hit.onionHost] : [];
    const rawLoc =
      hit.whereFound ||
      hit.url?.replace(/^https?:\/\//i, "") ||
      hit.onionHost ||
      "";
    const redactedLoc = redactText(rawLoc, redact, extraSensitive);
    const slashIdx = redactedLoc.indexOf("/");
    const hostPart =
      slashIdx === -1 ? redactedLoc : redactedLoc.slice(0, slashIdx);
    const pathPart = slashIdx === -1 ? "" : redactedLoc.slice(slashIdx);
    const copyVal = hit.url
      ? redactText(hit.url, redact, extraSensitive)
      : redactedLoc;
    const precisionLabel =
      hit.matchPrecision === "exact"
        ? "Exact match"
        : hit.matchPrecision === "handle"
        ? "Handle match"
        : "Partial";

    return (
      <article
        key={hit.key}
        className={`intel-card onion-card ${isSelected ? "is-selected" : ""} ${
          isDismissed ? "is-dismissed" : ""
        } ${isBroad ? "is-collision" : ""}`}
        onClick={() => onSelectNode(hit.nodeId)}
      >
        <div className="onion-card-head">
          <h4 className="onion-title">
            {redactText(hit.title, redact, extraSensitive)}
          </h4>
          <div className="onion-head-pills">
            <span
              className={`onion-cat-pill ${getOnionCategoryTone(
                hit.siteCategory
              )}`}
            >
              {hit.siteCategory}
            </span>
            <span
              className={`onion-status-pill ${
                hit.pageStatus === "live_verified"
                  ? "is-live-page"
                  : "is-index-only"
              }`}
            >
              {hit.pageStatus === "live_verified"
                ? "Verified on live page"
                : "Index snippet"}
            </span>
          </div>
        </div>

        <div className="onion-meta-row">
          <span className="onion-field-label">Used for:</span>
          <span className="onion-field-val">
            {redactText(hit.sitePurpose, redact, extraSensitive)}
          </span>
        </div>

        {redactedLoc && (
          <div className="onion-meta-row onion-appears-row">
            <span className="onion-field-label">Appears at:</span>
            <div className="onion-loc-wrap">
              <span className="onion-loc-text mono">
                <span className="onion-host-part">{hostPart}</span>
                {pathPart && (
                  <span className="onion-path-part">{pathPart}</span>
                )}
              </span>
              <button
                type="button"
                className="card-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopy(`onion:${hit.key}`, copyVal);
                }}
                title="Copy .onion location"
                aria-label="Copy .onion location"
              >
                {copiedKey === `onion:${hit.key}` ? (
                  <Check size={13} strokeWidth={1.5} className="text-sage" />
                ) : (
                  <Copy size={13} strokeWidth={1.5} />
                )}
              </button>
            </div>
          </div>
        )}

        <div className="onion-meta-row onion-matched-row">
          <span className="onion-field-label">Matched on:</span>
          <div className="onion-match-badges">
            {hit.matchedIdentifier && (
              <span className="onion-id-badge mono">
                {redactText(hit.matchedIdentifier, redact, extraSensitive)}
              </span>
            )}
            <span
              className={`onion-prec-badge prec-${hit.matchPrecision}`}
            >
              {precisionLabel}
            </span>
            {hit.engine && (
              <span className="onion-engine-tag mono">{hit.engine}</span>
            )}
            <span className="email-conf mono tabular">
              {Math.round(hit.confidence * 100)}%
            </span>
          </div>
        </div>

        {hit.contextExcerpt && (
          <blockquote className="onion-excerpt-quote">
            {redactText(hit.contextExcerpt, redact, extraSensitive)}
          </blockquote>
        )}

        {isSelected && (
          <div
            className="card-quick-actions onion-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="quick-btn-row">
              {hit.status !== "confirmed" && (
                <button
                  type="button"
                  className="btn-ghost-xs"
                  onClick={() => onSetNodeStatus(hit.nodeId, "confirmed")}
                >
                  <Check size={12} strokeWidth={1.5} />
                  <span>Confirm</span>
                </button>
              )}
              {hit.status !== "dismissed" ? (
                <button
                  type="button"
                  className="btn-ghost-xs"
                  onClick={() => onSetNodeStatus(hit.nodeId, "dismissed")}
                >
                  <X size={12} strokeWidth={1.5} />
                  <span>Dismiss</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-ghost-xs"
                  onClick={() => onSetNodeStatus(hit.nodeId, "unverified")}
                >
                  <RotateCcw size={12} strokeWidth={1.5} />
                  <span>Restore</span>
                </button>
              )}
            </div>
          </div>
        )}
      </article>
    );
  };

  return (
    <section className="zone-findings" aria-label="Intelligence views">
      <div className="intel-tabs-header">
        <div
          className="intel-tab-bar"
          role="tablist"
          aria-label="Intelligence categories"
        >
          {TAB_DEFS.map((t) => {
            const count = intel.counts[t.id];
            const isAlert = t.id === "darkweb" && count > 0;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={activeTab === t.id}
                className={`intel-tab ${activeTab === t.id ? "is-active" : ""} ${
                  isAlert ? "has-alert" : ""
                }`}
                onClick={() => {
                  onSelectNode(null);
                  onTabChange(t.id);
                }}
              >
                <span>{t.label}</span>
                <span className="tab-count mono tabular">{count}</span>
              </button>
            );
          })}
        </div>

        {selectedNode && selectedNode.layer !== "seed" && (
          <div className="graph-focus-strip">
            <span className="focus-strip-label">
              Graph focus:{" "}
              <strong>
                {redactNodeLabel(
                  selectedNode.label,
                  selectedNode.kind,
                  redact
                )}
              </strong>
            </span>
            <div className="focus-strip-actions">
              {selectedNodeTab && selectedNodeTab !== activeTab && (
                <button
                  type="button"
                  className="focus-strip-btn"
                  onClick={() => onTabChange(selectedNodeTab)}
                >
                  View in{" "}
                  {TAB_DEFS.find((d) => d.id === selectedNodeTab)?.label}
                </button>
              )}
              <button
                type="button"
                className="focus-strip-clear"
                onClick={() => onSelectNode(null)}
                aria-label="Clear graph focus"
              >
                <X size={12} strokeWidth={1.5} />
                <span>Clear</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="findings-scroll">
        {/* ---------------------------------------------------------------- */}
        {/* TAB 1: CONTACTS — Emails & Phone Numbers                         */}
        {/* ---------------------------------------------------------------- */}
        {activeTab === "contacts" && (
          <div
            className="tab-pane"
            role="tabpanel"
            aria-label="Emails and phone numbers"
          >
            {/* Emails block */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">Email addresses</h3>
                <span className="mono muted-value tabular">
                  {intel.emails.length}
                </span>
              </div>

              {intel.emails.length > 0 ? (
                <div className="intel-stack">
                  {intel.emails.map((em) => {
                    const displayEmail = redactText(em.email, redact, [
                      em.email,
                    ]);
                    const isSelected = selectedNodeId === em.nodeId;
                    const metaParts: string[] = [];
                    if (em.timezone) metaParts.push(em.timezone);
                    if (em.pgpKey) {
                      metaParts.push(
                        `PGP ${redactText(em.pgpKey.slice(-8), redact)}`
                      );
                    }
                    if (em.serviceCount > 0) {
                      metaParts.push(
                        `${em.serviceCount} registered service${
                          em.serviceCount === 1 ? "" : "s"
                        }`
                      );
                    }

                    return (
                      <article
                        key={em.key}
                        className={`intel-card email-card ${
                          isSelected ? "is-selected" : ""
                        }`}
                        onClick={() => onSelectNode(em.nodeId)}
                      >
                        <div className="email-top-row">
                          <span className="email-address mono">
                            {displayEmail}
                          </span>
                          <button
                            type="button"
                            className="card-icon-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopy(`email:${em.key}`, displayEmail);
                            }}
                            title="Copy email"
                            aria-label="Copy email address"
                          >
                            {copiedKey === `email:${em.key}` ? (
                              <Check
                                size={13}
                                strokeWidth={1.5}
                                className="text-sage"
                              />
                            ) : (
                              <Copy size={13} strokeWidth={1.5} />
                            )}
                          </button>
                        </div>

                        <div className="email-badges-row">
                          <div className="badge-cluster">
                            {em.badges.map((badge) => (
                              <span key={badge} className="verify-pill">
                                {badge}
                              </span>
                            ))}
                          </div>
                          <span className="email-conf mono tabular">
                            {Math.round(em.confidence * 100)}%
                          </span>
                        </div>

                        {metaParts.length > 0 && (
                          <div className="email-meta-line">
                            {metaParts.join(" · ")}
                          </div>
                        )}

                        <div className="email-footer-row">
                          <button
                            type="button"
                            className="btn-ghost-xs"
                            disabled={deepeningNodeId === em.nodeId}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeepenNode(em.nodeId);
                            }}
                          >
                            <GitFork size={12} strokeWidth={1.5} />
                            <span>
                              {deepeningNodeId === em.nodeId
                                ? "Deepening..."
                                : "Deepen"}
                            </span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="block-empty">
                  No verified email addresses uncovered yet. Run Deep or Max
                  depth, or add an optional email context.
                </p>
              )}
            </div>

            {/* Phone numbers block */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">Phone numbers</h3>
                <span className="mono muted-value tabular">
                  {intel.phones.length}
                </span>
              </div>

              {intel.phones.length > 0 ? (
                <div className="intel-stack">
                  {intel.phones.map((ph) => {
                    const displayPhone = redactText(ph.phone, redact, [
                      ph.phone,
                    ]);
                    const isSelected = selectedNodeId === ph.nodeId;
                    return (
                      <article
                        key={ph.key}
                        className={`intel-card email-card ${
                          isSelected ? "is-selected" : ""
                        }`}
                        onClick={() => onSelectNode(ph.nodeId)}
                      >
                        <div className="email-top-row">
                          <span className="email-address mono doc-title">
                            <Phone size={13} strokeWidth={1.5} />
                            <span>{displayPhone}</span>
                          </span>
                          <button
                            type="button"
                            className="card-icon-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopy(`phone:${ph.key}`, displayPhone);
                            }}
                            title="Copy phone number"
                            aria-label="Copy phone number"
                          >
                            {copiedKey === `phone:${ph.key}` ? (
                              <Check
                                size={13}
                                strokeWidth={1.5}
                                className="text-sage"
                              />
                            ) : (
                              <Copy size={13} strokeWidth={1.5} />
                            )}
                          </button>
                        </div>

                        {ph.context && (
                          <div className="email-meta-line">
                            {redactText(ph.context, redact)}
                          </div>
                        )}

                        <div className="email-badges-row">
                          <div className="badge-cluster">
                            <span className="verify-pill">Public phone</span>
                            {ph.serviceCount > 0 && (
                              <span className="verify-pill">
                                {ph.serviceCount} ignorant hit
                                {ph.serviceCount === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                          <span className="email-conf mono tabular">
                            {Math.round(ph.confidence * 100)}%
                          </span>
                        </div>

                        <div className="email-footer-row">
                          <button
                            type="button"
                            className="btn-ghost-xs"
                            disabled={deepeningNodeId === ph.nodeId}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeepenNode(ph.nodeId);
                            }}
                          >
                            <GitFork size={12} strokeWidth={1.5} />
                            <span>
                              {deepeningNodeId === ph.nodeId
                                ? "Checking..."
                                : "Deepen with Ignorant"}
                            </span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="block-empty">
                  No publicly listed phone numbers found for this name yet.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* TAB 2: ACCOUNTS — All Verified Social & Web Profiles             */}
        {/* ---------------------------------------------------------------- */}
        {activeTab === "accounts" && (
          <div className="tab-pane" role="tabpanel" aria-label="Accounts">
            {intel.accounts.length > 0 ? (
              <div className="intel-stack">
                {intel.accounts.map((acc) => renderAccountCard(acc, false))}
              </div>
            ) : (
              <div className="tab-empty">
                <p className="empty-hint">
                  No verified social or web profiles confirmed yet. Profiles
                  across Instagram, LinkedIn, X, YouTube, GitHub, and other
                  platforms appear here once verified.
                </p>
              </div>
            )}

            {intel.collisionAccounts.length > 0 && (
              <details className="unverified-disclosure">
                <summary className="unverified-summary">
                  <ChevronRight
                    size={15}
                    strokeWidth={1.5}
                    className="disclosure-chevron"
                  />
                  <span>
                    Possible name collisions ({intel.collisionAccounts.length})
                  </span>
                </summary>
                <div className="intel-stack unverified-list">
                  {intel.collisionAccounts.map((acc) =>
                    renderAccountCard(acc, true)
                  )}
                </div>
              </details>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* TAB 3: RECORDS & SERVICES — 4 Clean Compact Blocks               */}
        {/* ---------------------------------------------------------------- */}
        {activeTab === "records" && (
          <div
            className="tab-pane"
            role="tabpanel"
            aria-label="Records and services"
          >
            {/* Block 1: Legal, Corporate & Academic Public Records */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">
                  Legal, corporate &amp; academic records
                </h3>
                <span className="mono muted-value tabular">
                  {intel.publicRecords.length}
                </span>
              </div>

              {intel.publicRecords.length > 0 ? (
                <div className="compact-rows">
                  {intel.publicRecords.map((rec) => (
                    <div
                      key={rec.key}
                      className={`compact-row ${
                        selectedNodeId === rec.nodeId ? "is-selected" : ""
                      }`}
                      onClick={() => onSelectNode(rec.nodeId)}
                    >
                      <div className="compact-row-head">
                        <span className="compact-row-title doc-title">
                          <Landmark size={13} strokeWidth={1.5} />
                          <span>{redactText(rec.title, redact)}</span>
                        </span>
                        {rec.url && (
                          <a
                            href={rec.url}
                            target="_blank"
                            rel="noreferrer"
                            className="card-icon-btn"
                            onClick={(e) => e.stopPropagation()}
                            title="Open public record"
                          >
                            <ExternalLink size={12} strokeWidth={1.5} />
                          </a>
                        )}
                      </div>
                      <div className="compact-row-meta">
                        <span>{rec.recordType}</span>
                        {rec.sourceDomain && (
                          <span className="mono">{rec.sourceDomain}</span>
                        )}
                      </div>
                      {rec.excerpt && (
                        <p className="compact-excerpt">
                          {redactText(rec.excerpt, redact)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="block-empty">
                  No corporate filings, court records, patents, or publications
                  matched yet.
                </p>
              )}
            </div>

            {/* Block 2: Registered Platforms (holehe / ignorant) */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">Registered services</h3>
                <span className="mono muted-value tabular">
                  {intel.registeredServices.length}
                </span>
              </div>

              {intel.registeredServices.length > 0 ? (
                <div className="service-chip-grid">
                  {intel.registeredServices.map((svc) => (
                    <button
                      key={svc.key}
                      type="button"
                      className={`service-chip ${
                        selectedNodeId === svc.nodeId ? "is-selected" : ""
                      }`}
                      onClick={() => onSelectNode(svc.nodeId)}
                      title={`Confirmed via ${svc.source}`}
                    >
                      <span className="run-dot run-done" />
                      <span>{svc.serviceName}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="block-empty">
                  Holehe and Ignorant populate registered services once an email
                  or phone number is discovered.
                </p>
              )}
            </div>

            {/* Block 3: Domains, DNS & TLS */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">Domains, DNS &amp; TLS</h3>
                <span className="mono muted-value tabular">
                  {intel.domains.length}
                </span>
              </div>

              {intel.domains.length > 0 ? (
                <div className="compact-rows">
                  {intel.domains.map((dom) => (
                    <div
                      key={dom.key}
                      className={`compact-row ${
                        selectedNodeId === dom.nodeId ? "is-selected" : ""
                      }`}
                      onClick={() => onSelectNode(dom.nodeId)}
                    >
                      <div className="compact-row-head">
                        <span className="compact-row-title mono">
                          {dom.domain}
                        </span>
                        {dom.dmarcMissing ? (
                          <span className="posture-warn">DMARC missing</span>
                        ) : (
                          <span className="posture-ok">DMARC set</span>
                        )}
                      </div>
                      <div className="compact-row-meta">
                        {dom.mailProvider && <span>{dom.mailProvider}</span>}
                        {dom.spf && (
                          <span className="mono">{dom.spf.slice(0, 32)}</span>
                        )}
                        {dom.tlsOrg && <span>TLS: {dom.tlsOrg}</span>}
                        {dom.tlsSans && (
                          <span className="mono">SANs: {dom.tlsSans}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="block-empty">
                  No personal or corporate domains inspected yet.
                </p>
              )}
            </div>

            {/* Block 4: Public Documents (doc-meta) */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">Public PDFs &amp; documents</h3>
                <span className="mono muted-value tabular">
                  {intel.documents.length}
                </span>
              </div>

              {intel.documents.length > 0 ? (
                <div className="compact-rows">
                  {intel.documents.map((doc) => (
                    <div
                      key={doc.key}
                      className={`compact-row ${
                        selectedNodeId === doc.nodeId ? "is-selected" : ""
                      }`}
                      onClick={() => onSelectNode(doc.nodeId)}
                    >
                      <div className="compact-row-head">
                        <span className="compact-row-title doc-title">
                          <FileText size={13} strokeWidth={1.5} />
                          <span>{doc.filename}</span>
                        </span>
                        {doc.url && (
                          <a
                            href={doc.url}
                            target="_blank"
                            rel="noreferrer"
                            className="card-icon-btn"
                            onClick={(e) => e.stopPropagation()}
                            title="Open document"
                          >
                            <ExternalLink size={12} strokeWidth={1.5} />
                          </a>
                        )}
                      </div>
                      <div className="compact-row-meta">
                        {doc.author && (
                          <span>Author: {redactText(doc.author, redact)}</span>
                        )}
                        {doc.creator && <span>Software: {doc.creator}</span>}
                        {doc.leakedPathUser && (
                          <span className="posture-warn">
                            OS user: {redactText(doc.leakedPathUser, redact)}
                          </span>
                        )}
                        {doc.extractedContacts && (
                          <span className="mono">
                            {redactText(doc.extractedContacts, redact)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="block-empty">
                  No public PDFs discovered for this target yet.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* TAB 4: DARK WEB & LEAKS — 4 Clean Compact Blocks                 */}
        {/* ---------------------------------------------------------------- */}
        {activeTab === "darkweb" && (
          <div
            className="tab-pane"
            role="tabpanel"
            aria-label="Dark web and leaks"
          >
            {/* Block 1: Tor Hidden Services (.onion) */}
            {(() => {
              const torRun = toolRuns.find(
                (t) => t.tool === "tor-socks5h" || t.tool === "local_tor_socks5"
              );
              const torDetail = torRun?.detail?.trim() || null;
              return (
                <div className="intel-block">
                  <div className="block-head">
                    <h3 className="block-title">
                      Tor hidden services (.onion)
                    </h3>
                    <div className="block-head-right">
                      <span
                        className={`tor-mini-badge mono ${
                          envStatus?.tor_socks_available ? "is-live" : ""
                        }`}
                      >
                        {envStatus?.tor_socks_available
                          ? envStatus.tor_exit_ip
                            ? `Exit ${envStatus.tor_exit_ip}`
                            : "Tor live"
                          : "Tor offline"}
                      </span>
                      <span className="mono muted-value tabular">
                        {intel.onionHits.length}
                      </span>
                    </div>
                  </div>

                  {intel.onionHits.length > 0 ? (
                    <>
                      {torDetail && (
                        <p className="onion-telemetry-caption">{torDetail}</p>
                      )}
                      <div className="intel-stack">
                        {intel.onionHits.map((hit) =>
                          renderOnionCard(hit, false)
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="block-empty">
                      {intel.broadOnionHits.length > 0
                        ? torDetail
                          ? `${torDetail} — inspect possible broad mentions below.`
                          : "0 exact or handle-matched .onion hits — inspect possible broad mentions below."
                        : torDetail ||
                          "0 .onion mentions across configured Tor search engines."}
                    </p>
                  )}

                  {intel.broadOnionHits.length > 0 && (
                    <details className="unverified-disclosure">
                      <summary className="unverified-summary">
                        <ChevronRight
                          size={15}
                          strokeWidth={1.5}
                          className="disclosure-chevron"
                        />
                        <span>
                          Possible broad .onion mentions (
                          {intel.broadOnionHits.length})
                        </span>
                      </summary>
                      <div className="intel-stack unverified-list">
                        {intel.broadOnionHits.map((hit) =>
                          renderOnionCard(hit, true)
                        )}
                      </div>
                    </details>
                  )}
                </div>
              );
            })()}

            {/* Block 2: Local Breach & Paste Corpus */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">Local breach &amp; paste corpus</h3>
                <span className="mono muted-value tabular">
                  {intel.corpusHits.length}
                </span>
              </div>

              {intel.corpusHits.length > 0 ? (
                <div className="compact-rows">
                  {intel.corpusHits.map((hit) => (
                    <div
                      key={hit.key}
                      className={`compact-row alert-row ${
                        selectedNodeId === hit.nodeId ? "is-selected" : ""
                      }`}
                      onClick={() => onSelectNode(hit.nodeId)}
                    >
                      <div className="compact-row-head">
                        <span className="compact-row-title doc-title">
                          <ShieldAlert
                            size={13}
                            strokeWidth={1.5}
                            className="text-crimson"
                          />
                          <span>
                            {redactText(
                              hit.file || hit.title,
                              redact,
                              hit.sensitiveFields
                            )}
                          </span>
                        </span>
                        {hit.line && (
                          <span className="mono muted-value tabular">
                            L{hit.line}
                          </span>
                        )}
                      </div>
                      {hit.detail && (
                        <p className="compact-excerpt">
                          {redactText(hit.detail, redact, hit.sensitiveFields)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="block-empty">
                  Local corpus armed — drop authorized .txt/.csv/.json archives
                  into{" "}
                  <code className="inline-code">
                    %LOCALAPPDATA%\TAUF\corpus
                  </code>
                </p>
              )}
            </div>

            {/* Block 3: Public Paste Mentions */}
            {intel.pasteHits.length > 0 && (
              <div className="intel-block">
                <div className="block-head">
                  <h3 className="block-title">Public paste mentions</h3>
                  <span className="mono muted-value tabular">
                    {intel.pasteHits.length}
                  </span>
                </div>
                <div className="compact-rows">
                  {intel.pasteHits.map((paste) => (
                    <div
                      key={paste.key}
                      className={`compact-row alert-row ${
                        selectedNodeId === paste.nodeId ? "is-selected" : ""
                      }`}
                      onClick={() => onSelectNode(paste.nodeId)}
                    >
                      <div className="compact-row-head">
                        <span className="compact-row-title">
                          {redactText(paste.title, redact)}
                        </span>
                        {paste.url && (
                          <a
                            href={paste.url}
                            target="_blank"
                            rel="noreferrer"
                            className="card-icon-btn"
                            onClick={(e) => e.stopPropagation()}
                            title="Open paste"
                          >
                            <ExternalLink size={12} strokeWidth={1.5} />
                          </a>
                        )}
                      </div>
                      {paste.host && (
                        <div className="compact-row-meta mono">{paste.host}</div>
                      )}
                      {paste.excerpt && (
                        <p className="compact-excerpt">
                          {redactText(paste.excerpt, redact)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Block 4: Cryptographic Exposure (PGP & SSH) */}
            <div className="intel-block">
              <div className="block-head">
                <h3 className="block-title">Cryptographic exposure</h3>
                <span className="mono muted-value tabular">
                  {intel.cryptoKeys.length}
                </span>
              </div>

              {intel.cryptoKeys.length > 0 ? (
                <div className="compact-rows">
                  {intel.cryptoKeys.map((ck) => (
                    <div
                      key={ck.key}
                      className={`compact-row ${
                        selectedNodeId === ck.nodeId ? "is-selected" : ""
                      }`}
                      onClick={() => onSelectNode(ck.nodeId)}
                    >
                      <div className="compact-row-head">
                        <span className="compact-row-title doc-title mono">
                          <KeyRound size={13} strokeWidth={1.5} />
                          <span>
                            {redactText(ck.fingerprint, redact, [
                              ck.fingerprint,
                            ])}
                          </span>
                        </span>
                        <span className="verify-pill">{ck.keyType}</span>
                      </div>
                      {(ck.uidOrProfile || ck.algorithm) && (
                        <div className="compact-row-meta">
                          {ck.uidOrProfile && (
                            <span>{redactText(ck.uidOrProfile, redact)}</span>
                          )}
                          {ck.algorithm && (
                            <span className="mono">{ck.algorithm}</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="block-empty">
                  No public PGP or SSH keys found for this identity yet.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
