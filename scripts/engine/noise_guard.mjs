// Anti-noise guard for TAUF V6 (zero-dependency ESM).
//
// Strong-name semantics mirror local-server.mjs nameEvidence(): NFKC + casefold,
// token boundaries, contiguous phrase, first -> last within 60 chars and <= 3
// intervening tokens, or reversed "Last, First".

const WIKI_NOISE_PATHS = [
  "/wiki/user:", "/wiki/user_talk:", "/wiki/talk:", "/wiki/list_of_",
  "/wiki/category:", "/wiki/template:", "/wiki/portal:", "/wiki/file:",
];
const NAME_KEYS = [
  "pageFullName", "profileFullName", "detectedFullName", "detectedName",
  "profileName", "ownerName", "subjectName", "personName", "pageName",
  "displayName", "fullName", "name",
];
const FLAG_KEYS = [
  "sharedEmail", "emailShared", "emailMatch", "emailMatched", "matchedEmail",
  "sharedDomain", "domainShared", "domainMatch", "domainMatched", "matchedDomain",
  "sharedOrg", "orgShared", "orgMatch", "orgMatched", "matchedOrg",
  "reciprocalLink", "reciprocal", "linksBack", "backlink",
  "strongName", "nameStrong", "hasStrongName", "proximityName", "nameProximity",
];
const LIST_KEYS = [
  "sharedEmails", "matchedEmails", "sharedDomains", "matchedDomains",
  "sharedOrgs", "matchedOrgs", "organizations", "orgs", "reciprocalLinks", "backlinks",
];

const foldText = (value) => String(value == null ? "" : value)
  .normalize("NFKC").toLowerCase().replace(/ß/g, "ss")
  .replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();

const nameTokens = (value) => foldText(value)
  .split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);

