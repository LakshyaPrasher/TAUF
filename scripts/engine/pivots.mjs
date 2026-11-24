/**
 * TAUF V6 — Recursive Identity Pivot Extractors (zero-dependency ESM)
 * -------------------------------------------------------------------
 * Pure, bounded, injection-friendly helpers that turn newly verified graph
 * anchors (emails, handles, personal domains, verified organizations) into
 * high-precision Hop 2..K expansion tasks for `createScheduler()`.
 *
 * Hard constraints:
 * - Zero external SaaS/REST API endpoints (no `api.*` or `/api/v*` URLs).
 * - All network I/O is injected via `fetchFn` so callers route 100% over
 *   `sovereignFetch` (`socks5h://` remote DNS + fail-closed guard).
 * - Strictly bounded per-domain path caps and byte/time ceilings.
 */

import crypto from "node:crypto";

export const PIVOT_PRIORITY = Object.freeze({
  EMAIL: 100,
  HANDLE: 92,
  DOMAIN: 88,
  CONTEXT: 80,
});

const GENERIC_EMAIL_LOCALS = new Set([
  "info", "contact", "admin", "administrator", "support", "help", "hello",
  "hi", "hey", "mail", "email", "office", "team", "sales", "hr", "careers",
  "jobs", "press", "media", "legal", "privacy", "security", "abuse", "noreply",
  "no-reply", "webmaster", "postmaster", "hostmaster", "billing", "accounts",
  "enquiries", "inquiries", "feedback", "newsletter", "root", "user", "me",
]);

const GENERIC_CONTEXT_STOPWORDS = new Set([
  "inc", "llc", "ltd", "corp", "company", "freelance", "self-employed",
  "independent", "student", "engineer", "developer", "founder", "director",
  "unknown", "none", "n/a", "remote", "github", "linkedin", "instagram",
  "youtube", "twitter", "facebook", "reddit", "medium", "kaggle",
]);

/**
 * Derive high-specificity handle candidates from a verified personal email's
 * local-part (e.g. `alice.dev99@gmail.com` -> `["alice.dev99", "alicedev99"]`).
 * Rejects generic role prefixes (`info@`, `contact@`, `me@`) and short tokens.
 *
 * @param {string} email
 * @returns {string[]}
 */
export function deriveEmailHandleCandidates(email) {
  const raw = String(email || "").trim().toLowerCase();
  const atIdx = raw.indexOf("@");
  if (atIdx <= 0) return [];
  const local = raw.slice(0, atIdx).split("+")[0].trim();
  if (!local || local.length < 5 || local.length > 36) return [];
  if (GENERIC_EMAIL_LOCALS.has(local)) return [];
  if (/^\d+$/.test(local)) return [];

  const clean = local.replace(/[^a-z0-9._-]/g, "");
  if (clean.length < 5 || GENERIC_EMAIL_LOCALS.has(clean)) return [];

  const out = [];
  const push = (v) => {
    if (v && v.length >= 5 && !GENERIC_EMAIL_LOCALS.has(v) && !out.includes(v)) {
      out.push(v);
    }
  };
  push(clean);
  const compact = clean.replace(/[._-]+/g, "");
  if (compact !== clean && compact.length >= 5) {
    push(compact);
  }
  return out.slice(0, 2);
}

/**
 * Fetch public Gravatar self-published profile JSON (`https://en.gravatar.com/<md5>.json`).
 * Uses zero external OSINT SaaS APIs — Gravatar profiles are user-published identity cards.
 *
 * @param {string} email
 * @param {{ fetchFn: (url: string, opts?: any) => Promise<any>, signal?: AbortSignal }} options
 */
