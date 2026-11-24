import type { Finding, GraphEdge, GraphNode, IntelTab } from "../types";

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  bull: "•",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeHtmlEntitiesOnce(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      const mapped = NAMED_HTML_ENTITIES[body.toLowerCase()];
      return mapped !== undefined ? mapped : match;
    }
  );
}

const ASSET_CDN_URL_RE =
  /https?:\/\/[^\s,;|"'<>]*(?:githubassets\.com|githubusercontent\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com)[^\s,;|"'<>]*/gi;

export function isAssetCdnUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /(?:githubassets\.com|githubusercontent\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com)/i.test(
    url
  );
}

export function sanitizeDisplayText(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  let out = String(raw);
  // Strip embedded <style>/<script> blocks and Startpage/Emotion inline CSS chunks
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  out = out.replace(/@media\s*[^{]*\{[\s\S]*?\}\s*\}/gi, " ");
  out = out.replace(/\.css-[\w-]+\s*\{[^}]*\}/gi, " ");
  out = out.replace(/(?:^|\s)[.#][a-zA-Z_][\w:-]*\s*\{[^}]*\}/g, " ");
  out = out.replace(/<[^>]+>/g, " ");
  // Decode HTML entities (2 passes handles double-encoded &amp;#39; / &amp;middot;)
  out = decodeHtmlEntitiesOnce(decodeHtmlEntitiesOnce(out));
  // Strip leaked asset-CDN URLs (e.g. github.githubassets.com, avatars.githubusercontent.com)
  out = out.replace(ASSET_CDN_URL_RE, "");
  out = out.replace(/\bLinks:\s*(?:[,;|·•]\s*)*(?=$|[·|;])/gi, "");
  out = out.replace(/,\s*(?:,\s*)+/g, ", ");
  out = out.replace(/\bLinks:\s*,\s*/gi, "Links: ");
  out = out.replace(/(?:^|\s)[,;|·•]\s*$/g, "");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 0 ? out : null;
}

export interface EmailRecord {
  key: string;
  nodeId: string;
  email: string;
  confidence: number;
  status: GraphNode["status"];
  badges: string[];
  sources: string[];
  timezone: string | null;
  pgpKey: string | null;
  serviceCount: number;
  matchReason: string | null;
}

export interface PhoneRecord {
  key: string;
  nodeId: string;
  phone: string;
  confidence: number;
  status: GraphNode["status"];
  context: string | null;
  sources: string[];
  serviceCount: number;
}

export interface AccountRecord {
  key: string;
  nodeId: string;
  platform: string;
  handle: string;
  url: string | null;
  confidence: number;
  status: GraphNode["status"];
  tier: "verified" | "probable" | "collision";
  matchLabel: string;
  matchReason: string | null;
  displayName: string | null;
  bio: string | null;
  location: string | null;
  org: string | null;
  timezone: string | null;
  website: string | null;
  skills: string | null;
  sources: string[];
}

export interface ServicePlatformRecord {
  key: string;
  nodeId: string;
  serviceName: string;
  source: string;
  anchor: string | null;
  confidence: number;
  url: string | null;
}

export interface PublicRecordItem {
  key: string;
  nodeId: string;
  title: string;
  recordType: string;
  sourceDomain: string | null;
  excerpt: string | null;
  url: string | null;
  confidence: number;
}

export interface DomainInfraRecord {
  key: string;
  nodeId: string;
  domain: string;
  mailProvider: string | null;
  spf: string | null;
  dmarc: string | null;
  dmarcMissing: boolean;
  tlsOrg: string | null;
  tlsSans: string | null;
  confidence: number;
}

export interface DocumentRecord {
  key: string;
  nodeId: string;
  filename: string;
  title: string | null;
  bio: string | null;
  author: string | null;
  creator: string | null;
  leakedPathUser: string | null;
  extractedContacts: string | null;
  url: string | null;
  confidence: number;
}

export type OnionMatchPrecision = "exact" | "handle" | "partial";
export type OnionPageStatus = "live_verified" | "index_only";

export interface OnionRecord {
  key: string;
  nodeId: string;
  title: string;
  onionHost: string | null;
  url: string | null;
  excerpt: string | null;
  siteCategory: string;
  sitePurpose: string;
  whereFound: string | null;
  matchedIdentifier: string | null;
  matchPrecision: OnionMatchPrecision;
  pageStatus: OnionPageStatus;
  engine: string | null;
  contextExcerpt: string | null;
  bio: string | null;
  status: GraphNode["status"];
  confidence: number;
  sources: string[];
}

export interface CorpusBreachRecord {
  key: string;
  nodeId: string;
  title: string;
  file: string | null;
  line: string | null;
  severity: string;
  detail: string | null;
  sensitiveFields: string[];
  confidence: number;
}

export interface PasteMentionRecord {
  key: string;
  nodeId: string;
  title: string;
  host: string | null;
  excerpt: string | null;
  url: string | null;
  confidence: number;
}

export interface CryptoKeyRecord {
  key: string;
  nodeId: string;
  keyType: "PGP" | "SSH";
  fingerprint: string;
  uidOrProfile: string | null;
  algorithm: string | null;
  confidence: number;
}

export interface ClassifiedIntel {
  emails: EmailRecord[];
  phones: PhoneRecord[];
  accounts: AccountRecord[];
  collisionAccounts: AccountRecord[];
  registeredServices: ServicePlatformRecord[];
  publicRecords: PublicRecordItem[];
  domains: DomainInfraRecord[];
  documents: DocumentRecord[];
  onionHits: OnionRecord[];
  broadOnionHits: OnionRecord[];
  corpusHits: CorpusBreachRecord[];
  pasteHits: PasteMentionRecord[];
  cryptoKeys: CryptoKeyRecord[];
  counts: Record<IntelTab, number>;
  tabNodeIds: Record<IntelTab, Set<string>>;
  nodeToTab: Map<string, IntelTab>;
}

function isRealEmailNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  const idLower = node.id.toLowerCase();
  if (kind === "email" || idLower.startsWith("email:")) {
    return EMAIL_SHAPE_RE.test(node.label.trim());
  }
  return false;
}

function isRealPhoneNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  const idLower = node.id.toLowerCase();
  if (kind === "phone" || idLower.startsWith("phone:")) {
    const digits = node.label.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 16;
  }
  return false;
}

function isServiceRegistrationNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  if (kind === "service" || kind === "registered_service") return true;
  if (node.metadata?.service_type === "registered_service") return true;
  if (node.metadata?.service_name && kind !== "email" && kind !== "phone") {
    return true;
  }
  const hasRegTool = node.sources.some((s) => {
    const sl = s.toLowerCase();
    return sl.includes("holehe") || sl.includes("ignorant");
  });
  if (
    hasRegTool &&
    kind !== "email" &&
    kind !== "phone" &&
    !node.sources.some((s) =>
      [
        "native_wmn",
        "wmn",
        "maigret",
        "sherlock",
        "raw_git_html",
        "git_raw",
        "socid",
        "web_dork",
        "social",
      ].some((p) => s.toLowerCase().includes(p))
    )
  ) {
    return true;
  }
  return false;
}

function isPublicRecordNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  return (
    kind === "record" ||
    kind === "org" ||
    kind === "organization" ||
    kind === "corporate" ||
    kind === "legal" ||
    kind === "court" ||
    kind === "patent" ||
    kind === "academic" ||
    kind === "publication" ||
    kind === "filing"
  );
}

function isDomainOrCertNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  return (
    kind === "domain" ||
    kind === "certificate" ||
    kind === "tls" ||
    kind === "dns"
  );
}

function isDocumentNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  return kind === "document" || kind === "pdf" || kind === "doc";
}

const GIST_ID_PATH_RE =
  /gist\.github\.com\/[^/?#]+\/[0-9a-f]{12,40}(?:[/?#]|$)/i;

function isPasteNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  if (kind === "paste" || kind === "paste_mention") return true;
  if (kind === "account") return false;
  const u = (node.url || "").toLowerCase();
  if (u.includes("gist.github.com")) {
    return GIST_ID_PATH_RE.test(u);
  }
  return (
    u.includes("pastebin.com") ||
    u.includes("rentry.co") ||
    u.includes("paste.ee") ||
    u.includes("dpaste") ||
    u.includes("justpaste.it") ||
    u.includes("ghostbin.me") ||
    u.includes("controlc.com")
  );
}

function isOnionNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  return (
    kind === "onion" ||
    kind === "darkweb" ||
    kind === "tor_mention" ||
    Boolean(node.metadata?.onion_host) ||
    (node.url || "").toLowerCase().includes(".onion")
  );
}

function isCorpusBreachNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  return (
    kind === "breach" ||
    kind === "corpus_hit" ||
    kind === "corpus" ||
    kind === "leak" ||
    node.sources.some((s) => {
      const sl = s.toLowerCase();
      return sl.includes("corpus") || sl.includes("h8mail");
    })
  );
}

function isCryptoKeyNode(node: GraphNode): boolean {
  const kind = node.kind.toLowerCase();
  return (
    kind === "pgp" ||
    kind === "pgp_key" ||
    kind === "gpg_key" ||
    kind === "gpg" ||
    kind === "ssh_key" ||
    kind === "ssh"
  );
}

function isAccountNode(node: GraphNode): boolean {
  if (node.layer === "seed") return false;
  if (
    isRealEmailNode(node) ||
    isRealPhoneNode(node) ||
    isServiceRegistrationNode(node) ||
    isPublicRecordNode(node) ||
    isDomainOrCertNode(node) ||
    isDocumentNode(node) ||
    isPasteNode(node) ||
    isOnionNode(node) ||
    isCorpusBreachNode(node) ||
    isCryptoKeyNode(node)
  ) {
    return false;
  }
  const kind = node.kind.toLowerCase();
  return (
    kind === "account" ||
    kind === "handle" ||
    kind === "profile" ||
    kind === "code" ||
    kind === "social" ||
    node.layer === "surface" ||
    node.layer === "deep"
  );
}

function extractDomainFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function parsePlatformAndHandle(node: GraphNode): {
  platform: string;
  handle: string;
} {
  const metaPlatform = node.metadata?.platform?.trim();
  const metaHandle =
    node.metadata?.handle?.trim() || node.metadata?.username?.trim();
  if (metaPlatform && metaHandle) {
    return {
      platform: metaPlatform,
      handle: metaHandle.startsWith("@") ? metaHandle : `@${metaHandle}`,
    };
  }

  const label = node.label.trim();

  const dotParts = label.split(/\s*[·|:]\s*/);
  if (dotParts.length >= 2 && dotParts[0] && dotParts[1]) {
    const plat = dotParts[0].trim();
    const rawH = dotParts.slice(1).join(" ").trim();
    return {
      platform: plat,
      handle: rawH.startsWith("@") ? rawH : `@${rawH}`,
    };
  }

  const parenMatch = label.match(/^([^(]+?)\s*\(([^)]+)\)$/);
  if (parenMatch) {
    const plat = parenMatch[1].trim();
    const rawH = parenMatch[2].trim();
    return {
      platform: plat,
      handle: rawH.startsWith("@") ? rawH : `@${rawH}`,
    };
  }

  const slashMatch = label.match(/^([a-z0-9.-]+)\/([^/?#]+)/i);
  if (slashMatch) {
    const host = slashMatch[1]
      .replace(/^www\./i, "")
      .replace(/\.(com|org|io|net|dev)$/i, "");
    const plat = host.charAt(0).toUpperCase() + host.slice(1);
    const rawH = slashMatch[2].replace(/^@/, "");
    return { platform: plat, handle: `@${rawH}` };
  }

  if (node.url) {
    try {
      const parsed = new URL(node.url);
      const host = parsed.hostname.replace(/^www\./i, "");
      const platBase = host.split(".")[0] || host;
      const plat = platBase.charAt(0).toUpperCase() + platBase.slice(1);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const seg =
        segments[0] === "in" && segments[1]
          ? segments[1]
          : segments[0] || label;
      const cleanSeg = seg.startsWith("@") ? seg : `@${seg}`;
      return { platform: metaPlatform || plat, handle: cleanSeg };
    } catch {
      // fall through
    }
  }

  return {
    platform: metaPlatform || (node.kind === "handle" ? "Handle" : "Profile"),
    handle: label,
  };
}

function buildEmailBadges(node: GraphNode, edges: GraphEdge[]): string[] {
  const badges = new Set<string>();
  const srcs = node.sources.map((s) => s.toLowerCase());
  const reason = (node.metadata?.match_reason || "").toLowerCase();

  if (
    srcs.some((s) => s.includes("git") || s.includes("patch")) ||
    reason.includes("commit") ||
    edges.some(
      (e) =>
        (e.target === node.id || e.source === node.id) &&
        e.relation.toLowerCase().includes("commit")
    )
  ) {
    badges.add("Git Commit");
  }
  if (
    srcs.some((s) => s.includes("hkp") || s.includes("pgp") || s.includes("gpg")) ||
    reason.includes("pgp") ||
    reason.includes("gpg")
  ) {
    badges.add("OpenPGP");
  }
  if (
    node.metadata?.gravatar_head?.toLowerCase().includes("200") ||
    node.metadata?.gravatar?.toLowerCase().includes("confirmed") ||
    srcs.some((s) => s.includes("gravatar"))
  ) {
    badges.add("Gravatar Confirmed");
  }
  if (
    srcs.some((s) => s.includes("web") || s.includes("dork") || s.includes("contact")) ||
    reason.includes("public")
  ) {
    badges.add("Public Web");
  }
  if (srcs.some((s) => s.includes("doc") || s.includes("pdf"))) {
    badges.add("PDF Metadata");
  }
  if (srcs.some((s) => s.includes("operator") || s.includes("seed"))) {
    badges.add("Provided");
  }
  if (badges.size === 0 && srcs.some((s) => s.includes("dns") || s.includes("mx"))) {
    badges.add("MX Verified");
  }
  if (badges.size === 0) {
    badges.add(node.status === "confirmed" ? "Verified" : "Discovered");
  }

  return Array.from(badges).slice(0, 4);
}

function normalizeAccountPlatformKey(platform: string): string {
  const clean = platform.trim().toLowerCase();
  if (
    clean === "twitter" ||
    clean === "x (twitter)" ||
    clean === "x / twitter" ||
    clean === "x/twitter"
  ) {
    return "x";
  }
  return clean;
}

function formatWhereFound(url: string | null, host: string | null): string | null {
  if (url) {
    try {
      const parsed = new URL(url);
      const pathPart = parsed.pathname || "/";
      const searchPart = parsed.search || "";
      return `${parsed.hostname}${pathPart}${searchPart}`;
    } catch {
      const stripped = url.replace(/^https?:\/\//i, "").trim();
      if (stripped) return stripped;
    }
  }
  if (host) return `${host}/`;
  return null;
}

function inferOnionCategory(
  title: string,
  host: string | null,
  excerpt: string | null
): string {
  const blob = `${title} ${host || ""} ${excerpt || ""}`.toLowerCase();
  if (/\b(leak|breach|dump|combo|stealer|database|sql)\b/.test(blob)) {
    return "Leak / Breach Archive";
  }
  if (/\b(paste|dox|rentry|ghostbin|pastebin)\b/.test(blob)) {
    return "Paste / Dox Board";
  }
  if (/\b(forum|thread|board|discuss|dread|chan)\b/.test(blob)) {
    return "Darknet Forum / Discussion";
  }
  if (/\b(market|vendor|shop|escrow|store)\b/.test(blob)) {
    return "Hidden Marketplace / Vendor";
  }
  if (/\b(wiki|directory|hidden service|links|catalog|index)\b/.test(blob)) {
    return "Hidden Service Directory / Wiki";
  }
  if (/\b(news|whistle|press|archive|library|mirror)\b/.test(blob)) {
    return "News / Whistleblower / Archive";
  }
  if (/\b(search|ahmia|onionland|torch|haystak)\b/.test(blob)) {
    return "Search / Aggregator Mirror";
  }
  return "Unclassified Hidden Service";
}

function inferOnionPurpose(category: string): string {
  switch (category) {
    case "Leak / Breach Archive":
      return "Hosts or indexes leaked database dumps, breached records, or exposed identifier lists.";
    case "Paste / Dox Board":
      return "Public darknet paste service or dox board for posting raw text dumps and identifiers.";
    case "Darknet Forum / Discussion":
      return "Onion discussion forum or message board where users post threads and commentary.";
    case "Hidden Marketplace / Vendor":
      return "Tor hidden marketplace or vendor storefront listing goods or services.";
    case "Hidden Service Directory / Wiki":
      return "Directory or hidden wiki cataloging Tor .onion service links and descriptions.";
    case "News / Whistleblower / Archive":
      return "Hidden whistleblower drop, news mirror, or document archive hosted on Tor.";
    case "Search / Aggregator Mirror":
      return "Tor hidden-service search engine or darknet index aggregator.";
    default:
      return "Tor hidden service page referencing the matched identifier.";
  }
}

function inferOnionPrecision(
  meta: Record<string, string> | undefined,
  status: GraphNode["status"],
  confidence: number
): OnionMatchPrecision {
  const rawPrec = (meta?.match_precision || "").trim().toLowerCase();
  if (rawPrec === "exact" || rawPrec === "handle" || rawPrec === "partial") {
    return rawPrec;
  }
  const rawTier = (meta?.match_tier || "").trim().toLowerCase();
  if (rawTier === "verified") return "exact";
  if (rawTier === "probable") return "handle";
  if (rawTier === "collision") return "partial";
  if (status === "confirmed" || confidence >= 0.78) return "exact";
  if (confidence >= 0.52) return "handle";
  return "partial";
}

function inferOnionEngine(
  meta: Record<string, string> | undefined,
  sources: string[]
): string | null {
  const explicit = meta?.engine?.trim();
  if (explicit) return explicit;
  const joined = sources.join(" ").toLowerCase();
  if (joined.includes("onionsearch")) return "onionsearch";
  if (joined.includes("ahmia")) return "Ahmia v3";
  if (joined.includes("onionland")) return "OnionLand v3";
  if (joined.includes("tor-socks5h") || joined.includes("tor_socks")) {
    return "Tor .onion index";
  }
  return sources[0] || null;
}

function precisionRank(p: OnionMatchPrecision): number {
  if (p === "exact") return 3;
  if (p === "handle") return 2;
  return 1;
}

function normalizeRecordType(node: GraphNode): string {
  const explicit = sanitizeDisplayText(node.metadata?.record_type);
  const canonical = new Set([
    "Corporate Filing",
    "Legal / Court Record",
    "Academic Publication",
    "Public Web Record",
    "Media / Talk",
    "Personal / Company Website",
    "Academic & Public Document",
  ]);
  if (explicit && canonical.has(explicit)) {
    return explicit;
  }

  const probe = [
    explicit,
    node.metadata?.category,
    node.sublabel,
    node.kind,
    node.url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /\b(corporate|filing|director|llp|cin|din|annual return|mgt-7|zaubacorp|falconebiz|tofler|opencorporates|companieshouse|thecompanycheck)\b/.test(
      probe
    ) ||
    node.kind.toLowerCase() === "org" ||
    node.kind.toLowerCase() === "organization"
  ) {
    return "Corporate Filing";
  }
  if (
    /\b(legal|court|judgment|docket|tribunal|gazette|indiankanoon|courtlistener|patent)\b/.test(
      probe
    )
  ) {
    return "Legal / Court Record";
  }
  if (
    /\b(academic|publication|arxiv|thesis|researchgate|scholar|paper)\b/.test(
      probe
    )
  ) {
    return "Academic Publication";
  }
  if (/\b(media|talk|video|youtube|interview|podcast|keynote)\b/.test(probe)) {
    return "Media / Talk";
  }
  if (
    /\b(personal\s*\/\s*company\s*website|website|portfolio|homepage)\b/.test(
      probe
    )
  ) {
    return "Personal / Company Website";
  }
  if (explicit) return explicit;
  return "Public Web Record";
}

function cleanServiceName(raw: string): string {
  return raw
    .replace(/^(holehe|ignorant)\s*[:·-]\s*/i, "")
    .replace(/\s*\(registered.*\)$/i, "")
    .replace(/\s+registered$/i, "")
    .trim();
}

export function classifyIntel(
  nodes: GraphNode[],
  edges: GraphEdge[],
  findings: Finding[]
): ClassifiedIntel {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const findingsByNode = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = findingsByNode.get(f.node_id) ?? [];
    list.push(f);
    findingsByNode.set(f.node_id, list);
  }

  const tabNodeIds: Record<IntelTab, Set<string>> = {
    contacts: new Set<string>(),
    accounts: new Set<string>(),
    records: new Set<string>(),
    darkweb: new Set<string>(),
  };
  const nodeToTab = new Map<string, IntelTab>();

  // 1. Registered services (holehe / ignorant)
  const serviceMap = new Map<string, ServicePlatformRecord>();
  const serviceCountByAnchor = new Map<string, number>();

  for (const node of nodes) {
    if (node.status === "dismissed") continue;
    if (!isServiceRegistrationNode(node)) continue;

    const rawName =
      node.metadata?.service_name ||
      node.metadata?.platform ||
      cleanServiceName(node.label);
    const key = rawName.toLowerCase();
    if (!key) continue;

    const anchor =
      node.metadata?.email ||
      node.metadata?.phone ||
      node.metadata?.anchor ||
      null;
    if (anchor) {
      const ak = anchor.toLowerCase();
      serviceCountByAnchor.set(ak, (serviceCountByAnchor.get(ak) ?? 0) + 1);
    }

    const src =
      node.sources.find((s) => s.toLowerCase().includes("holehe")) ||
      node.sources.find((s) => s.toLowerCase().includes("ignorant")) ||
      node.sources[0] ||
      "service";

    if (!serviceMap.has(key)) {
      serviceMap.set(key, {
        key,
        nodeId: node.id,
        serviceName: rawName,
        source: src,
        anchor,
        confidence: node.confidence,
        url: node.url,
      });
    }
    tabNodeIds.records.add(node.id);
    nodeToTab.set(node.id, "records");
  }

  for (const f of findings) {
    const isHoleheIgnorant =
      f.category === "service" ||
      f.sources.some((s) => {
        const sl = s.toLowerCase();
        return sl.includes("holehe") || sl.includes("ignorant");
      });
    if (!isHoleheIgnorant) continue;
    const linked = nodeById.get(f.node_id);
    if (linked?.status === "dismissed") continue;
    if (linked && isServiceRegistrationNode(linked)) continue;

    const rawName = cleanServiceName(
      linked?.metadata?.service_name || f.title
    );
    const key = rawName.toLowerCase();
    if (!key || EMAIL_SHAPE_RE.test(rawName)) continue;

    if (!serviceMap.has(key)) {
      serviceMap.set(key, {
        key,
        nodeId: f.node_id,
        serviceName: rawName,
        source: f.sources[0] || "holehe",
        anchor: null,
        confidence: f.confidence,
        url: f.url,
      });
    }
    if (linked && !isRealEmailNode(linked) && !isRealPhoneNode(linked)) {
      tabNodeIds.records.add(linked.id);
      if (!nodeToTab.has(linked.id)) nodeToTab.set(linked.id, "records");
    }
  }

  // 2. Contacts — Emails & Phones (STRICT, zero misclassified accounts)
  const emailMap = new Map<string, EmailRecord>();
  const phoneMap = new Map<string, PhoneRecord>();

  for (const node of nodes) {
    if (node.status === "dismissed") continue;

    if (isRealEmailNode(node)) {
      const emailAddr = node.label.trim();
      const key = emailAddr.toLowerCase();
      const badges = buildEmailBadges(node, edges);
      const tz = node.metadata?.timezone || node.metadata?.tz || null;
      const pgp =
        node.metadata?.pgp_key ||
        node.metadata?.key_id ||
        node.metadata?.fingerprint ||
        null;

      let edgeServiceCount = 0;
      for (const e of edges) {
        const otherId =
          e.source === node.id
            ? e.target
            : e.target === node.id
            ? e.source
            : null;
        if (!otherId) continue;
        const other = nodeById.get(otherId);
        if (other && isServiceRegistrationNode(other)) {
          edgeServiceCount += 1;
        }
      }
      const svcCount = Math.max(
        serviceCountByAnchor.get(key) ?? 0,
        edgeServiceCount
      );

      const existing = emailMap.get(key);
      if (!existing) {
        emailMap.set(key, {
          key,
          nodeId: node.id,
          email: emailAddr,
          confidence: node.confidence,
          status: node.status,
          badges,
          sources: [...node.sources],
          timezone: tz,
          pgpKey: pgp,
          serviceCount: svcCount,
          matchReason: sanitizeDisplayText(node.metadata?.match_reason),
        });
      } else {
        existing.confidence = Math.max(existing.confidence, node.confidence);
        existing.badges = Array.from(new Set([...existing.badges, ...badges]));
        existing.sources = Array.from(
          new Set([...existing.sources, ...node.sources])
        );
        if (!existing.timezone && tz) existing.timezone = tz;
        if (!existing.pgpKey && pgp) existing.pgpKey = pgp;
        existing.serviceCount = Math.max(existing.serviceCount, svcCount);
      }

      tabNodeIds.contacts.add(node.id);
      nodeToTab.set(node.id, "contacts");
      continue;
    }

    if (isRealPhoneNode(node)) {
      const rawPhone = node.label.trim();
      const key = rawPhone.replace(/\D/g, "");
      if (!key) continue;

      let edgeServiceCount = 0;
      for (const e of edges) {
        const otherId =
          e.source === node.id
            ? e.target
            : e.target === node.id
            ? e.source
            : null;
        if (!otherId) continue;
        const other = nodeById.get(otherId);
        if (other && isServiceRegistrationNode(other)) {
          edgeServiceCount += 1;
        }
      }

      const existing = phoneMap.get(key);
      if (!existing) {
        phoneMap.set(key, {
          key,
          nodeId: node.id,
          phone: rawPhone,
          confidence: node.confidence,
          status: node.status,
          context: sanitizeDisplayText(
            node.metadata?.match_reason ||
              node.metadata?.source_context ||
              node.sublabel
          ),
          sources: [...node.sources],
          serviceCount: Math.max(
            serviceCountByAnchor.get(rawPhone.toLowerCase()) ?? 0,
            edgeServiceCount
          ),
        });
      } else {
        existing.confidence = Math.max(existing.confidence, node.confidence);
        existing.sources = Array.from(
          new Set([...existing.sources, ...node.sources])
        );
        existing.serviceCount = Math.max(
          existing.serviceCount,
          edgeServiceCount
        );
      }

      tabNodeIds.contacts.add(node.id);
      nodeToTab.set(node.id, "contacts");
    }
  }

  // 3. Accounts (All social, developer, and web profiles — zero GitHub bias)
  const accountMap = new Map<string, AccountRecord>();
  for (const node of nodes) {
    if (!isAccountNode(node)) continue;

    const { platform, handle } = parsePlatformAndHandle(node);
    const key = `${normalizeAccountPlatformKey(platform)}::${handle
      .replace(/^@/, "")
      .toLowerCase()}`;

    const explicitTier = node.metadata?.match_tier?.toLowerCase();
    let tier: "verified" | "probable" | "collision";
    if (node.status === "dismissed" || explicitTier === "collision") {
      tier = "collision";
    } else if (
      node.status === "confirmed" ||
      explicitTier === "verified" ||
      node.confidence >= 0.8
    ) {
      tier = "verified";
    } else if (explicitTier === "probable" || node.confidence >= 0.52) {
      tier = "probable";
    } else {
      tier = "collision";
    }

    const reason = node.metadata?.match_reason || null;
    const hasAvatarEdge = edges.some(
      (e) =>
        (e.source === node.id || e.target === node.id) &&
        e.relation.toLowerCase().includes("avatar")
    );
    const hasReciprocal = edges.some(
      (e) =>
        (e.source === node.id || e.target === node.id) &&
        e.relation.toLowerCase().includes("reciprocal")
    );

    const matchLabel =
      tier === "collision"
        ? "Collision"
        : hasReciprocal
        ? "Reciprocal Proof"
        : hasAvatarEdge
        ? "Avatar Match"
        : tier === "verified"
        ? "Verified"
        : "Probable";

    const candidate: AccountRecord = {
      key,
      nodeId: node.id,
      platform,
      handle,
      url: node.url,
      confidence: node.confidence,
      status: node.status,
      tier,
      matchLabel,
      matchReason: sanitizeDisplayText(reason),
      displayName: sanitizeDisplayText(
        node.metadata?.display_name || node.metadata?.name
      ),
      bio: sanitizeDisplayText(
        node.metadata?.bio || node.metadata?.headline || node.metadata?.role
      ),
      location: sanitizeDisplayText(node.metadata?.location),
      org: sanitizeDisplayText(node.metadata?.org || node.metadata?.company),
      timezone: node.metadata?.timezone || null,
      website: (() => {
        const rawSite = node.metadata?.website || node.metadata?.blog || null;
        return rawSite && !isAssetCdnUrl(rawSite) ? rawSite : null;
      })(),
      skills: sanitizeDisplayText(
        node.metadata?.skills || node.metadata?.languages
      ),
      sources: [...node.sources],
    };

    const existing = accountMap.get(key);
    if (!existing) {
      accountMap.set(key, candidate);
    } else {
      const keepNew = candidate.confidence > existing.confidence;
      accountMap.set(key, {
        ...(keepNew ? candidate : existing),
        displayName: existing.displayName || candidate.displayName,
        bio: existing.bio || candidate.bio,
        location: existing.location || candidate.location,
        org: existing.org || candidate.org,
        timezone: existing.timezone || candidate.timezone,
        website: existing.website || candidate.website,
        skills: existing.skills || candidate.skills,
        url: existing.url || candidate.url,
        sources: Array.from(
          new Set([...existing.sources, ...candidate.sources])
        ),
        confidence: Math.max(existing.confidence, candidate.confidence),
      });
    }

    if (tier !== "collision") {
      tabNodeIds.accounts.add(node.id);
    }
    nodeToTab.set(node.id, "accounts");
  }

  const accounts: AccountRecord[] = [];
  const collisionAccounts: AccountRecord[] = [];
  for (const rec of accountMap.values()) {
    if (rec.tier === "collision" || rec.status === "dismissed") {
      collisionAccounts.push(rec);
    } else {
      accounts.push(rec);
    }
  }
  accounts.sort((a, b) => b.confidence - a.confidence);
  collisionAccounts.sort((a, b) => b.confidence - a.confidence);

  // 4. Legal / Corporate / Academic Public Records (Records tab)
  const recordMap = new Map<string, PublicRecordItem>();
  for (const node of nodes) {
    if (node.status === "dismissed") continue;
    if (!isPublicRecordNode(node)) continue;

    const key = (node.url || node.id).toLowerCase();
    const linkedFinding = findingsByNode.get(node.id)?.[0];
    if (!recordMap.has(key)) {
      recordMap.set(key, {
        key,
        nodeId: node.id,
        title: sanitizeDisplayText(node.label) || node.label,
        recordType: normalizeRecordType(node),
        sourceDomain:
          node.metadata?.source_domain || extractDomainFromUrl(node.url),
        excerpt: sanitizeDisplayText(
          node.metadata?.excerpt ||
            node.metadata?.snippet ||
            node.metadata?.bio ||
            linkedFinding?.summary
        ),
        url: node.url,
        confidence: node.confidence,
      });
    }
    tabNodeIds.records.add(node.id);
    nodeToTab.set(node.id, "records");
  }

  // 5. Domains, DNS & TLS (Records tab)
  const domainMap = new Map<string, DomainInfraRecord>();
  for (const node of nodes) {
    if (node.status === "dismissed") continue;
    if (!isDomainOrCertNode(node)) continue;

    const domain = (node.metadata?.domain || node.label)
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .trim();
    const key = domain.toLowerCase();
    if (!key) continue;

    const mailProvider =
      node.metadata?.mail_provider ||
      node.metadata?.mx_provider ||
      node.metadata?.mx_record ||
      node.metadata?.mx ||
      null;
    const spf = node.metadata?.spf || node.metadata?.spf_policy || null;
    const dmarc = node.metadata?.dmarc || node.metadata?.dmarc_policy || null;
    const dmarcMissing =
      !dmarc ||
      dmarc.toLowerCase().includes("missing") ||
      dmarc.toLowerCase().includes("none");
    const tlsOrg =
      node.metadata?.tls_org ||
      node.metadata?.cert_org ||
      node.metadata?.issuer_org ||
      null;
    const tlsSans = node.metadata?.cert_sans || node.metadata?.sans || null;

    const existing = domainMap.get(key);
    if (!existing) {
      domainMap.set(key, {
        key,
        nodeId: node.id,
        domain,
        mailProvider,
        spf,
        dmarc,
        dmarcMissing,
        tlsOrg,
        tlsSans,
        confidence: node.confidence,
      });
    } else {
      existing.mailProvider = existing.mailProvider || mailProvider;
      existing.spf = existing.spf || spf;
      existing.dmarc = existing.dmarc || dmarc;
      existing.dmarcMissing =
        !existing.dmarc ||
        existing.dmarc.toLowerCase().includes("missing") ||
        existing.dmarc.toLowerCase().includes("none");
      existing.tlsOrg = existing.tlsOrg || tlsOrg;
      existing.tlsSans = existing.tlsSans || tlsSans;
      existing.confidence = Math.max(existing.confidence, node.confidence);
    }

    tabNodeIds.records.add(node.id);
    nodeToTab.set(node.id, "records");
  }

  // 6. Public Documents / PDFs (Records tab)
  const docMap = new Map<string, DocumentRecord>();
  for (const node of nodes) {
    if (node.status === "dismissed") continue;
    if (!isDocumentNode(node)) continue;

    const filename = (node.metadata?.filename || node.label).trim();
    const key = (node.url || filename).toLowerCase();
    const linkedFinding = findingsByNode.get(node.id)?.[0];
    if (!docMap.has(key)) {
      docMap.set(key, {
        key,
        nodeId: node.id,
        filename: sanitizeDisplayText(filename) || filename,
        title: sanitizeDisplayText(node.metadata?.title),
        bio: sanitizeDisplayText(
          node.metadata?.bio ||
            node.metadata?.snippet ||
            node.metadata?.excerpt ||
            linkedFinding?.summary
        ),
        author: sanitizeDisplayText(node.metadata?.author),
        creator: sanitizeDisplayText(
          node.metadata?.creator || node.metadata?.producer
        ),
        leakedPathUser:
          node.metadata?.os_user ||
          node.metadata?.path_user ||
          node.metadata?.leaked_user ||
          null,
        extractedContacts:
          node.metadata?.extracted_emails ||
          node.metadata?.extracted_contacts ||
          null,
        url: node.url,
        confidence: node.confidence,
      });
    }
    tabNodeIds.records.add(node.id);
    nodeToTab.set(node.id, "records");
  }

  // 7. Dark Web & Leaks (Tor .onion, Local Corpus, Public Pastes, PGP/SSH Keys)
  const onionMap = new Map<
    string,
    { record: OnionRecord; isBroad: boolean; nodeIds: Set<string> }
  >();
  const corpusMap = new Map<string, CorpusBreachRecord>();
  const pasteMap = new Map<string, PasteMentionRecord>();
  const cryptoMap = new Map<string, CryptoKeyRecord>();

  for (const node of nodes) {
    if (node.status === "dismissed") continue;

    if (isOnionNode(node)) {
      const host = node.metadata?.onion_host || extractDomainFromUrl(node.url);
      const key = (node.url || host || node.id).toLowerCase();
      const linkedFinding = findingsByNode.get(node.id)?.[0];
      const rawContext = sanitizeDisplayText(
        node.metadata?.context_excerpt ||
          node.metadata?.excerpt ||
          node.metadata?.snippet ||
          linkedFinding?.summary
      );
      const matchPrecision = inferOnionPrecision(
        node.metadata,
        node.status,
        node.confidence
      );
      const rawTier = (node.metadata?.match_tier || "").trim().toLowerCase();
      const isBroad =
        node.status !== "confirmed" &&
        (matchPrecision === "partial" || rawTier === "collision");
      const cleanTitle = sanitizeDisplayText(node.label) || node.label;
      const siteCategory =
        sanitizeDisplayText(node.metadata?.site_category) ||
        inferOnionCategory(cleanTitle, host, rawContext);
      const sitePurpose =
        sanitizeDisplayText(node.metadata?.site_purpose) ||
        inferOnionPurpose(siteCategory);
      const whereFound =
        node.metadata?.where_found?.trim() || formatWhereFound(node.url, host);
      const matchedIdentifier =
        sanitizeDisplayText(node.metadata?.matched_identifier) ||
        (node.metadata?.matched_term
          ? `Term: ${sanitizeDisplayText(node.metadata.matched_term) || node.metadata.matched_term}`
          : null);
      const pageStatus: OnionPageStatus =
        node.metadata?.page_status?.trim().toLowerCase() === "live_verified"
          ? "live_verified"
          : "index_only";
      const engine = inferOnionEngine(node.metadata, node.sources);
      const bio = sanitizeDisplayText(node.metadata?.bio);

      const candidate: OnionRecord = {
        key,
        nodeId: node.id,
        title: cleanTitle,
        onionHost: host,
        url: node.url,
        excerpt: rawContext || sanitizeDisplayText(node.metadata?.matched_term),
        siteCategory,
        sitePurpose,
        whereFound,
        matchedIdentifier,
        matchPrecision,
        pageStatus,
        engine,
        contextExcerpt: rawContext,
        bio,
        status: node.status,
        confidence: node.confidence,
        sources: [...node.sources],
      };

      const existing = onionMap.get(key);
      if (!existing) {
        onionMap.set(key, {
          record: candidate,
          isBroad,
          nodeIds: new Set([node.id]),
        });
      } else {
        existing.nodeIds.add(node.id);
        const keepNew =
          precisionRank(candidate.matchPrecision) >
            precisionRank(existing.record.matchPrecision) ||
          candidate.confidence > existing.record.confidence;
        const primary = keepNew ? candidate : existing.record;
        const secondary = keepNew ? existing.record : candidate;
        existing.record = {
          ...primary,
          onionHost: primary.onionHost || secondary.onionHost,
          url: primary.url || secondary.url,
          whereFound: primary.whereFound || secondary.whereFound,
          matchedIdentifier:
            primary.matchedIdentifier || secondary.matchedIdentifier,
          pageStatus:
            primary.pageStatus === "live_verified" ||
            secondary.pageStatus === "live_verified"
              ? "live_verified"
              : "index_only",
          engine: primary.engine || secondary.engine,
          contextExcerpt: primary.contextExcerpt || secondary.contextExcerpt,
          excerpt: primary.excerpt || secondary.excerpt,
          bio: primary.bio || secondary.bio,
          confidence: Math.max(primary.confidence, secondary.confidence),
          sources: Array.from(
            new Set([...existing.record.sources, ...candidate.sources])
          ),
        };
        existing.isBroad = existing.isBroad && isBroad;
      }

      nodeToTab.set(node.id, "darkweb");
      continue;
    }

    if (isPasteNode(node)) {
      const key = (node.url || node.id).toLowerCase();
      const linkedFinding = findingsByNode.get(node.id)?.[0];
      if (!pasteMap.has(key)) {
        pasteMap.set(key, {
          key,
          nodeId: node.id,
          title: sanitizeDisplayText(node.label) || node.label,
          host: extractDomainFromUrl(node.url) || node.metadata?.source_domain || null,
          excerpt: sanitizeDisplayText(
            node.metadata?.excerpt ||
              node.metadata?.snippet ||
              linkedFinding?.summary
          ),
          url: node.url,
          confidence: node.confidence,
        });
      }
      tabNodeIds.darkweb.add(node.id);
      nodeToTab.set(node.id, "darkweb");
      continue;
    }

    if (isCorpusBreachNode(node)) {
      const key = node.id.toLowerCase();
      const linkedFinding = findingsByNode.get(node.id)?.[0];
      if (!corpusMap.has(key)) {
        corpusMap.set(key, {
          key,
          nodeId: node.id,
          title: sanitizeDisplayText(node.label) || node.label,
          file: node.metadata?.file || node.metadata?.source_file || null,
          line: node.metadata?.line || node.metadata?.line_number || null,
          severity: linkedFinding?.severity || "high",
          detail: sanitizeDisplayText(
            node.metadata?.data_classes ||
              node.metadata?.matched_anchor ||
              linkedFinding?.summary
          ),
          sensitiveFields: linkedFinding?.sensitive_fields || [],
          confidence: node.confidence,
        });
      }
      tabNodeIds.darkweb.add(node.id);
      nodeToTab.set(node.id, "darkweb");
      continue;
    }

    if (isCryptoKeyNode(node)) {
      const kind = node.kind.toLowerCase();
      const keyType: "PGP" | "SSH" = kind.includes("ssh") ? "SSH" : "PGP";
      const fp = (node.metadata?.fingerprint || node.label).trim();
      const key = `${keyType}:${fp.toLowerCase()}`;
      if (!cryptoMap.has(key)) {
        cryptoMap.set(key, {
          key,
          nodeId: node.id,
          keyType,
          fingerprint: fp,
          uidOrProfile:
            node.metadata?.uid ||
            node.metadata?.owner ||
            node.sublabel ||
            null,
          algorithm:
            node.metadata?.algorithm || node.metadata?.key_type || null,
          confidence: node.confidence,
        });
      }
      tabNodeIds.darkweb.add(node.id);
      nodeToTab.set(node.id, "darkweb");
    }
  }

  for (const f of findings) {
    const linked = nodeById.get(f.node_id);
    if (linked?.status === "dismissed") continue;
    if (f.category === "darkweb" && !nodeToTab.has(f.node_id)) {
      const host = linked?.metadata?.onion_host || extractDomainFromUrl(f.url);
      const key = (f.url || host || f.id).toLowerCase();
      const matchPrecision = inferOnionPrecision(
        linked?.metadata,
        linked?.status ?? "unverified",
        f.confidence
      );
      const isBroad =
        linked?.status !== "confirmed" &&
        (matchPrecision === "partial" ||
          linked?.metadata?.match_tier?.toLowerCase() === "collision");
      const siteCategory =
        linked?.metadata?.site_category?.trim() ||
        inferOnionCategory(f.title, host, f.summary);
      const sitePurpose =
        linked?.metadata?.site_purpose?.trim() ||
        inferOnionPurpose(siteCategory);

      if (!onionMap.has(key)) {
        onionMap.set(key, {
          record: {
            key,
            nodeId: f.node_id,
            title: sanitizeDisplayText(f.title) || f.title,
            onionHost: host,
            url: f.url,
            excerpt: sanitizeDisplayText(f.summary),
            siteCategory: sanitizeDisplayText(siteCategory) || siteCategory,
            sitePurpose: sanitizeDisplayText(sitePurpose) || sitePurpose,
            whereFound:
              linked?.metadata?.where_found?.trim() ||
              formatWhereFound(f.url, host),
            matchedIdentifier: sanitizeDisplayText(
              linked?.metadata?.matched_identifier
            ),
            matchPrecision,
            pageStatus:
              linked?.metadata?.page_status?.trim().toLowerCase() ===
              "live_verified"
                ? "live_verified"
                : "index_only",
            engine: inferOnionEngine(linked?.metadata, f.sources),
            contextExcerpt: sanitizeDisplayText(
              linked?.metadata?.context_excerpt || f.summary
            ),
            bio: sanitizeDisplayText(linked?.metadata?.bio),
            status: linked?.status ?? "unverified",
            confidence: f.confidence,
            sources: [...f.sources],
          },
          isBroad,
          nodeIds: new Set([f.node_id]),
        });
      }
      nodeToTab.set(f.node_id, "darkweb");
    } else if (f.category === "breach" && !nodeToTab.has(f.node_id)) {
      const key = f.id.toLowerCase();
      if (!corpusMap.has(key)) {
        corpusMap.set(key, {
          key,
          nodeId: f.node_id,
          title: f.title,
          file: linked?.metadata?.file || null,
          line: linked?.metadata?.line || null,
          severity: f.severity,
          detail: f.summary,
          sensitiveFields: f.sensitive_fields,
          confidence: f.confidence,
        });
      }
      tabNodeIds.darkweb.add(f.node_id);
      nodeToTab.set(f.node_id, "darkweb");
    }
  }

  const emails = Array.from(emailMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
  const phones = Array.from(phoneMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
  const registeredServices = Array.from(serviceMap.values()).sort((a, b) =>
    a.serviceName.localeCompare(b.serviceName)
  );
  const publicRecords = Array.from(recordMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
  const domains = Array.from(domainMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
  const documents = Array.from(docMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );

  const onionHits: OnionRecord[] = [];
  const broadOnionHits: OnionRecord[] = [];
  for (const entry of onionMap.values()) {
    if (entry.isBroad) {
      broadOnionHits.push(entry.record);
    } else {
      onionHits.push(entry.record);
      for (const nid of entry.nodeIds) {
        tabNodeIds.darkweb.add(nid);
      }
    }
  }
  onionHits.sort((a, b) => b.confidence - a.confidence);
  broadOnionHits.sort((a, b) => b.confidence - a.confidence);

  const corpusHits = Array.from(corpusMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
  const pasteHits = Array.from(pasteMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
  const cryptoKeys = Array.from(cryptoMap.values()).sort(
    (a, b) => b.confidence - a.confidence
  );

  const counts: Record<IntelTab, number> = {
    contacts: emails.length + phones.length,
    accounts: accounts.length,
    records:
      registeredServices.length +
      publicRecords.length +
      domains.length +
      documents.length,
    darkweb:
      onionHits.length +
      corpusHits.length +
      pasteHits.length +
      cryptoKeys.length,
  };

  return {
    emails,
    phones,
    accounts,
    collisionAccounts,
    registeredServices,
    publicRecords,
    domains,
    documents,
    onionHits,
    broadOnionHits,
    corpusHits,
    pasteHits,
    cryptoKeys,
    counts,
    tabNodeIds,
    nodeToTab,
  };
}