function tokenSpans(text) {
  const spans = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    spans.push({ token: match[0], start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

const betweenCount = (spans, left, right) =>
  spans.filter((s) => s.start >= left.end && s.end <= right.start).length;

/** Local strong full-name matcher. */
export function strongNameMatch(text, fullName) {
  const tokens = nameTokens(fullName);
  const folded = foldText(text);
  if (!folded || tokens.length === 0) return false;
  const spans = tokenSpans(folded);
  if (spans.length === 0) return false;

  if (` ${spans.map((s) => s.token).join(" ")} `.includes(` ${tokens.join(" ")} `)) return true;
  if (tokens.length === 1) return spans.some((s) => s.token === tokens[0]);
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first === last) return false;

  const firstPos = spans.filter((s) => s.token === first);
  const lastPos = spans.filter((s) => s.token === last);
  const forward = firstPos.some((a) => lastPos.some((b) =>
    b.start >= a.end && b.start - a.end <= 60 && betweenCount(spans, a, b) <= 3));
  if (forward) return true;

  return lastPos.some((a) => firstPos.some((b) => {
    if (b.start < a.end) return false;
    return betweenCount(spans, a, b) === 0 && /^[\s,.'’\-–—]*$/.test(folded.slice(a.end, b.start));
  }));
}

/** Strong + 120-char proximity evidence, matching the shipped nameEvidence shape. */
export function localNameEvidence(text, fullName) {
  const tokens = nameTokens(fullName);
  if (strongNameMatch(text, fullName)) {
    return { strong: true, proximity: true, tokenBoundary: true, matched: true };
  }
  const folded = foldText(text);
  const spans = tokenSpans(folded);
  const empty = { strong: false, proximity: false, tokenBoundary: false, matched: false };
  if (!folded || tokens.length === 0 || spans.length === 0) return empty;

  const hasToken = (token) => spans.some((s) => s.token === token);
  let proximity;
  if (tokens.length === 1) proximity = hasToken(tokens[0]);
  else {
    const firstPos = spans.filter((s) => s.token === tokens[0]);
    const lastPos = spans.filter((s) => s.token === tokens[tokens.length - 1]);
    proximity = firstPos.some((a) => lastPos.some((b) => Math.abs(b.start - a.start) <= 120));
  }
  const tokenBoundary = tokens.some((t) => t.length >= 3 && hasToken(t));
  return { strong: false, proximity, tokenBoundary, matched: proximity || tokenBoundary };
}

function cleanHandle(value) {
  const handle = String(value == null ? "" : value).normalize("NFKC").toLowerCase()
    .replace(/@/g, "").replace(/\s+/g, "").replace(/[^\p{L}\p{N}._-]/gu, "");
  return handle.length >= 2 && /[\p{L}\p{N}]/u.test(handle) ? handle : "";
}

const asciiNameParts = (fullName) => String(fullName == null ? "" : fullName)
  .normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
  .split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);

const COMPOUND_PATTERNS = [
  ["firstlast", (f, l) => f + l],
  ["first.last", (f, l) => `${f}.${l}`],
  ["first_last", (f, l) => `${f}_${l}`],
  ["first-last", (f, l) => `${f}-${l}`],
  ["lastfirst", (f, l) => l + f],
  ["flast", (f, l) => f[0] + l],
  ["firstl", (f, l) => f + l[0]],
];

/** Compound-only handles; the seed is always kept, bare names never emitted. */
export function generateHighPrecisionHandles(fullName, seedHandle) {
  const results = [];
  const seen = new Set();
  const add = (raw, pattern) => {
    const handle = cleanHandle(raw);
    if (!handle || seen.has(handle)) return;
    seen.add(handle);
    results.push({ handle, pattern });
  };
  add(seedHandle, "seed");
  const parts = asciiNameParts(fullName);
  if (parts.length === 0) return results;
  if (parts.length === 1) {
    add(parts[0], "single");
    return results;
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  for (const [pattern, build] of COMPOUND_PATTERNS) add(build(first, last), pattern);
  return results;
}

const decodeSoft = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

const cleanWikipediaTitle = (title) => String(title == null ? "" : title)
  .replace(/&ndash;/gi, "–").replace(/&#8211;/g, "–")
  .replace(/&mdash;/gi, "—").replace(/&#8212;/g, "—")
  .replace(/\s*[-–—]\s*Wikipedia\s*$/i, "").replace(/\s+/g, " ").trim();

/** Article namespace + no disambiguation + strong title name match. */
export function isValidWikipediaBiography(url, title, html, fullName, nameEvidenceFn) {
  const rawUrl = String(url == null ? "" : url);
  const haystack = `${decodeSoft(rawUrl)}\n${rawUrl}`.toLowerCase();
  if (WIKI_NOISE_PATHS.some((path) => haystack.includes(path))) return false;

  const rawTitle = String(title == null ? "" : title);
  const body = `${rawTitle}\n${String(html == null ? "" : html)}`;
  if (/may refer to|__DISAMBIG__|disambig/i.test(body)) return false;

  const cleanedTitle = cleanWikipediaTitle(rawTitle);
  if (!cleanedTitle || nameTokens(fullName).length === 0) return false;

  if (typeof nameEvidenceFn === "function") {
    try {
      const evidence = nameEvidenceFn(cleanedTitle, fullName);
      if (typeof evidence === "boolean") return evidence;
      return Boolean(evidence && evidence.strong);
    } catch {
      return strongNameMatch(cleanedTitle, fullName);
    }
  }
  return strongNameMatch(cleanedTitle, fullName);
}

/** Empty gist shells: "no public gists yet" or a gist page with no snippet. */
export function isEmptyOrBoilerplateGist(html) {
  const source = String(html == null ? "" : html);
  if (!source.trim()) return false;
  const decoded = source
    .replace(/&#0*39;|&#x0*27;|&apos;|&rsquo;|&#8217;/gi, "'").replace(/’/g, "'");
  if (/doesn'?t\s+have\s+any\s+public\s+gists\s+yet/i.test(decoded)) return true;
  if (/\bno\s+public\s+gists\s+yet\b/i.test(decoded)) return true;
  const looksLikeGist = /gist\.github\.com|github\s+gist|<title[^>]*>[^<]*\bgists?\b/i.test(source);
  return looksLikeGist && !/gist-snippet/i.test(source);
}

const present = (value) => Array.isArray(value) ? value.length > 0
  : typeof value === "string" ? value.trim().length > 0 : Boolean(value);

const anyPresent = (obj, keys) => Boolean(obj && typeof obj === "object" && keys.some((k) => present(obj[k])));

function hasContradictoryName(signals, score, fullName) {
  if (signals && (signals.contradictoryName || signals.nameConflict || signals.contradicts)) return true;
  if (score && (score.contradictoryName || score.nameConflict || score.contradicts)) return true;
  const reason = String((score && score.match_reason) || "");
  if (/contradict|different\s+(?:full\s+)?name|name\s+(?:mismatch|conflict)/i.test(reason)) return true;
  if (nameTokens(fullName).length < 2) return false;
  return NAME_KEYS.some((key) => {
    const candidate = signals && signals[key];
    return typeof candidate === "string" && nameTokens(candidate).length >= 2 &&
      !strongNameMatch(candidate, fullName);
  });
}

const normalizeComparable = (value) => foldText(value).replace(/[^\p{L}\p{N}]+/gu, "");

function isBrandOnlyShell(signals, score, fullName) {
  if (!signals) return false;
  if (signals.brandOnly || signals.isBrandOnly || signals.brandShell || signals.shell ||
      signals.isBrand || signals.onlyBrand) return true;
  const reason = String((score && score.match_reason) || "");
  if (/brand[\s-]*only/i.test(reason)) return true;
  const title = normalizeComparable(signals.title);
  if (!title) return false;
  const brands = [signals.siteBrand, signals.brand, signals.brandName, signals.platform, signals.site]
    .map(normalizeComparable).filter(Boolean);
  if (!brands.some((brand) => brand === title)) return false;
  return !localNameEvidence(`${signals.title || ""} ${signals.description || ""}`, fullName).proximity;
}

function hasCorroboration(signals, score, fullName) {
  for (const source of [signals, score]) {
    if (!source || typeof source !== "object") continue;
    if (anyPresent(source, FLAG_KEYS) || anyPresent(source, LIST_KEYS)) return true;
    const evidence = source.nameEvidence || source.name_evidence;
    if (evidence && (evidence.strong || evidence.proximity)) return true;
  }
  if (score && score.match_tier === "verified") return true;
  if (signals) {
    const computed = localNameEvidence(`${signals.title || ""} ${signals.description || ""}`, fullName);
    if (computed.strong || computed.proximity) return true;
  }
  const reason = String((score && score.match_reason) || "");
  return /shared\s+(?:org|organization|domain|email)|full name phrase|verified email|email present|org\/domain|domain confirmed|organization context|provided (?:organization|email|domain|handle) context|reciprocal/i
    .test(reason);
}

/** Final gate: contradictory name, brand-only shell, or zero corroboration. */
export function shouldDropCollision(signals, scoreResult, fullName, isSeedHandle) {
  const signalsObj = signals && typeof signals === "object" ? signals : {};
  const score = scoreResult && typeof scoreResult === "object" ? scoreResult : {};
  if (hasContradictoryName(signalsObj, score, fullName)) return true;
  if (isBrandOnlyShell(signalsObj, score, fullName)) return true;
  if (isSeedHandle === true) return false;
  return !hasCorroboration(signalsObj, score, fullName);
}