export async function fetchGravatarProfile(email, { fetchFn, signal } = {}) {
  const clean = String(email || "").trim().toLowerCase();
  const empty = {
    found: false,
    email: clean,
    displayName: "",
    preferredUsername: "",
    bio: "",
    location: "",
    accounts: [],
    urls: [],
  };
  if (!clean || !clean.includes("@") || typeof fetchFn !== "function") return empty;
  if (signal?.aborted) return empty;

  const md5Hex = crypto.createHash("md5").update(clean).digest("hex");
  const profileUrl = `https://en.gravatar.com/${md5Hex}.json`;

  try {
    const res = await fetchFn(profileUrl, { timeoutMs: 7000, maxBytes: 65536, signal });
    if (!res || !res.ok) return empty;
    const rawText = typeof res.text === "function" ? await res.text() : "";
    if (!rawText || rawText.trim()[0] !== "{") return empty;
    const parsed = JSON.parse(rawText);
    const entry = Array.isArray(parsed?.entry) ? parsed.entry[0] : null;
    if (!entry || typeof entry !== "object") return empty;

    const accounts = [];
    for (const acc of Array.isArray(entry.accounts) ? entry.accounts : []) {
      if (!acc || typeof acc !== "object") continue;
      const url = String(acc.url || "").trim();
      if (!url.startsWith("http")) continue;
      accounts.push({
        platform: String(acc.shortname || acc.name || acc.domain || "Profile").trim(),
        username: String(acc.username || acc.display || "").replace(/^@+/, "").trim(),
        url,
        verified: Boolean(acc.verified),
      });
    }

    const urls = [];
    for (const u of Array.isArray(entry.urls) ? entry.urls : []) {
      const val = String(u?.value || "").trim();
      if (val.startsWith("http")) {
        urls.push({ url: val, title: String(u?.title || "").trim() });
      }
    }

    return {
      found: true,
      email: clean,
      profileUrl: String(entry.profileUrl || `https://gravatar.com/${md5Hex}`),
      displayName: String(entry.displayName || entry.name?.formatted || "").trim(),
      preferredUsername: String(entry.preferredUsername || "").trim(),
      bio: String(entry.aboutMe || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
      location: String(entry.currentLocation || "").trim().slice(0, 100),
      accounts: accounts.slice(0, 12),
      urls: urls.slice(0, 8),
    };
  } catch {
    return empty;
  }
}

const IDENTITY_SUBPATHS = [
  "/about",
  "/contact",
  "/resume",
  "/cv",
  "/links",
  "/.well-known/security.txt",
  "/.well-known/keybase.txt",
  "/.well-known/atproto-did",
];

function stripLayoutTags(html) {
  let s = String(html || "");
  for (const tag of ["style", "noscript"]) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  s = s.replace(/<script(?![^>]+application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, " ");
  return s;
}

/**
 * Bounded same-origin identity micro-crawler for verified personal/portfolio domains.
 * Inspects up to `maxPaths` high-yield identity routes concurrently (32 KB / 6.5 s each).
 *
 * @param {string} domain
 * @param {{ fetchFn: (url: string, opts?: any) => Promise<any>, signal?: AbortSignal, maxPaths?: number }} options
 */
export async function crawlDomainIdentitySurface(domain, { fetchFn, signal, maxPaths = 7 } = {}) {
  const cleanDom = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  const out = {
    domain: cleanDom,
    emails: [],
    pdfUrls: [],
    sameAsUrls: [],
    pgpUrls: [],
    keybaseHandle: null,
    atprotoDid: null,
  };
  if (!cleanDom || !cleanDom.includes(".") || typeof fetchFn !== "function") return out;

  const emails = new Set();
  const pdfUrls = new Set();
  const sameAsUrls = new Set();
  const pgpUrls = new Set();

  const origin = `https://${cleanDom}`;
  const paths = IDENTITY_SUBPATHS.slice(0, Math.max(1, Math.min(8, Number(maxPaths) || 7)));

  await Promise.allSettled(
    paths.map(async (subPath) => {
      if (signal?.aborted) return;
      const targetUrl = `${origin}${subPath}`;
      let res;
      try {
        res = await fetchFn(targetUrl, { timeoutMs: 6500, maxBytes: 49152, signal });
      } catch {
        return;
      }
      if (!res || !res.ok || signal?.aborted) return;
      let body = "";
      try {
        body = String((await res.text()) || "").slice(0, 49152);
      } catch {
        return;
      }
      if (!body.trim()) return;

      if (subPath === "/.well-known/atproto-did") {
        const didM = body.trim().match(/^(did:(?:plc|web):[a-z0-9._:%-]{6,120})$/im);
        if (didM) out.atprotoDid = didM[1];
        return;
      }

      if (subPath === "/.well-known/keybase.txt") {
        const kbM =
          body.match(/keybase\.io\/([a-z0-9_]{2,24})/i) ||
          body.match(/"username"\s*:\s*"([a-z0-9_]{2,24})"/i);
        if (kbM) {
          out.keybaseHandle = kbM[1].toLowerCase();
          sameAsUrls.add(`https://keybase.io/${out.keybaseHandle}`);
        }
        return;
      }

      if (subPath === "/.well-known/security.txt") {
        for (const m of body.matchAll(/^Contact:\s*(?:mailto:)?([^\s<>]+@[^\s<>]+)$/gim)) {
          const em = m[1].trim().toLowerCase();
          const local = em.split("@")[0];
          if (!GENERIC_EMAIL_LOCALS.has(local)) emails.add(em);
        }
        for (const m of body.matchAll(/^Encryption:\s*(https?:\/\/[^\s<>]+)$/gim)) {
          pgpUrls.add(m[1].trim());
        }
        return;
      }

      // JSON-LD sameAs + email
      for (const m of body.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
          const walk = (v) => {
            if (!v || typeof v !== "object") return;
            if (Array.isArray(v)) return v.forEach(walk);
            if (v.sameAs) {
              const arr = Array.isArray(v.sameAs) ? v.sameAs : [v.sameAs];
              for (const s of arr) if (typeof s === "string" && s.startsWith("http")) sameAsUrls.add(s.trim());
            }
            if (typeof v.email === "string") {
              const em = v.email.replace(/^mailto:/i, "").trim().toLowerCase();
              const local = em.split("@")[0];
              if (em.includes("@") && !GENERIC_EMAIL_LOCALS.has(local)) emails.add(em);
            }
            Object.values(v).forEach(walk);
          };
          walk(JSON.parse(m[1].trim()));
        } catch {
          // ignore malformed JSON-LD
        }
      }

      const cleaned = stripLayoutTags(body);

      // <link rel="me"> and <a rel="me">
      for (const m of cleaned.matchAll(/<(?:a|link)\b[^>]+rel=["'][^"']*\bme\b[^"']*["'][^>]+href=["'](https?:\/\/[^"'\s<>]+)["']/gi)) {
        sameAsUrls.add(m[1]);
      }
      for (const m of cleaned.matchAll(/<(?:a|link)\b[^>]+href=["'](https?:\/\/[^"'\s<>]+)["'][^>]+rel=["'][^"']*\bme\b[^"']*["']/gi)) {
        sameAsUrls.add(m[1]);
      }

      // Outbound external links on /about, /contact, /links, /resume, /cv
      for (const m of cleaned.matchAll(/<a\b[^>]+href=["'](https?:\/\/[^"'\s<>]+|\/[^"'\s<>]+)["']/gi)) {
        const rawHref = m[1];
        const absUrl = rawHref.startsWith("http") ? rawHref : `${origin}${rawHref}`;
        if (/\.pdf(?:$|[?#])/i.test(absUrl)) {
          pdfUrls.add(absUrl);
          continue;
        }
        if (/\.(?:asc|gpg)(?:$|[?#])/i.test(absUrl)) {
          pgpUrls.add(absUrl);
          continue;
        }
        try {
          const hHost = new URL(absUrl).hostname.replace(/^www\./, "").toLowerCase();
          if (hHost && hHost !== cleanDom) {
            sameAsUrls.add(absUrl);
          }
        } catch {
          // ignore
        }
      }

      // mailto: and embedded personal emails
      for (const m of cleaned.matchAll(/\b([A-Za-z0-9._%+-]{2,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,12})\b/g)) {
        const em = m[1].toLowerCase();
        const [local, dom] = em.split("@");
        if (!local || !dom || GENERIC_EMAIL_LOCALS.has(local)) continue;
        if (/\.(?:png|jpg|jpeg|svg|webp|gif|css|js)$/i.test(em)) continue;
        emails.add(em);
        if (emails.size >= 8) break;
      }
    })
  );

  out.emails = [...emails].slice(0, 8);
  out.pdfUrls = [...pdfUrls].slice(0, 8);
  out.sameAsUrls = [...sameAsUrls].slice(0, 20);
  out.pgpUrls = [...pgpUrls].slice(0, 4);
  return out;
}

/**
 * Build up to `maxQueries` high-precision context-disambiguated search queries from
 * verified organizations, institutions, and personal/corporate domains discovered in Hop 1.
 *
 * @param {string} fullName
 * @param {string[]} [verifiedOrgs]
 * @param {string[]} [verifiedDomains]
 * @param {number} [maxQueries=3]
 * @returns {Array<{ kind: string, query: string, anchor: string }>}
 */
export function buildContextDisambiguationQueries(
  fullName,
  verifiedOrgs = [],
  verifiedDomains = [],
  maxQueries = 3
) {
  const name = String(fullName || "").replace(/"/g, "").trim();
  if (!name || name.length < 3) return [];

  const queries = [];
  const seen = new Set();
  const push = (kind, query, anchor) => {
    const key = query.toLowerCase();
    if (seen.has(key) || queries.length >= maxQueries) return;
    seen.add(key);
    queries.push({ kind, query, anchor });
  };

  for (const rawOrg of Array.isArray(verifiedOrgs) ? verifiedOrgs : []) {
    const org = String(rawOrg || "").replace(/["<>]/g, "").replace(/\s+/g, " ").trim();
    if (org.length < 3 || org.length > 64) continue;
    if (GENERIC_CONTEXT_STOPWORDS.has(org.toLowerCase())) continue;
    if (org.toLowerCase() === name.toLowerCase()) continue;
    push("context_org", `"${name}" "${org}"`, org);
    if (queries.length < maxQueries) {
      push("context_pdf", `"${name}" "${org}" filetype:pdf`, org);
    }
  }

  for (const rawDom of Array.isArray(verifiedDomains) ? verifiedDomains : []) {
    const dom = String(rawDom || "").trim().toLowerCase().replace(/^www\./, "");
    if (!dom.includes(".") || dom.length < 4 || dom.length > 64) continue;
    push("context_domain", `"${name}" "${dom}"`, dom);
  }

  return queries.slice(0, maxQueries);
}
