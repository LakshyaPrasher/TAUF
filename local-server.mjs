import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_BUILD_ID = "v5.3-darkweb-clarity";

const DIST_DIR = path.join(__dirname, "dist");
const WMN_PATH = path.join(__dirname, "src-tauri", "resources", "wmn_curated.json");
const SIDECAR_BRIDGE = path.join(__dirname, "sidecar", "bridge.py");
const SIDECAR_VENV_DIR = path.join(__dirname, "sidecar", ".venv");
const SIDECAR_VENV_SCRIPTS = path.join(SIDECAR_VENV_DIR, "Scripts");
const SIDECAR_VENV_BIN = path.join(SIDECAR_VENV_DIR, "bin");
const SIDECAR_VENV_PYTHON = fs.existsSync(path.join(SIDECAR_VENV_SCRIPTS, "python.exe"))
  ? path.join(SIDECAR_VENV_SCRIPTS, "python.exe")
  : path.join(SIDECAR_VENV_BIN, "python3");

const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), ".tauf"),
  "TAUF"
);
const CASES_FILE = path.join(DATA_DIR, "cases.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const RUNTIME_LOG_FILE = path.join(DATA_DIR, "runtime.log");
const DEFAULT_CORPUS_DIR = path.join(DATA_DIR, "corpus");
const TOR_BUNDLE_DIR = path.join(DATA_DIR, "tor");
const TOR_DATA_DIR = path.join(DATA_DIR, "tor-data");
const AHMIA_V3_BASE = "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion";
const ONIONLAND_V3_BASE = "http://3bbad7fauom4d6sgppalyqddsqbf5u5p56b5k5uk2zxsy3d6ey2jobad.onion";
const DEFAULT_ONION_SEEDS = [
  `${AHMIA_V3_BASE}/search/?q={query}`,
  `${ONIONLAND_V3_BASE}/search?q={query}`,
];
// Known SPA shells that return HTTP 200 for nonexistent users — never emit as verified accounts
const BLOCKED_SPA_HOSTS = new Set([
  "crates.io",
  "substack.com",
  "bsky.app",
  "archive.org",
  "500px.com",
  "slideshare.net",
  "thingiverse.com",
  "wordpress.com",
  "linktr.ee",
  "tryhackme.com",
  "bandcamp.com",
]);
// Auth-walled social hosts where direct anonymous HTTP requests hit login walls rather than soft-404s
const AUTH_WALLED_HOSTS = new Set([
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "threads.net",
]);

function logRuntime(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(RUNTIME_LOG_FILE, line + "\n", "utf8");
  } catch {
    // ignore log write failure
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_CORPUS_DIR, { recursive: true });
const CORPUS_README = path.join(DEFAULT_CORPUS_DIR, "README.txt");
if (!fs.existsSync(CORPUS_README)) {
  fs.writeFileSync(
    CORPUS_README,
    [
      "TAUF Local Sovereign Corpus Folder",
      "========================================",
      "Drop authorized/redacted .txt, .csv, .tsv, .json, .jsonl, or .log breach/paste files here.",
      "TAUF scans this folder 100% offline on your laptop (zero external breach APIs)",
      "and automatically redacts credential fields when reporting exposure metadata.",
    ].join("\r\n"),
    "utf8"
  );
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "aol.com",
  "gmx.com",
  "yandex.com",
  "tutanota.com",
]);

const PLATFORM_NOISE_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
  "yourdomain.com",
  "test.com",
  "github.githubassets.com",
  "githubassets.com",
  "githubusercontent.com",
  "avatars.githubusercontent.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "users.noreply.github.com",
  "sentry.io",
  "w3.org",
  "schema.org",
  "gravatar.com",
  "automattic.com",
  "wordpress.com",
  "wordpress.org",
  "github.com",
  "gitlab.com",
  "kaggle.com",
  "medium.com",
  "substack.com",
  "reddit.com",
  "patreon.com",
  "cloudflare.com",
  "google.com",
  "youtube.com",
  "vimeo.com",
  "dribbble.com",
  "behance.net",
  "adobe.com",
  "purl.org",
  "flickr.com",
  "goodreads.com",
  "letterboxd.com",
  "soundcloud.com",
  "spotify.com",
  "pinterest.com",
  "tumblr.com",
  "disqus.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "apple.com",
  "microsoft.com",
  "amazonaws.com",
  "gravatar.org",
  "wikimedia.org",
  "wikipedia.org",
  "mastodon.social",
  "infosec.exchange",
  "fosstodon.org",
  "hachyderm.io",
  "bsky.social",
];

const NOISE_EMAIL_PREFIXES = [
  "privacy",
  "legal",
  "dmca",
  "abuse",
  "copyright",
  "security",
  "press",
  "support",
  "noreply",
  "no-reply",
  "webmaster",
  "hostmaster",
  "postmaster",
  "admin",
  "billing",
  "sales",
  "marketing",
  "compliance",
  "dpo",
  "gdpr",
  "feedback",
  "help",
  "tos",
  "careers",
  "jobs",
];

const TIMEZONE_HINTS = {
  "-0800": "US Pacific (UTC-8)",
  "-0700": "US Mountain/PDT (UTC-7)",
  "-0600": "US Central/MDT (UTC-6)",
  "-0500": "US Eastern/CDT (UTC-5)",
  "-0400": "US EDT/Atlantic (UTC-4)",
  "-0300": "South America East (UTC-3)",
  "+0000": "UTC / UK / West Europe",
  "+0100": "Central Europe / BST (UTC+1)",
  "+0200": "CEST / Eastern Europe (UTC+2)",
  "+0300": "MSK / East Africa / Arabia (UTC+3)",
  "+0400": "Gulf / Dubai (UTC+4)",
  "+0530": "India Standard Time (UTC+5:30)",
  "+0800": "Singapore / China / AWST (UTC+8)",
  "+0900": "Japan / Korea (UTC+9)",
  "+1000": "Australia East (UTC+10)",
};

// ---------------------------------------------------------------------------
// Local persistence (JSON vault under %LOCALAPPDATA%\TAUF)
// ---------------------------------------------------------------------------

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // ignore corrupt file
  }
  return fallback;
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function loadDefaultConfig() {
  const loaded = loadJson(CONFIG_FILE, {});
  let seeds =
    Array.isArray(loaded.custom_onion_seeds) && loaded.custom_onion_seeds.length > 0
      ? [...loaded.custom_onion_seeds]
      : [...DEFAULT_ONION_SEEDS];
  // Auto-arm OnionLand v3 alongside Ahmia v3 for existing installs
  if (!seeds.some((s) => s.includes("3bbad7fauom4d6sgppalyqddsqbf5u5p56b5k5uk2zxsy3d6ey2jobad"))) {
    seeds.push(`${ONIONLAND_V3_BASE}/search?q={query}`);
  }
  const cfg = {
    tor_socks_url: loaded.tor_socks_url || "socks5h://127.0.0.1:9050",
    proxy_url: loaded.proxy_url || null,
    local_corpus_dir: loaded.local_corpus_dir?.trim() || DEFAULT_CORPUS_DIR,
    custom_onion_seeds: seeds,
  };
  saveJson(CONFIG_FILE, cfg);
  return cfg;
}

const state = {
  cases: new Map(Object.entries(loadJson(CASES_FILE, {}))),
  config: loadDefaultConfig(),
  sseClients: new Set(),
  hasHadSseClient: false,
  activeInvestigations: 0,
  idleShutdownTimer: null,
  torChild: null,
  torBootstrapPct: 0,
  torExitIp: null,
  torExitCheckedAt: 0,
};

function cancelIdleShutdown() {
  if (state.idleShutdownTimer) {
    clearTimeout(state.idleShutdownTimer);
    state.idleShutdownTimer = null;
  }
}

function scheduleIdleShutdownIfNeeded() {
  cancelIdleShutdown();
  if (!state.hasHadSseClient || state.sseClients.size > 0 || state.activeInvestigations > 0) {
    return;
  }
  state.idleShutdownTimer = setTimeout(() => {
    if (state.sseClients.size === 0 && state.activeInvestigations === 0) {
      logRuntime("[Runtime] All UI windows closed for 20s — cleanly shutting down TAUF & Tor.");
      stopSupervisedTor();
      process.exit(0);
    }
  }, 20_000);
}

function persistCases() {
  const obj = {};
  for (const [k, v] of state.cases.entries()) obj[k] = v;
  saveJson(CASES_FILE, obj);
}

function persistConfig() {
  saveJson(CONFIG_FILE, state.config);
}

function broadcastEvent(ev) {
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of state.sseClients) {
    try {
      res.write(payload);
    } catch {
      state.sseClients.delete(res);
    }
  }
}

// ---------------------------------------------------------------------------
// Supervised Local Tor Daemon (Official Tor Expert Bundle)
// ---------------------------------------------------------------------------

function tcpProbe(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok) => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function detectLocalTor(customUrl) {
  const candidates = [];
  if (customUrl && customUrl.trim()) {
    try {
      const u = new URL(ensureSocks5h(customUrl));
      candidates.push({ host: u.hostname, port: Number(u.port) || 9050 });
    } catch {
      // ignore invalid URL
    }
  }
  candidates.push({ host: "127.0.0.1", port: 9050 }, { host: "127.0.0.1", port: 9150 });
  for (const c of candidates) {
    if (await tcpProbe(c.host, c.port)) {
      return {
        available: true,
        endpoint: `socks5h://${c.host}:${c.port}`,
        host: c.host,
        port: c.port,
      };
    }
  }
  return { available: false, endpoint: null, host: null, port: null };
}

function ensureSocks5h(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("socks5h://")) return trimmed;
  if (trimmed.startsWith("socks5://")) return `socks5h://${trimmed.slice(9)}`;
  if (trimmed.includes("://")) return trimmed;
  return `socks5h://${trimmed}`;
}

/**
 * Portable Tor binary discovery across env override, DATA_DIR/tor, ./tor, and system PATH.
 */
function detectTorBinary() {
  const binName = process.platform === "win32" ? "tor.exe" : "tor";
  const candidates = [
    process.env.TAUF_TOR_BIN?.trim() || null,
    path.join(DATA_DIR, "tor", "tor", binName),
    path.join(DATA_DIR, "tor", binName),
    path.join(__dirname, "tor", "tor", binName),
    path.join(__dirname, "tor", binName),
  ].filter(Boolean);

  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }

  // Probe system PATH (`where.exe` on Windows, `which` on macOS/Linux)
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const r = spawnSync(locator, ["tor"], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout) {
      const firstLine = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
    }
  } catch {
    // ignore PATH lookup error
  }
  return null;
}

async function startSupervisedTorIfAvailable() {
  const existing = await detectLocalTor(state.config.tor_socks_url);
  if (existing.available) {
    state.torBootstrapPct = 100;
    console.log(`[Tor] Detected existing local Tor SOCKS5h at ${existing.endpoint}`);
    return existing;
  }
  const torBin = detectTorBinary();
  if (!torBin) {
    console.log("[Tor] No portable or system tor binary found; running without managed Tor");
    return null;
  }
  if (state.torChild) return null;

  fs.mkdirSync(TOR_DATA_DIR, { recursive: true });
  const args = [
    "--SocksPort",
    "127.0.0.1:9050",
    "--DataDirectory",
    TOR_DATA_DIR,
    "--Log",
    "notice stdout",
  ];
  const binDir = path.dirname(torBin);
  const dataCandidates = [
    path.join(TOR_BUNDLE_DIR, "data"),
    path.join(binDir, "data"),
    path.join(path.dirname(binDir), "data"),
  ];
  const geoipDir = dataCandidates.find((d) => fs.existsSync(path.join(d, "geoip")));
  if (geoipDir) {
    const geoip = path.join(geoipDir, "geoip");
    const geoip6 = path.join(geoipDir, "geoip6");
    if (fs.existsSync(geoip)) args.push("--GeoIPFile", geoip);
    if (fs.existsSync(geoip6)) args.push("--GeoIPv6File", geoip6);
  }

  try {
    console.log(`[Tor] Starting supervised local Tor daemon (${torBin}) on 127.0.0.1:9050...`);
    const child = spawn(torBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    state.torChild = child;

    const parseBoot = (chunk) => {
      const txt = chunk.toString("utf8");
      const m = txt.match(/Bootstrapped\s+(\d+)%/i);
      if (m) {
        const pct = Number(m[1]);
        if (pct > state.torBootstrapPct) {
          state.torBootstrapPct = pct;
          if (pct === 100 || pct % 25 === 0) {
            console.log(`[Tor] Bootstrapped ${pct}%`);
          }
        }
      }
    };
    child.stdout?.on("data", parseBoot);
    child.stderr?.on("data", parseBoot);
    child.on("exit", () => {
      state.torChild = null;
      state.torBootstrapPct = 0;
      state.torExitIp = null;
    });

    // Wait up to 18s for Tor to bootstrap cleanly so initial traces are anonymized out of the box
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline && state.torChild) {
      if (state.torBootstrapPct >= 100 && (await tcpProbe("127.0.0.1", 9050, 400))) {
        return {
          available: true,
          endpoint: "socks5h://127.0.0.1:9050",
          host: "127.0.0.1",
          port: 9050,
        };
      }
      await new Promise((r) => setTimeout(r, 450));
    }
  } catch (err) {
    console.error("[Tor] Could not launch supervised Tor:", err instanceof Error ? err.message : err);
    state.torChild = null;
  }
  return null;
}

function stopSupervisedTor() {
  if (state.torChild) {
    try {
      state.torChild.kill();
    } catch {
      // ignore
    }
    state.torChild = null;
  }
}

process.on("SIGINT", () => {
  stopSupervisedTor();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopSupervisedTor();
  process.exit(0);
});
process.on("exit", () => stopSupervisedTor());

// ---------------------------------------------------------------------------
// Pure-Node Universal SOCKS5h Client (HTTP + HTTPS SNI + .onion, Zero DNS Leak)
// ---------------------------------------------------------------------------

function openSocks5hTunnel(proxyHost, proxyPort, targetHost, targetPort, timeoutMs = 15000, socksUser = null) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    sock.setTimeout(timeoutMs);
    const authUser = socksUser ? String(socksUser).slice(0, 120) : null;
    let stage = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    const sendConnect = () => {
      stage = 1;
      const hostBuf = Buffer.from(targetHost, "ascii");
      const req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 0x05; // VER
      req[1] = 0x01; // CONNECT
      req[2] = 0x00; // RSV
      req[3] = 0x03; // ATYP = DOMAINNAME (remote DNS resolution — zero local DNS leak!)
      req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      sock.write(req);
    };

    sock.once("connect", () => {
      // Request RFC 1929 username/password auth (0x02) when socksUser is supplied for Tor IsolateSOCKSAuth
      sock.write(authUser ? Buffer.from([0x05, 0x01, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    });

    const onData = (buf) => {
      if (stage === 0) {
        if (buf.length < 2 || buf[0] !== 0x05) {
          return fail(new Error("SOCKS5 auth negotiation failed"));
        }
        if (authUser && buf[1] === 0x02) {
          const uBuf = Buffer.from(authUser, "utf8");
          const pBuf = Buffer.from(authUser, "utf8");
          const authReq = Buffer.alloc(3 + uBuf.length + pBuf.length);
          authReq[0] = 0x01;
          authReq[1] = uBuf.length;
          uBuf.copy(authReq, 2);
          authReq[2 + uBuf.length] = pBuf.length;
          pBuf.copy(authReq, 3 + uBuf.length);
          stage = 0.5;
          sock.write(authReq);
          return;
        }
        if (buf[1] !== 0x00) {
          return fail(new Error("SOCKS5 auth negotiation failed"));
        }
        sendConnect();
      } else if (stage === 0.5) {
        if (buf.length < 2 || buf[0] !== 0x01 || buf[1] !== 0x00) {
          return fail(new Error("SOCKS5 RFC1929 authentication failed"));
        }
        sendConnect();
      } else if (stage === 1) {
        if (buf.length < 2 || buf[0] !== 0x05 || buf[1] !== 0x00) {
          return fail(new Error(`SOCKS5h connect failed (reply=0x${buf[1]?.toString(16) || "ff"})`));
        }
        settled = true;
        sock.removeListener("data", onData);
        sock.removeListener("timeout", onTimeout);
        sock.removeListener("error", onError);
        resolve(sock);
      }
    };

    const onTimeout = () => fail(new Error("SOCKS5h connect timed out"));
    const onError = (err) => fail(err);

    sock.on("data", onData);
    sock.once("timeout", onTimeout);
    sock.once("error", onError);
  });
}

function decodeChunkedBody(buf) {
  const parts = [];
  let offset = 0;
  while (offset < buf.length) {
    const crlf = buf.indexOf("\r\n", offset);
    if (crlf === -1) break;
    const sizeHex = buf.subarray(offset, crlf).toString("ascii").split(";")[0].trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = crlf + 2;
    const end = start + size;
    if (end > buf.length) {
      parts.push(buf.subarray(start));
      break;
    }
    parts.push(buf.subarray(start, end));
    offset = end + 2;
  }
  return Buffer.concat(parts);
}

async function socks5hRequest(proxyHost, proxyPort, rawUrl, opts = {}, redirectDepth = 0) {
  if (redirectDepth > 5) {
    throw new Error("Too many redirects over SOCKS5h");
  }
  const parsed = new URL(rawUrl);
  const isHttps = parsed.protocol === "https:";
  const targetHost = parsed.hostname;
  const targetPort = Number(parsed.port) || (isHttps ? 443 : 80);
  const method = (opts.method || "GET").toUpperCase();
  const timeoutMs = opts.timeoutMs || 15000;
  const maxBytes = opts.maxBytes || 2_200_000;

  // Subtle jitter to prevent synchronized traffic bursts over Tor
  if (opts.jitter !== false) {
    await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 45)));
  }

  const rawSock = await openSocks5hTunnel(
    proxyHost,
    proxyPort,
    targetHost,
    targetPort,
    timeoutMs,
    opts.socksUser || null
  );

  const stream = isHttps
    ? await new Promise((resolve, reject) => {
        const tlsSock = tls.connect(
          {
            socket: rawSock,
            servername: targetHost,
            ALPNProtocols: ["http/1.1"],
            rejectUnauthorized: opts.rejectUnauthorized !== false,
          },
          () => resolve(tlsSock)
        );
        tlsSock.setTimeout(timeoutMs);
        tlsSock.once("error", reject);
        tlsSock.once("timeout", () => {
          tlsSock.destroy();
          reject(new Error("TLS handshake timed out over Tor"));
        });
      })
    : rawSock;

  const responseBuf = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      try {
        stream.destroy();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(data);
    };

    const reqPath = `${parsed.pathname || "/"}${parsed.search || ""}`;
    const hdrs = {
      Host: parsed.port ? `${targetHost}:${parsed.port}` : targetHost,
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "close",
      ...(opts.headers || {}),
    };
    delete hdrs.Referer;
    delete hdrs.referer;
    delete hdrs.Origin;
    delete hdrs.origin;

    const headerLines = Object.entries(hdrs)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");

    stream.setTimeout(timeoutMs);
    stream.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        finish(null, Buffer.concat(chunks));
      }
    });
    stream.once("end", () => finish(null, Buffer.concat(chunks)));
    stream.once("timeout", () => finish(new Error("SOCKS5h read timed out")));
    stream.once("error", (err) => finish(err));

    stream.write(`${method} ${reqPath} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
  });

  const sepIdx = responseBuf.indexOf("\r\n\r\n");
  if (sepIdx === -1) {
    throw new Error("Malformed HTTP response over SOCKS5h");
  }
  const headStr = responseBuf.subarray(0, sepIdx).toString("latin1");
  let bodyBuf = responseBuf.subarray(sepIdx + 4);
  const headLines = headStr.split("\r\n");
  const statusMatch = headLines[0].match(/^HTTP\/\d\.\d\s+(\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const headers = new Map();
  for (const ln of headLines.slice(1)) {
    const colon = ln.indexOf(":");
    if (colon !== -1) {
      headers.set(ln.slice(0, colon).trim().toLowerCase(), ln.slice(colon + 1).trim());
    }
  }

  if ([301, 302, 303, 307, 308].includes(status) && headers.get("location")) {
    const nextUrl = new URL(headers.get("location"), rawUrl).toString();
    return socks5hRequest(proxyHost, proxyPort, nextUrl, opts, redirectDepth + 1);
  }

  if (method !== "HEAD") {
    const te = (headers.get("transfer-encoding") || "").toLowerCase();
    if (te.includes("chunked")) {
      bodyBuf = decodeChunkedBody(bodyBuf);
    }
    const ce = (headers.get("content-encoding") || "").toLowerCase();
    const decompressPartial = (buf, fn) => {
      for (let trim = 0; trim <= 8 && trim < buf.length; trim++) {
        try {
          const slice = trim === 0 ? buf : buf.subarray(0, buf.length - trim);
          return fn(slice, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch {
          // retry trimming partial trailing byte/trailer
        }
      }
      return buf;
    };
    if (ce.includes("gzip")) bodyBuf = decompressPartial(bodyBuf, zlib.gunzipSync);
    else if (ce.includes("deflate")) bodyBuf = decompressPartial(bodyBuf, zlib.inflateSync);
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    url: rawUrl,
    headers: {
      get: (k) => headers.get(String(k).toLowerCase()) || null,
    },
    text: async () => bodyBuf.toString("utf8"),
    arrayBuffer: async () => bodyBuf,
    buffer: bodyBuf,
  };
}

async function fetchDirectWithTimeout(url, options = {}, timeoutMs = 8500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      "User-Agent": UA,
      ...(options.headers || {}),
    };
    delete headers.Referer;
    delete headers.referer;
    const resp = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers,
      redirect: "follow",
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sovereign universal fetch wrapper:
 * - Routes over local Tor socks5h:// whenever Tor/proxy is active
 * - Enforces FAIL-CLOSED when strict_anonymity is enabled and no Tor/proxy is reachable
 * - Falls back to direct laptop fetch only when strict_anonymity is explicitly false
 */
async function sovereignFetch(url, options = {}, netCtx = null, timeoutMs = 11000) {
  const isOnion = /\.onion(?:[:/]|$)/i.test(url);
  if (netCtx?.strictAnonymity && !netCtx?.proxyHost) {
    throw new Error("STRICT_ANONYMITY_BLOCKED: Tor/SOCKS5h proxy offline (fail-closed)");
  }
  if (isOnion) {
    if (!netCtx?.proxyHost) {
      throw new Error("TOR_REQUIRED: .onion requests require live local Tor SOCKS5h");
    }
    return socks5hRequest(netCtx.proxyHost, netCtx.proxyPort, url, {
      ...options,
      timeoutMs: Math.max(timeoutMs, 18000),
    });
  }
  if (netCtx?.proxyHost) {
    return socks5hRequest(netCtx.proxyHost, netCtx.proxyPort, url, {
      ...options,
      timeoutMs: Math.max(timeoutMs, 6000),
    });
  }
  return fetchDirectWithTimeout(url, options, timeoutMs);
}

/**
 * Direct HTML check against official Tor Project verification page over Tor SOCKS5h
 * (not an external OSINT API — confirms genuine Tor routing & live exit IP).
 */
async function checkTorExitIp(host, port, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && state.torExitIp && now - state.torExitCheckedAt < 300_000) {
    return state.torExitIp;
  }
  try {
    const resp = await socks5hRequest(host, port, "https://check.torproject.org/", {
      timeoutMs: 14000,
      jitter: false,
    });
    if (resp.ok) {
      const html = await resp.text();
      if (html.includes("configured to use Tor")) {
        const m = html.match(/Your IP address appears to be:\s*<strong>([^<]+)<\/strong>/i);
        if (m) {
          state.torExitIp = m[1].trim();
          state.torExitCheckedAt = now;
          return state.torExitIp;
        }
      }
    }
  } catch {
    // Tor may still be finishing circuit build
  }
  return state.torExitIp;
}

// ---------------------------------------------------------------------------
// Graph normalization, multi-signal entity resolution & consensus helpers
// ---------------------------------------------------------------------------

function normalizeNodeId(kind, value) {
  const cleanKind = String(kind || "entity").trim().toLowerCase();
  const cleanVal = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._\-@+:]/g, "_")
    .split("_")
    .filter(Boolean)
    .join("_");
  return `${cleanKind}:${cleanVal}`;
}

const PLATFORM_SLUG_ALIASES = {
  x: "x_twitter",
  twitter: "x_twitter",
  "x/twitter": "x_twitter",
  x_twitter: "x_twitter",
  "x.com": "x_twitter",
  "twitter.com": "x_twitter",
  github: "github",
  "github.com": "github",
  githubgist: "gist",
  gist: "gist",
  "gist.github.com": "gist",
  gitlab: "gitlab",
  "gitlab.com": "gitlab",
  instagram: "instagram",
  "instagram.com": "instagram",
  linkedin: "linkedin",
  "linkedin.com": "linkedin",
  youtube: "youtube",
  "youtube.com": "youtube",
  threads: "threads",
  "threads.net": "threads",
  facebook: "facebook",
  "facebook.com": "facebook",
  reddit: "reddit",
  "reddit.com": "reddit",
  "old.reddit.com": "reddit",
  medium: "medium",
  "medium.com": "medium",
  "dev.to": "devto",
  devto: "devto",
  "dev community": "devto",
  hackernews: "hackernews",
  "hacker news": "hackernews",
  producthunt: "producthunt",
  "product hunt": "producthunt",
  dockerhub: "dockerhub",
  "docker hub": "dockerhub",
  huggingface: "huggingface",
  "hugging face": "huggingface",
  stackoverflow: "stackoverflow",
  "stack overflow": "stackoverflow",
  keybase: "keybase",
  "keybase.io": "keybase",
  telegram: "telegram",
  "t.me": "telegram",
  kaggle: "kaggle",
  "kaggle.com": "kaggle",
  behance: "behance",
  "behance.net": "behance",
  dribbble: "dribbble",
  "dribbble.com": "dribbble",
};

function normalizePlatformSlug(platform) {
  const raw = String(platform || "profile").trim().toLowerCase();
  if (PLATFORM_SLUG_ALIASES[raw]) return PLATFORM_SLUG_ALIASES[raw];
  const stripped = raw.replace(/\.(com|org|net|io|dev|social|exchange|me|tv)$/i, "");
  if (PLATFORM_SLUG_ALIASES[stripped]) return PLATFORM_SLUG_ALIASES[stripped];
  return (
    raw
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "profile"
  );
}

function normalizeAccountNodeId(platform, handle) {
  const platSlug = normalizePlatformSlug(platform);
  const cleanHandle = String(handle || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  return normalizeNodeId("account", `${platSlug}@${cleanHandle || "unknown"}`);
}

function normUrlForMatch(u) {
  if (!u) return "";
  try {
    const parsed = new URL(String(u).trim());
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathClean = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${pathClean}${parsed.search.toLowerCase()}`;
  } catch {
    return String(u || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .replace(/\/+$/, "");
  }
}

function isAuthWalledUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return Array.from(AUTH_WALLED_HOSTS).some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const SIDECAR_SOFT_404_PHRASES = [
  "page not found",
  "user not found",
  "profile not found",
  "this account doesn't exist",
  "this user doesn't exist",
  "user does not exist",
  "sorry, this page isn't available",
  "the page you were looking for doesn't exist",
  "the page you are looking for doesn't exist",
  "there is no page",
  "404 not found",
  "404 - not found",
  "error 404",
  "no such user",
  "account suspended",
  "account not found",
  "page couldn't be found",
  "whoops, that page is gone",
  "we seem to have lost this page",
  "sorry, we couldn't find that page",
  "doesn't exist on",
  "if you have <strong>telegram</strong>, you can contact",
  "vercel security checkpoint",
  "whoa there, pardner",
  "blocked by network security",
];

async function verifyLiveAccountUrl(url, netCtx) {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, reason: "invalid_url" };
  if (/\.(atom|rss|xml|json|keys|gpg|asc|png|jpg|jpeg|svg|css|js|ico|txt|pdf)(?:$|[?#])/i.test(url)) {
    return { ok: false, reason: "feed_or_asset_url" };
  }
  if (isBlockedSpaUrl(url)) return { ok: false, reason: "blocked_spa" };
  if (isAuthWalledUrl(url)) return { ok: true, skippedAuthWall: true };
  try {
    const resp = await sovereignFetch(url, { maxBytes: 24576, jitter: false }, netCtx, 5000);
    if (!resp.ok || resp.status === 404 || resp.status === 410) {
      return { ok: false, reason: `http_${resp.status}` };
    }
    if (/\/(?:404|not[-_]?found)(?:$|[/?#])/i.test(resp.url || "")) {
      return { ok: false, reason: "redirect_404" };
    }
    const body = (await resp.text()).slice(0, 24576);
    const titleM = body.match(/<title[^>]*>([^<]{1,160})<\/title>/i);
    if (titleM && /^\s*(?:404\b|not found\b|page not found\b|error\s*404\b)/i.test(titleM[1])) {
      return { ok: false, reason: "title_404" };
    }
    const low = body.toLowerCase();
    if (/reddit\.com\/(?:user|u)\//i.test(url)) {
      const tClean = titleM ? titleM[1].trim().toLowerCase() : "";
      if (
        tClean === "reddit" ||
        (body.length < 15000 && !/\/u\/[a-z0-9_-]{2,}/i.test(body)) ||
        low.includes("whoa there, pardner") ||
        low.includes("blocked by network security")
      ) {
        return { ok: false, reason: "reddit_block_shell" };
      }
    }
    if (SIDECAR_SOFT_404_PHRASES.some((p) => low.includes(p))) {
      return { ok: false, reason: "soft_404" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

function extractPlatformAndHandleFromSidecar(ev) {
  const evMeta = ev.metadata && typeof ev.metadata === "object" ? ev.metadata : {};
  let platform = evMeta.platform ? String(evMeta.platform).trim() : "";
  let handle = evMeta.handle || evMeta.username ? String(evMeta.handle || evMeta.username).trim() : "";

  if (!platform || !handle) {
    const labelStr = String(ev.label || "").trim();
    const pm = labelStr.match(/^([^(]+?)\s*\(([^)]+)\)$/);
    if (pm) {
      if (!platform) platform = pm[1].trim();
      if (!handle) handle = pm[2].trim();
    }
  }

  if (ev.url) {
    try {
      const u = new URL(ev.url);
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (!platform) {
        if (host.includes("github.com")) platform = host.startsWith("gist.") ? "Gist" : "GitHub";
        else if (host.includes("gitlab.com")) platform = "GitLab";
        else if (host.includes("instagram.com")) platform = "Instagram";
        else if (host.includes("linkedin.com")) platform = "LinkedIn";
        else if (host === "x.com" || host === "twitter.com") platform = "X/Twitter";
        else if (host.includes("youtube.com")) platform = "YouTube";
        else if (host.includes("reddit.com")) platform = "Reddit";
        else if (host.includes("medium.com")) platform = "Medium";
        else if (host.includes("dev.to")) platform = "Dev.to";
        else if (host.includes("ycombinator.com")) platform = "HackerNews";
        else platform = host.split(".")[0];
      }
      if (!handle) {
        if (host.includes("ycombinator.com")) {
          handle = u.searchParams.get("id") || "";
        } else if (host.endsWith(".blogspot.com") || host.endsWith(".gumroad.com") || host.endsWith(".itch.io")) {
          handle = host.split(".")[0];
        } else if (host.endsWith(".medium.com") && host !== "medium.com") {
          handle = host.split(".")[0];
        } else {
          const segs = u.pathname.split("/").filter(Boolean);
          const skip = new Set(["u", "user", "users", "in", "member", "profile", "profiles", "author", "p", "~"]);
          const meaningful = segs.find((s) => !skip.has(s.toLowerCase()));
          if (meaningful) handle = meaningful;
        }
      }
    } catch {
      // ignore invalid URL
    }
  }

  const rawHandle = String(handle || "").replace(/^@+/, "").trim();
  const rejectedFeedOrAsset =
    Boolean(ev.url && /\.(atom|rss|xml|json|keys|gpg|asc|png|jpg|jpeg|svg|css|js|ico|txt|pdf)(?:$|[?#])/i.test(ev.url)) ||
    /\.(atom|rss|xml|json|keys|gpg|asc|png|jpg|jpeg|svg|css|js|ico|txt|pdf)$/i.test(rawHandle);
  handle = rawHandle.replace(/\.(atom|rss|xml|json|keys|gpg)$/i, "");
  if (!platform) platform = "Profile";
  if (!handle) handle = String(ev.label || ev.tool || "unknown").trim();
  return { platform, handle, rejectedFeedOrAsset };
}

function buildCanonicalProfileUrl(platform, handle) {
  const clean = String(handle || "").replace(/^@+/, "").trim();
  if (!clean) return null;
  const slug = normalizePlatformSlug(platform);
  switch (slug) {
    case "instagram": return `https://www.instagram.com/${clean}/`;
    case "linkedin": return `https://www.linkedin.com/in/${clean}`;
    case "x_twitter": return `https://x.com/${clean}`;
    case "youtube": return `https://www.youtube.com/@${clean}`;
    case "tiktok": return `https://www.tiktok.com/@${clean}`;
    case "threads": return `https://www.threads.net/@${clean}`;
    case "facebook": return `https://www.facebook.com/${clean}`;
    case "github": return `https://github.com/${clean}`;
    case "gitlab": return `https://gitlab.com/${clean}`;
    case "keybase": return `https://keybase.io/${clean}`;
    case "telegram": return `https://t.me/${clean}`;
    case "medium": return `https://medium.com/@${clean}`;
    case "reddit": return `https://www.reddit.com/user/${clean}`;
    case "devto": return `https://dev.to/${clean}`;
    case "kaggle": return `https://www.kaggle.com/${clean}`;
    case "behance": return `https://www.behance.net/${clean}`;
    case "dribbble": return `https://dribbble.com/${clean}`;
    default: return null;
  }
}

/**
 * Post-stage graph integrity verification:
 * - Zero self-loops
 * - Zero broken edge endpoints
 * - Zero orphan nodes (all nodes reachable from seedId)
 * - Accurate BFS hop depth from seedId on every node
 */
function ensureGraphIntegrity(snap, seedId) {
  const nodeMap = new Map(snap.nodes.map((n) => [n.id, n]));
  const seenEdgeIds = new Set();
  const cleanEdges = [];
  for (const e of snap.edges) {
    if (!e || !e.source || !e.target) continue;
    if (e.source === e.target) continue;
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;
    if (seenEdgeIds.has(e.id)) continue;
    seenEdgeIds.add(e.id);
    cleanEdges.push(e);
  }
  snap.edges = cleanEdges;

  if (!nodeMap.has(seedId)) return;

  // Compute reachability & hop depth from seedId (directed first, undirected fallback for any reverse edges)
  const dirAdj = new Map();
  const undirAdj = new Map();
  for (const e of snap.edges) {
    if (!dirAdj.has(e.source)) dirAdj.set(e.source, []);
    dirAdj.get(e.source).push(e.target);
    if (!undirAdj.has(e.source)) undirAdj.set(e.source, []);
    if (!undirAdj.has(e.target)) undirAdj.set(e.target, []);
    undirAdj.get(e.source).push(e.target);
    undirAdj.get(e.target).push(e.source);
  }

  const depths = new Map([[seedId, 0]]);
  const queue = [seedId];
  while (queue.length > 0) {
    const curr = queue.shift();
    const d = depths.get(curr);
    for (const nxt of dirAdj.get(curr) || []) {
      if (!depths.has(nxt)) {
        depths.set(nxt, d + 1);
        queue.push(nxt);
      }
    }
  }

  // Pass 2: traverse undirected edges from any reached node to ensure connected components get hop depth
  const uQueue = Array.from(depths.keys());
  while (uQueue.length > 0) {
    const curr = uQueue.shift();
    const d = depths.get(curr);
    for (const nxt of undirAdj.get(curr) || []) {
      if (!depths.has(nxt)) {
        depths.set(nxt, d + 1);
        uQueue.push(nxt);
      }
    }
  }

  // Pass 3: attach any truly orphan nodes to seedId so 0 orphan nodes remain
  for (const n of snap.nodes) {
    if (!depths.has(n.id)) {
      const edge = upsertEdge(snap, {
        id: `${seedId}__related_entity__${n.id}`,
        source: seedId,
        target: n.id,
        relation: "related_entity",
        confidence: Math.min(0.75, n.confidence || 0.6),
        sources: n.sources?.length ? [n.sources[0]] : ["graph-integrity"],
      });
      broadcastEvent({ kind: "edge", case_id: snap.case_id, edge });
      depths.set(n.id, 1);
    }
  }

  for (const n of snap.nodes) {
    const d = depths.get(n.id);
    if (typeof d === "number" && n.depth !== d) {
      n.depth = d;
      broadcastEvent({ kind: "node", case_id: snap.case_id, node: n });
    }
  }
}

function mergeConfidence(existing, incoming, sourceCount) {
  const base = Math.max(existing, incoming);
  const bonus = Math.min(0.24, Math.max(0, sourceCount - 1) * 0.08);
  return Math.max(0.05, Math.min(0.99, base + bonus));
}

function computeStats(nodes, findings, toolRuns) {
  const activeNodes = nodes.filter((n) => n.status !== "dismissed");
  const dismissedIds = new Set(
    nodes.filter((n) => n.status === "dismissed").map((n) => n.id)
  );
  const activeFindings = findings.filter((f) => !dismissedIds.has(f.node_id));
  const confirmedAnchors = activeNodes.filter(
    (n) =>
      n.status === "confirmed" ||
      (n.layer === "anchor" && n.confidence >= 0.72) ||
      n.metadata?.match_tier === "verified"
  ).length;
  const verifiedFindings = activeFindings.filter(
    (f) => f.consensus_count >= 2 || f.confidence >= 0.7
  ).length;
  const darkwebHits = activeFindings.filter((f) => f.category === "darkweb").length;
  const breachHits = activeFindings.filter((f) => f.category === "breach").length;
  const toolsCompleted = toolRuns.filter((t) =>
    ["done", "skipped", "error"].includes(t.state)
  ).length;
  return {
    total_nodes: activeNodes.length,
    confirmed_anchors: confirmedAnchors,
    verified_findings: verifiedFindings,
    low_conf_findings: Math.max(0, activeFindings.length - verifiedFindings),
    darkweb_hits: darkwebHits,
    breach_hits: breachHits,
    tools_completed: toolsCompleted,
    tools_total: toolRuns.length,
  };
}

function upsertNode(snap, incoming) {
  const idx = snap.nodes.findIndex((n) => n.id === incoming.id);
  if (idx === -1) {
    snap.nodes.push(incoming);
    return incoming;
  }
  const ex = snap.nodes[idx];
  const sources = Array.from(new Set([...ex.sources, ...incoming.sources]));
  const mergedMeta = { ...ex.metadata, ...incoming.metadata };
  // Never downgrade a verified match_tier back to collision/probable
  const tierRank = { verified: 3, probable: 2, collision: 1 };
  const exRank = tierRank[ex.metadata?.match_tier] || 0;
  const inRank = tierRank[incoming.metadata?.match_tier] || 0;
  if (exRank > inRank) {
    mergedMeta.match_tier = ex.metadata.match_tier;
    if (ex.metadata.match_reason) mergedMeta.match_reason = ex.metadata.match_reason;
  }

  const merged = {
    ...ex,
    sublabel: ex.sublabel || incoming.sublabel,
    url: ex.url || incoming.url,
    layer:
      ex.layer === "seed" || ex.layer === "darkweb"
        ? ex.layer
        : incoming.layer === "anchor" || incoming.layer === "darkweb"
        ? incoming.layer
        : ex.layer,
    confidence:
      mergedMeta.match_tier === "collision"
        ? Math.min(0.46, Math.max(ex.confidence, incoming.confidence))
        : mergeConfidence(ex.confidence, incoming.confidence, sources.length),
    sources,
    metadata: mergedMeta,
    depth: Math.min(ex.depth, incoming.depth),
  };
  snap.nodes[idx] = merged;
  return merged;
}

function upsertEdge(snap, incoming) {
  const idx = snap.edges.findIndex((e) => e.id === incoming.id);
  if (idx === -1) {
    snap.edges.push(incoming);
    return incoming;
  }
  const ex = snap.edges[idx];
  const sources = Array.from(new Set([...ex.sources, ...incoming.sources]));
  const merged = {
    ...ex,
    confidence: mergeConfidence(ex.confidence, incoming.confidence, sources.length),
    sources,
  };
  snap.edges[idx] = merged;
  return merged;
}

function upsertFinding(snap, incoming) {
  const idx = snap.findings.findIndex((f) => f.id === incoming.id);
  if (idx === -1) {
    snap.findings.push(incoming);
    return incoming;
  }
  const ex = snap.findings[idx];
  const sources = Array.from(new Set([...ex.sources, ...incoming.sources]));
  const merged = {
    ...ex,
    sources,
    consensus_count: sources.length,
    confidence: mergeConfidence(ex.confidence, incoming.confidence, sources.length),
    sensitive_fields: Array.from(
      new Set([...ex.sensitive_fields, ...incoming.sensitive_fields])
    ),
  };
  snap.findings[idx] = merged;
  return merged;
}

function upsertToolRun(snap, status) {
  const idx = snap.tool_runs.findIndex((t) => t.tool === status.tool);
  if (idx === -1) snap.tool_runs.push(status);
  else snap.tool_runs[idx] = status;
}

function getNameParts(fullName) {
  return String(fullName || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function hasFullNameMatch(text, fullName) {
  const low = String(text || "").toLowerCase();
  const parts = getNameParts(fullName);
  if (parts.length === 0) return false;
  if (parts.length === 1) return low.includes(parts[0]);
  const first = parts[0];
  const last = parts[parts.length - 1];
  return low.includes(first) && low.includes(last);
}

function sharesNameToken(candidate, fullName) {
  const low = String(candidate || "").toLowerCase();
  return getNameParts(fullName)
    .filter((w) => w.length >= 3)
    .some((tok) => low.includes(tok));
}

function isNoiseEmail(em) {
  const clean = String(em || "").trim().toLowerCase();
  if (!clean.includes("@")) return true;
  if (/\.(png|jpg|jpeg|svg|webp|gif|css|js|ico|woff|woff2|ttf)$/i.test(clean)) return true;
  const [local, dom] = clean.split("@");
  if (!local || !dom || !dom.includes(".")) return true;
  if (PLATFORM_NOISE_DOMAINS.some((b) => dom === b || dom.endsWith(`.${b}`))) return true;
  if (NOISE_EMAIL_PREFIXES.some((p) => local === p || local.startsWith(p))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Engine 1: Permutator
// ---------------------------------------------------------------------------

function normalizeDomain(domain, org) {
  if (domain && domain.trim()) {
    const clean = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (clean.includes(".")) return clean;
  }
  if (org && org.trim() && org.trim().includes(".")) {
    return org
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
  }
  return null;
}

function generateHandles(fullName, seedHandle) {
  const out = [];
  const seen = new Set();
  const push = (handle, pattern) => {
    const clean = String(handle || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase()
      .replace(/[^a-z0-9._\-]/g, "");
    if (clean.length >= 2 && !seen.has(clean)) {
      seen.add(clean);
      out.push({ handle: clean, pattern });
    }
  };
  if (seedHandle) push(seedHandle, "seed_handle");
  const parts = getNameParts(fullName);
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    // Specific full-name handles first (much lower collision rate than flast)
    push(`${first}${last}`, "firstlast");
    push(`${first}.${last}`, "first.last");
    push(`${first}-${last}`, "first-last");
    push(`${first}_${last}`, "first_last");
    push(`${first[0]}${last}`, "flast");
    if (last.length >= 6) {
      push(last, "lastname");
    }
    push(`${last}${first[0]}`, "lastf");
  } else if (parts.length === 1) {
    push(parts[0], "single");
  }
  return out;
}

function generateCorporateEmails(fullName, domain, seedEmail) {
  const out = [];
  const seen = new Set();
  const push = (em) => {
    const clean = String(em || "").trim().toLowerCase();
    if (clean.includes("@") && !isNoiseEmail(clean) && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };
  if (seedEmail) push(seedEmail);
  const parts = getNameParts(fullName);
  if (parts.length >= 2 && domain) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    push(`${first}.${last}@${domain}`);
    push(`${first[0]}${last}@${domain}`);
    push(`${first}@${domain}`);
    push(`${first}_${last}@${domain}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engine 2: Direct OpenPGP HKP Keyserver Lookup
// ---------------------------------------------------------------------------

async function lookupHkp(query, netCtx) {
  const url = `https://keyserver.ubuntu.com/pks/lookup?op=index&options=mr&search=${encodeURIComponent(
    query
  )}`;
  const resp = await sovereignFetch(url, {}, netCtx, 11000);
  if (!resp.ok) return [];
  const text = await resp.text();
  const records = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("pub:")) {
      if (current) records.push(current);
      const cols = line.split(":");
      current = {
        key_id: cols[1] || "",
        key_len: cols[3] || "",
        flags: cols[6] || "",
        uids: [],
      };
    } else if (line.startsWith("uid:") && current) {
      const cols = line.split(":");
      let uidStr = cols[1] || "";
      try {
        uidStr = decodeURIComponent(uidStr);
      } catch {
        // leave raw
      }
      const emMatch = uidStr.match(/<([^>\s]+@[^>\s]+)>/);
      const email = emMatch ? emMatch[1].toLowerCase() : null;
      const display_name = uidStr.replace(/<[^>]+>/, "").trim() || uidStr;
      current.uids.push({ raw_uid: uidStr, display_name, email });
    }
  }
  if (current) records.push(current);
  return records.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Engine 3: Direct DNS (MX/SPF/DMARC), TLS X.509 Cert Inspector & Gravatar HEAD
// ---------------------------------------------------------------------------

async function inspectDomainDns(domain, netCtx) {
  const report = {
    mx_records: [],
    spf_record: null,
    dmarc_record: null,
    mail_provider_hint: null,
  };
  // In strict anonymity mode routed over Tor, skip local UDP DNS to avoid local DNS leak!
  if (netCtx?.strictAnonymity && netCtx?.proxyHost) {
    return report;
  }
  try {
    const mx = await dns.resolveMx(domain);
    report.mx_records = mx.map((m) => m.exchange.toLowerCase()).slice(0, 6);
    const joined = report.mx_records.join(" ");
    if (joined.includes("google") || joined.includes("aspmx"))
      report.mail_provider_hint = "Google Workspace";
    else if (joined.includes("outlook") || joined.includes("protection.outlook"))
      report.mail_provider_hint = "Microsoft 365";
    else if (joined.includes("protonmail")) report.mail_provider_hint = "Proton Mail";
    else if (joined.includes("fastmail")) report.mail_provider_hint = "Fastmail";
    else if (joined.includes("mimecast")) report.mail_provider_hint = "Mimecast";
    else if (joined.includes("pphosted")) report.mail_provider_hint = "Proofpoint";
  } catch {
    // ignore
  }
  try {
    const txt = await dns.resolveTxt(domain);
    for (const chunks of txt) {
      const joined = chunks.join("");
      if (joined.toLowerCase().startsWith("v=spf1")) {
        report.spf_record = joined;
        break;
      }
    }
  } catch {
    // ignore
  }
  try {
    const dmarc = await dns.resolveTxt(`_dmarc.${domain}`);
    for (const chunks of dmarc) {
      const joined = chunks.join("");
      if (joined.toLowerCase().startsWith("v=dmarc1")) {
        report.dmarc_record = joined;
        break;
      }
    }
  } catch {
    // ignore
  }
  return report;
}

/**
 * Direct TLS X.509 Certificate Inspector (zero external CT/SaaS APIs!).
 * Connects directly (or via Tor SOCKS5h tunnel!) on port 443 and extracts Subject Org, CN, and SANs.
 */
async function inspectDomainTlsCert(domain, netCtx) {
  try {
    let baseSocket = null;
    if (netCtx?.proxyHost) {
      baseSocket = await openSocks5hTunnel(netCtx.proxyHost, netCtx.proxyPort, domain, 443, 9000);
    } else if (netCtx?.strictAnonymity) {
      return null;
    }
    return await new Promise((resolve) => {
      const sock = tls.connect(
        baseSocket
          ? { socket: baseSocket, servername: domain, rejectUnauthorized: false }
          : { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
        () => {
          try {
            const cert = sock.getPeerCertificate();
            sock.destroy();
            if (!cert || !cert.subject) return resolve(null);
            const sans = String(cert.subjectaltname || "")
              .split(",")
              .map((s) => s.trim().replace(/^DNS:/i, ""))
              .filter(Boolean)
              .slice(0, 10);
            resolve({
              cn: cert.subject.CN || null,
              org: cert.subject.O || null,
              issuer: cert.issuer?.O || cert.issuer?.CN || null,
              sans,
            });
          } catch {
            sock.destroy();
            resolve(null);
          }
        }
      );
      sock.setTimeout(7000);
      sock.once("error", () => {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        resolve(null);
      });
      sock.once("timeout", () => {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        resolve(null);
      });
    });
  } catch {
    return null;
  }
}

async function checkGravatarRawHash(email, netCtx) {
  const md5 = crypto
    .createHash("md5")
    .update(email.trim().toLowerCase())
    .digest("hex");
  const avatarUrl = `https://www.gravatar.com/avatar/${md5}?d=404`;
  try {
    const resp = await sovereignFetch(avatarUrl, { method: "HEAD" }, netCtx, 8000);
    if (resp.status === 200) return { md5, avatarUrl };
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine 4: Deep Raw GitHub & GitLab Harvester (HTML + .keys + .gpg + .atom + .patch)
// ---------------------------------------------------------------------------

function extractUidsFromPgpArmor(armor) {
  const lines = armor.split(/\r?\n/);
  const b64Lines = [];
  let inBody = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("-----BEGIN PGP")) {
      inBody = true;
      continue;
    }
    if (t.startsWith("-----END PGP")) break;
    if (!inBody) continue;
    if (!t || t.includes(":") || t.startsWith("=")) continue;
    b64Lines.push(t);
  }
  if (!b64Lines.length) return { uids: [], emails: [], key_id: null };
  const buf = Buffer.from(b64Lines.join(""), "base64");
  const uids = [];
  const emails = new Set();
  let key_id = null;
  let i = 0;
  while (i < buf.length) {
    const h = buf[i];
    if ((h & 0x80) === 0) break;
    let tag = 0;
    let bodyLen = 0;
    let headerLen = 1;
    if ((h & 0x40) !== 0) {
      tag = h & 0x3f;
      if (i + 1 >= buf.length) break;
      const b1 = buf[i + 1];
      if (b1 < 192) {
        bodyLen = b1;
        headerLen = 2;
      } else if (b1 < 224 && i + 2 < buf.length) {
        bodyLen = ((b1 - 192) << 8) + buf[i + 2] + 192;
        headerLen = 3;
      } else if (b1 === 255 && i + 5 < buf.length) {
        bodyLen = buf.readUInt32BE(i + 2);
        headerLen = 6;
      } else {
        break;
      }
    } else {
      tag = (h >> 2) & 0x0f;
      const lt = h & 0x03;
      if (lt === 0 && i + 1 < buf.length) {
        bodyLen = buf[i + 1];
        headerLen = 2;
      } else if (lt === 1 && i + 2 < buf.length) {
        bodyLen = buf.readUInt16BE(i + 1);
        headerLen = 3;
      } else if (lt === 2 && i + 4 < buf.length) {
        bodyLen = buf.readUInt32BE(i + 1);
        headerLen = 5;
      } else {
        break;
      }
    }
    const start = i + headerLen;
    const end = start + bodyLen;
    if (end > buf.length) break;
    if (tag === 6 && !key_id && bodyLen >= 6) {
      const pktBody = buf.subarray(start, end);
      if (pktBody[0] === 4) {
        const hdr = Buffer.from([0x99, (bodyLen >> 8) & 0xff, bodyLen & 0xff]);
        key_id = crypto.createHash("sha1").update(hdr).update(pktBody).digest("hex").toUpperCase();
      } else {
        key_id = crypto.createHash("sha1").update(pktBody).digest("hex").slice(0, 16).toUpperCase();
      }
    } else if (tag === 13) {
      const uid = buf.subarray(start, end).toString("utf8").trim();
      if (uid) {
        uids.push(uid);
        const m = uid.match(/<([^>\s]+@[^>\s]+)>/);
        if (m) {
          const em = m[1].toLowerCase();
          if (!isNoiseEmail(em)) emails.add(em);
        }
      }
    }
    i = end;
  }
  return { uids, emails: Array.from(emails), key_id };
}

async function probeGithubRawDeep(handle, netCtx) {
  const clean = handle.trim().replace(/^@/, "");
  const profile_url = `https://github.com/${encodeURIComponent(clean)}`;
  const res = {
    handle: clean,
    profile_url,
    exists: false,
    display_name: null,
    bio: null,
    org: null,
    location: null,
    website: null,
    followers: null,
    skills: [],
    pinned_repos: [],
    avatar_url: null,
    ssh_keys: [],
    gpg_emails: [],
    gpg_key_id: null,
    patch_emails: [], // [{ email, author_name, repo, sha, tz_offset, tz_region, commit_hour }]
    timezones: [],
    commit_hours: [],
    repos: [],
    repo_urls: [],
    external_links: [],
  };

  try {
    const r = await sovereignFetch(profile_url, {}, netCtx, 10000);
    if (!r.ok) return res;
    const html = await r.text();
    if (html.includes("Not Found") || !html.includes("og:title")) return res;
    res.exists = true;

    const og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (og) res.display_name = og[1].replace(/\s*-\s*Overview.*$/i, "").trim();
    const bioM =
      html.match(/class="p-note user-profile-bio[^"]*"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/i) ||
      html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (bioM) {
      const cleanedBio = bioM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (cleanedBio && !cleanedBio.toLowerCase().includes("has ") && cleanedBio.length <= 240) {
        res.bio = cleanedBio;
      } else if (cleanedBio) {
        res.bio = cleanedBio.slice(0, 220);
      }
    }
    const imgM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (imgM) res.avatar_url = imgM[1].trim();
    const orgM = html.match(/itemprop="worksFor"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/is);
    if (orgM) res.org = orgM[1].trim();
    const locM = html.match(/itemprop="homeLocation"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/is);
    if (locM) res.location = locM[1].trim();
    const webM = html.match(/itemprop="url"[^>]*>[\s\S]*?href="(https?:\/\/[^"]+)"/i);
    if (webM) res.website = webM[1].trim();
    const folM = html.match(/href="\/[^"]+\?tab=followers"[^>]*>[\s\S]*?<span[^>]*>([0-9.,kKmM]+)<\/span>/i);
    if (folM) res.followers = folM[1].trim();

    const seenSkills = new Set();
    for (const m of html.matchAll(/itemprop="programmingLanguage"[^>]*>([^<]+)</gi)) {
      const lang = m[1].trim();
      if (lang && !seenSkills.has(lang)) {
        seenSkills.add(lang);
        res.skills.push(lang);
      }
    }
    for (const m of html.matchAll(/class="repo"[^>]*>([^<]+)<\/span>/gi)) {
      const rp = m[1].trim();
      if (rp && !res.pinned_repos.includes(rp)) res.pinned_repos.push(rp);
    }

    if (res.website && !res.external_links.includes(res.website)) {
      res.external_links.push(res.website);
    }
    for (const m of html.matchAll(/rel="nofollow me"[^>]+href="(https?:\/\/[^"]+)"/gi)) {
      if (!res.external_links.includes(m[1])) res.external_links.push(m[1]);
    }
    for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"[^>]+rel="nofollow me"/gi)) {
      if (!res.external_links.includes(m[1])) res.external_links.push(m[1]);
    }
  } catch {
    return res;
  }

  // Raw .keys + .gpg + .atom + ?tab=repositories in parallel (ZERO GitHub API!)
  const repoTargets = []; // [{ owner, repo }]
  const addRepoTarget = (owner, repo) => {
    if (!owner || !repo) return;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    if (!repoTargets.some((x) => `${x.owner.toLowerCase()}/${x.repo.toLowerCase()}` === key) && repoTargets.length < 6) {
      repoTargets.push({ owner, repo });
      if (!res.repos.includes(repo)) res.repos.push(repo);
      const u = `https://github.com/${owner}/${repo}`;
      if (!res.repo_urls.includes(u)) res.repo_urls.push(u);
    }
  };
  for (const pr of res.pinned_repos) addRepoTarget(clean, pr);

  await Promise.all([
    (async () => {
      try {
        const kr = await sovereignFetch(`https://github.com/${encodeURIComponent(clean)}.keys`, {}, netCtx, 8000);
        if (kr.ok) {
          const txt = await kr.text();
          for (const line of txt.split(/\r?\n/)) {
            const l = line.trim();
            if (l.startsWith("ssh-") || l.startsWith("ecdsa-") || l.startsWith("sk-")) {
              const parts = l.split(/\s+/);
              const algo = parts[0] || "ssh";
              const keyBlob = parts[1] || l;
              const fp = crypto.createHash("sha256").update(keyBlob).digest("hex").toUpperCase();
              const shortFp = fp.slice(0, 16);
              res.ssh_keys.push({
                algo,
                fingerprint: fp,
                short_fp: shortFp,
                display: `${algo} (${l.slice(0, 44)}...)`,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    })(),
    (async () => {
      try {
        const gr = await sovereignFetch(`https://github.com/${encodeURIComponent(clean)}.gpg`, {}, netCtx, 8000);
        if (gr.ok) {
          const armor = await gr.text();
          if (armor.includes("BEGIN PGP PUBLIC KEY BLOCK")) {
            const { emails, key_id } = extractUidsFromPgpArmor(armor);
            res.gpg_emails = emails;
            res.gpg_key_id = key_id;
          }
        }
      } catch {
        // ignore
      }
    })(),
    (async () => {
      try {
        const rr = await sovereignFetch(
          `https://github.com/${encodeURIComponent(clean)}?tab=repositories&type=source`,
          {},
          netCtx,
          9000
        );
        if (rr.ok) {
          const rhtml = await rr.text();
          const re = new RegExp(`href="/${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9._\\-]+)"[^>]*itemprop="name codeRepository"`, "gi");
          for (const m of rhtml.matchAll(re)) {
            addRepoTarget(clean, m[1]);
          }
          for (const m of rhtml.matchAll(/itemprop="programmingLanguage"[^>]*>([^<]+)</gi)) {
            const lang = m[1].trim();
            if (lang && !res.skills.includes(lang) && res.skills.length < 8) res.skills.push(lang);
          }
        }
      } catch {
        // ignore
      }
    })(),
    (async () => {
      try {
        const ar = await sovereignFetch(`https://github.com/${encodeURIComponent(clean)}.atom`, {}, netCtx, 8000);
        if (ar.ok) {
          const xml = await ar.text();
          // Works even for contributors with 0 own repos!
          for (const m of xml.matchAll(/href="https:\/\/github\.com\/([A-Za-z0-9\-]+)\/([A-Za-z0-9._\-]+)(?:\/commit\/|\/pull\/|")/gi)) {
            const [, owner, repoName] = m;
            if (owner && repoName && !["sponsors", "topics", "orgs"].includes(owner.toLowerCase())) {
              addRepoTarget(owner, repoName);
            }
          }
        }
      } catch {
        // ignore
      }
    })(),
  ]);

  // Deep Commit `.patch` Harvester (up to 8 raw .patch diffs across top 6 repos — ZERO GitHub API!)
  const seenPatchEmails = new Set();
  const seenTzs = new Set();
  const seenHours = new Set();
  let patchesChecked = 0;
  for (const { owner, repo } of repoTargets.slice(0, 6)) {
    if (patchesChecked >= 8) break;
    try {
      const commitsUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?author=${encodeURIComponent(clean)}`;
      const cr = await sovereignFetch(commitsUrl, {}, netCtx, 8500);
      if (!cr.ok) continue;
      const chtml = await cr.text();
      const shaRe = new RegExp(
        `/${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/commit/([0-9a-f]{40})`,
        "gi"
      );
      const shas = [];
      for (const m of chtml.matchAll(shaRe)) {
        if (!shas.includes(m[1])) {
          shas.push(m[1]);
          if (shas.length >= 2) break;
        }
      }

      for (const sha of shas) {
        if (patchesChecked >= 8) break;
        patchesChecked++;
        const patchUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${sha}.patch`;
        const pr = await sovereignFetch(patchUrl, { headers: { Range: "bytes=0-2048" } }, netCtx, 7500);
        if (!pr.ok) continue;
        const patchText = (await pr.text()).slice(0, 2048);
        const fromM = patchText.match(/^From:\s*(.+?)\s*<([^>\s]+@[^>\s]+)>/m);
        const dateM = patchText.match(/^Date:\s*.*?(\d{2}):\d{2}:\d{2}\s+([+-]\d{4})\b/m);
        const hour = dateM ? dateM[1] : null;
        const tz = dateM ? dateM[2] : null;
        const tzRegion = tz ? TIMEZONE_HINTS[tz] || `UTC${tz.slice(0, 3)}:${tz.slice(3)}` : null;
        if (tz && !seenTzs.has(tz)) {
          seenTzs.add(tz);
          res.timezones.push({ offset: tz, region: tzRegion });
        }
        if (hour && !seenHours.has(hour)) {
          seenHours.add(hour);
          res.commit_hours.push(`${hour}:00`);
        }
        if (fromM) {
          const authorName = fromM[1].trim().replace(/^"|"$/g, "");
          const email = fromM[2].trim().toLowerCase();
          if (!isNoiseEmail(email) && !seenPatchEmails.has(email)) {
            seenPatchEmails.add(email);
            res.patch_emails.push({
              email,
              author_name: authorName,
              repo: `${owner}/${repo}`,
              sha: sha.slice(0, 10),
              patch_url: patchUrl,
              tz_offset: tz,
              tz_region: tzRegion,
              commit_hour: hour,
            });
          }
        }
      }
    } catch {
      // ignore repo errors
    }
  }

  return res;
}

/**
 * Deep Personal Website / Portfolio Crawler (over Tor SOCKS5h when active):
 * Crawls /, /about, /resume, /cv, /contact, /links, /pgp.txt, /.well-known/security.txt
 * to extract bio, real emails, PGP keys, and public PDF links.
 */
async function crawlPersonalSite(siteUrl, netCtx) {
  const out = {
    origin: null,
    bio: null,
    emails: [],
    pdf_urls: [],
    pgp_emails: [],
    links: [],
  };
  let origin;
  try {
    origin = new URL(siteUrl).origin;
    out.origin = origin;
  } catch {
    return out;
  }
  const seenEmails = new Set();
  const seenPdfs = new Set();
  const paths = ["", "/about", "/resume", "/cv", "/contact", "/links", "/pgp.txt", "/.well-known/security.txt"];

  await Promise.all(
    paths.map(async (p) => {
      const target = p === "" ? siteUrl : `${origin}${p}`;
      try {
        const r = await sovereignFetch(target, { maxBytes: 180_000, jitter: false }, netCtx, 7500);
        if (!r.ok) return;
        const raw = (await r.text()).slice(0, 180_000);
        if (raw.includes("BEGIN PGP PUBLIC KEY BLOCK")) {
          const { emails } = extractUidsFromPgpArmor(raw);
          for (const em of emails) {
            if (!isNoiseEmail(em) && !seenEmails.has(em)) {
              seenEmails.add(em);
              out.pgp_emails.push(em);
              out.emails.push(em);
            }
          }
        }
        if (p === "" && !out.bio) {
          const dm = raw.match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([^"']{8,240})["']/i);
          if (dm) out.bio = dm[1].trim();
        }
        const cleaned = stripBoilerplateHtml(raw);
        for (const m of cleaned.matchAll(/\b([A-Za-z0-9._%+\-]{2,64}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,12})\b/g)) {
          const em = m[1].toLowerCase();
          if (!isNoiseEmail(em) && !seenEmails.has(em)) {
            seenEmails.add(em);
            out.emails.push(em);
          }
        }
        for (const m of cleaned.matchAll(/(?:href|src)\s*=\s*["']((?:https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\.pdf(?:\?[^\s"'<>]*)?)["']/gi)) {
          const u = m[1].startsWith("http") ? m[1] : `${origin}${m[1]}`;
          if (!seenPdfs.has(u)) {
            seenPdfs.add(u);
            out.pdf_urls.push(u);
          }
        }
      } catch {
        // ignore missing path
      }
    })
  );
  return out;
}

async function probeGitlabRaw(handle, netCtx) {
  const clean = handle.trim().replace(/^@/, "");
  const profile_url = `https://gitlab.com/${encodeURIComponent(clean)}`;
  const res = {
    handle: clean,
    profile_url,
    exists: false,
    display_name: null,
    ssh_keys: [],
    gpg_emails: [],
    gpg_key_id: null,
  };
  try {
    const r = await sovereignFetch(profile_url, {}, netCtx, 9000);
    if (!r.ok) return res;
    const html = await r.text();
    if (html.includes("The page could not be found") || html.includes("Sign in · GitLab")) return res;
    if (!html.toLowerCase().includes(clean.toLowerCase())) return res;
    res.exists = true;
    const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleM) res.display_name = titleM[1].replace(/\s*·\s*GitLab.*$/i, "").trim();
  } catch {
    return res;
  }
  try {
    const kr = await sovereignFetch(`https://gitlab.com/${encodeURIComponent(clean)}.keys`, {}, netCtx, 7000);
    if (kr.ok) {
      const txt = await kr.text();
      for (const l of txt.split(/\r?\n/)) {
        const t = l.trim();
        if (t.startsWith("ssh-") || t.startsWith("ecdsa-") || t.startsWith("sk-")) {
          const parts = t.split(/\s+/);
          const algo = parts[0] || "ssh";
          const keyBlob = parts[1] || t;
          const fp = crypto.createHash("sha256").update(keyBlob).digest("hex").toUpperCase();
          res.ssh_keys.push({
            algo,
            fingerprint: fp,
            short_fp: fp.slice(0, 16),
            display: `${algo} (${t.slice(0, 40)}...)`,
          });
        }
      }
    }
  } catch {
    // ignore
  }
  try {
    const gr = await sovereignFetch(`https://gitlab.com/${encodeURIComponent(clean)}.gpg`, {}, netCtx, 7000);
    if (gr.ok) {
      const armor = await gr.text();
      if (armor.includes("BEGIN PGP PUBLIC KEY BLOCK")) {
        const { emails, key_id } = extractUidsFromPgpArmor(armor);
        res.gpg_emails = emails;
        res.gpg_key_id = key_id;
      }
    }
  } catch {
    // ignore
  }
  return res;
}

// ---------------------------------------------------------------------------
// Engine 5: Direct 80-Platform WhatsMyName Engine + Multi-Signal Verification
// ---------------------------------------------------------------------------

const WMN_SITES = loadJson(WMN_PATH, { sites: [] }).sites || [];

function extractPageSignals(html, pageUrl) {
  const titleM =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const descM =
    html.match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([^"']{4,400})["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']{4,400})["'][^>]+(?:name|property)=["'](?:og:description|description)["']/i);
  const imgM =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https?:\/\/[^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["'](https?:\/\/[^"']+)["'][^>]+property=["']og:image["']/i);

  const title = titleM ? titleM[1].trim() : "";
  const description = descM ? descM[1].trim() : "";
  const avatarUrl = imgM ? imgM[1].trim() : null;

  // Strip boilerplate layout tags BEFORE extracting outbound links or emails
  const cleanedHtml = stripBoilerplateHtml(html);

  const outboundUrls = new Set();
  for (const m of cleanedHtml.matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"'\s<>]+)["']/gi)) {
    const u = m[1];
    try {
      const host = new URL(u).hostname.toLowerCase();
      const selfHost = new URL(pageUrl).hostname.toLowerCase();
      if (host !== selfHost && !PLATFORM_NOISE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
        outboundUrls.add(u);
      }
    } catch {
      // ignore
    }
  }

  return { title, description, avatarUrl, outboundUrls: Array.from(outboundUrls).slice(0, 12) };
}

function stripBoilerplateHtml(html) {
  let s = String(html || "");
  for (const tag of ["footer", "nav", "aside", "style", "noscript"]) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  s = s.replace(/<script(?![^>]+application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, " ");
  return s;
}

function scoreProfileMatch(signals, fullName, knownOrgs, knownDomains, knownEmails, isSeedHandle) {
  const rawTitle = String(signals.title || "");
  const rawDesc = String(signals.description || "");
  const isGistBoilerplate = /(?:['’`]|&#39;|&rsquo;|&apos;)s\s+gists\b/i.test(rawTitle) || /github gist:\s*star and fork/i.test(rawDesc);
  const cleanTitle = isGistBoilerplate ? rawTitle.replace(/^.+?(?:['’`]|&#39;|&rsquo;|&apos;)s\s+gists\b.*$/i, "") : rawTitle;
  const cleanDesc = isGistBoilerplate
    ? rawDesc.replace(/github gist:\s*star and fork[\s\S]*?(?:on\s+github\.?|$)/gi, "")
    : rawDesc;
  const combinedText = `${cleanTitle} ${cleanDesc}`.toLowerCase();
  const fullMatch = hasFullNameMatch(combinedText, fullName);
  const sharedOrg = knownOrgs.some((o) => o.length >= 3 && combinedText.includes(o.toLowerCase()));
  const sharedDom = knownDomains.some(
    (d) =>
      !FREE_MAIL_DOMAINS.has(d) &&
      (combinedText.includes(d.toLowerCase()) ||
        signals.outboundUrls.some((u) => u.toLowerCase().includes(d.toLowerCase())))
  );
  const sharedEmail = knownEmails.some((e) => combinedText.includes(e.toLowerCase()));

  if (sharedEmail) {
    return {
      confidence: 0.88,
      match_tier: "verified",
      match_reason: "Verified email present in profile",
    };
  }
  if (fullMatch && (sharedOrg || sharedDom)) {
    return {
      confidence: 0.84,
      match_tier: "verified",
      match_reason: "Full name + org/domain confirmed",
    };
  }
  if (fullMatch) {
    return {
      confidence: 0.74,
      match_tier: "probable",
      match_reason: "Full name confirmed in bio",
    };
  }
  if (sharedOrg || sharedDom) {
    return {
      confidence: 0.72,
      match_tier: "probable",
      match_reason: "Shared org/website signal",
    };
  }
  if (isSeedHandle) {
    return {
      confidence: 0.66,
      match_tier: "probable",
      match_reason: "Exact provided handle match",
    };
  }
  return {
    confidence: 0.36,
    match_tier: "collision",
    match_reason: "Handle match only — collision risk",
  };
}

function isLikelyDefaultAvatarUrl(url) {
  if (!url) return true;
  const low = url.toLowerCase();
  return (
    low.includes("default") ||
    low.includes("placeholder") ||
    low.includes("logo") ||
    low.includes("og-image") ||
    low.includes("opengraph") ||
    low.includes("default_open_graph") ||
    low.includes("twitter-card") ||
    low.includes("share-image") ||
    low.includes("assets.tumblr.com/images/default") ||
    low.includes("favicon") ||
    low.includes("blank") ||
    low.includes("identicon") ||
    low.endsWith(".svg")
  );
}

async function computeAvatarSha256(avatarUrl, netCtx) {
  if (!avatarUrl || isLikelyDefaultAvatarUrl(avatarUrl)) return null;
  try {
    const resp = await sovereignFetch(avatarUrl, { maxBytes: 262_144 }, netCtx, 7000);
    if (!resp.ok) return null;
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct && !ct.includes("image")) return null;
    const ab = await resp.arrayBuffer();
    const buf = Buffer.isBuffer(ab) ? ab : Buffer.from(ab);
    if (buf.length < 1500 || buf.length > 350_000) return null; // skip tiny 1x1 pixels / huge banners
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

async function runWmnForHandle(
  handle,
  fullName,
  knownOrgs,
  knownDomains,
  knownEmails,
  isSeedHandle,
  netCtx,
  concurrency = 12,
  siteLimit = 999,
  budgetMs = null
) {
  const clean = handle.trim().replace(/^@/, "");
  if (clean.length < 2) return [];
  const encoded = encodeURIComponent(clean);
  const targetSites = WMN_SITES.slice(0, Math.min(WMN_SITES.length, siteLimit));
  const hits = [];
  let cursor = 0;

  const soft404 = [
    "page not found",
    "this account doesn't exist",
    "user does not exist",
    "sorry, this page isn't available",
    "cloudflare ray id",
    "just a moment...",
    "doesn't exist",
    "404 not found",
    "vercel security checkpoint",
    "whoa there, pardner",
    "blocked by network security",
  ];

  // Run up to 18 concurrent streams (even over Tor) with a strict per-handle time budget so the pipeline stays snappy
  const workers = netCtx?.proxyHost ? Math.min(Math.max(concurrency, 18), 20) : concurrency;
  const deadline = Date.now() + (budgetMs || (netCtx?.proxyHost ? 18_000 : 14_000));

  const wmnNonce = Math.floor(Date.now() / 1000).toString(36);
  let wmnRetrySeq = 0;

  async function worker() {
    while (cursor < targetSites.length && Date.now() < deadline) {
      const site = targetSites[cursor++];
      const checkUrl = site.uri_check.replace("{account}", encoded);
      const prettyUrl = site.uri_pretty.replace("{account}", encoded);
      let resp = null;
      try {
        resp = await sovereignFetch(checkUrl, { maxBytes: 140_000, jitter: false }, netCtx, 6000);
      } catch (err) {
        if (String(err?.message || "").includes("STRICT_ANONYMITY_BLOCKED")) break;
        // 1 fast retry on transient Tor timeout/network error using a fresh circuit within budget
        if (netCtx?.proxyHost && Date.now() + 2500 < deadline) {
          try {
            resp = await sovereignFetch(
              checkUrl,
              { maxBytes: 140_000, jitter: false, socksUser: `wmn-${wmnNonce}-${++wmnRetrySeq}` },
              netCtx,
              5500
            );
          } catch {
            continue;
          }
        } else {
          continue;
        }
      }
      if (!resp) continue;
      try {
        if (resp.status === site.m_code && site.m_code !== site.e_code) continue;
        if (resp.status !== site.e_code) continue;
        const rawHtml = (await resp.text()).slice(0, 140_000);
        const body = rawHtml.toLowerCase();
        if (site.m_string && body.includes(site.m_string.toLowerCase())) continue;
        if (site.e_string && !body.includes(site.e_string.toLowerCase())) continue;
        if (soft404.some((m) => body.includes(m))) continue;

        const signals = extractPageSignals(rawHtml, prettyUrl);
        const scored = scoreProfileMatch(
          signals,
          fullName,
          knownOrgs,
          knownDomains,
          knownEmails,
          isSeedHandle
        );

        hits.push({
          site_name: site.name,
          category: site.category,
          handle: clean,
          url: prettyUrl,
          confidence: scored.confidence,
          match_tier: scored.match_tier,
          match_reason: scored.match_reason,
          title: signals.title,
          description: signals.description,
          avatar_url: signals.avatarUrl,
          outbound_urls: signals.outboundUrls,
        });
      } catch {
        // parse / read error
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return hits;
}

// ---------------------------------------------------------------------------
// Engine 6: Direct HTML / JSON-LD / rel=me Extractor (Noise-Stripped Depth 2)
// ---------------------------------------------------------------------------

const RESERVED_PATHS = new Set([
  "home", "login", "signup", "join", "about", "features", "pricing",
  "enterprise", "explore", "topics", "settings", "security", "privacy",
  "terms", "share", "intent", "search", "i", "s", "org", "orgs", "users",
  "apps", "marketplace", "sponsors", "solutions", "company", "contact",
  "help", "docs", "status", "blog", "wp-content", "wp-includes",
]);

async function extractProfileHtml(url, netCtx) {
  try {
    const resp = await sovereignFetch(url, { maxBytes: 240_000 }, netCtx, 10000);
    if (!resp.ok) return null;
    const rawHtml = (await resp.text()).slice(0, 220_000);
    const emails = new Set();
    const same_as_urls = new Set();
    const orgs = new Set();
    const pdf_urls = new Set();
    const cross_handles = [];
    const seenCross = new Set();

    // 1. Parse JSON-LD structured data FIRST (before stripping scripts)
    for (const m of rawHtml.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const walk = (v) => {
          if (!v || typeof v !== "object") return;
          if (Array.isArray(v)) return v.forEach(walk);
          if (v.sameAs) {
            const arr = Array.isArray(v.sameAs) ? v.sameAs : [v.sameAs];
            for (const s of arr) if (typeof s === "string" && s.startsWith("http")) same_as_urls.add(s);
          }
          if (v.worksFor) {
            const name = typeof v.worksFor === "string" ? v.worksFor : v.worksFor.name;
            if (typeof name === "string" && name.trim()) orgs.add(name.trim());
          }
          if (typeof v.email === "string") {
            const em = v.email.replace(/^mailto:/i, "").trim().toLowerCase();
            if (em.includes("@") && !isNoiseEmail(em)) emails.add(em);
          }
          Object.values(v).forEach(walk);
        };
        walk(JSON.parse(m[1].trim()));
      } catch {
        // ignore invalid JSON-LD
      }
    }

    // 2. Strip <footer>, <nav>, <aside>, non-JSON-LD <script>, <style> BEFORE scanning!
    const html = stripBoilerplateHtml(rawHtml);

    // 3. rel="me"
    for (const m of html.matchAll(/<a[^>]+rel=["'][^"']*\bme\b[^"']*["'][^>]+href=["'](https?:\/\/[^"']+)["']/gi)) {
      same_as_urls.add(m[1]);
    }
    for (const m of html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]+rel=["'][^"']*\bme\b[^"']*["']/gi)) {
      same_as_urls.add(m[1]);
    }

    // 4. Direct .pdf links (resumes, CVs, papers, decks)
    const origin = new URL(url).origin;
    for (const m of html.matchAll(/(?:href|src)\s*=\s*["']((?:https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\.pdf(?:\?[^\s"'<>]*)?)["']/gi)) {
      const raw = m[1];
      pdf_urls.add(raw.startsWith("http") ? raw : `${origin}${raw}`);
    }

    // 5. Embedded personal/work emails (strictly filtered against platform boilerplate!)
    for (const m of html.matchAll(/\b([A-Za-z0-9._%+\-]{2,64}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,12})\b/g)) {
      const em = m[1].toLowerCase();
      if (!isNoiseEmail(em)) {
        emails.add(em);
        if (emails.size >= 8) break;
      }
    }

    // 6. Cross-platform social links
    const patterns = [
      ["Instagram", /https?:\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})(?:[/?#"'\s<]|$)/gi],
      ["LinkedIn", /https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]{3,80})(?:[/?#"'\s<]|$)/gi],
      ["X/Twitter", /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,20})(?:[/?#"'\s<]|$)/gi],
      ["YouTube", /https?:\/\/(?:www\.)?youtube\.com\/(@[A-Za-z0-9_.\-]{2,40})(?:[/?#"'\s<]|$)/gi],
      ["TikTok", /https?:\/\/(?:www\.)?tiktok\.com\/(@[A-Za-z0-9_.]{2,30})(?:[/?#"'\s<]|$)/gi],
      ["Threads", /https?:\/\/(?:www\.)?threads\.net\/(@[A-Za-z0-9_.]{2,30})(?:[/?#"'\s<]|$)/gi],
      ["Facebook", /https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9.]{4,40})(?:[/?#"'\s<]|$)/gi],
      ["GitHub", /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9\-]{1,38})(?:[/?#"'\s<]|$)/gi],
      ["GitLab", /https?:\/\/(?:www\.)?gitlab\.com\/([A-Za-z0-9_.\-]{2,40})(?:[/?#"'\s<]|$)/gi],
      ["Keybase", /https?:\/\/(?:www\.)?keybase\.io\/([A-Za-z0-9_]{2,24})(?:[/?#"'\s<]|$)/gi],
      ["Telegram", /https?:\/\/t\.me\/([A-Za-z0-9_]{4,32})(?:[/?#"'\s<]|$)/gi],
    ];
    for (const [platform, re] of patterns) {
      for (const m of html.matchAll(re)) {
        const h = m[1].replace(/^@/, "").toLowerCase();
        if (/\.(atom|rss|xml|json|keys|gpg|asc|png|jpg|jpeg|svg|css|js|ico|txt|pdf)$/i.test(h)) continue;
        const key = `${platform}:${h}`;
        if (!RESERVED_PATHS.has(h) && !["p", "reel", "reels", "explore", "watch", "channel", "sharer", "share.php"].includes(h) && !seenCross.has(key)) {
          seenCross.add(key);
          cross_handles.push([platform, h]);
        }
      }
    }

    const phones = extractPublicPhones(html);

    return {
      emails: Array.from(emails),
      phones,
      same_as_urls: Array.from(same_as_urls),
      orgs: Array.from(orgs),
      pdf_urls: Array.from(pdf_urls),
      cross_handles: cross_handles.slice(0, 14),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine 7: Pure-JS Public PDF Metadata Extractor (Domains + Personal Sites + Repos)
// ---------------------------------------------------------------------------

function decodePdfBytes(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < buf.length; i += 2) {
      out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    }
    return out;
  }
  return buf.toString("utf8");
}

function extractPdfKey(buf, key) {
  const needle = Buffer.from(key, "ascii");
  let pos = 0;
  while (pos < buf.length) {
    const idx = buf.indexOf(needle, pos);
    if (idx === -1) return null;
    let i = idx + needle.length;
    if (i < buf.length && /[A-Za-z0-9_]/.test(String.fromCharCode(buf[i]))) {
      pos = i;
      continue;
    }
    while (i < buf.length && (buf[i] === 32 || buf[i] === 9 || buf[i] === 10 || buf[i] === 13)) i++;
    if (buf[i] === 0x28) {
      const out = [];
      let depth = 1;
      i++;
      for (; i < buf.length && out.length < 512; i++) {
        if (buf[i] === 0x5c && i + 1 < buf.length) {
          i++;
          out.push(buf[i]);
          continue;
        }
        if (buf[i] === 0x28) depth++;
        else if (buf[i] === 0x29) {
          depth--;
          if (depth === 0) break;
        }
        out.push(buf[i]);
      }
      const val = decodePdfBytes(Buffer.from(out)).replace(/\0/g, "").replace(/\s+/g, " ").trim();
      if (val) return val;
    } else if (buf[i] === 0x3c && buf[i + 1] !== 0x3c) {
      const end = buf.indexOf(0x3e, i + 1);
      if (end !== -1 && end - i < 1024) {
        const hexStr = buf.subarray(i + 1, end).toString("ascii").replace(/\s+/g, "");
        if (/^[0-9a-fA-F]+$/.test(hexStr)) {
          const padded = hexStr.length % 2 ? `${hexStr}0` : hexStr;
          const val = decodePdfBytes(Buffer.from(padded, "hex"))
            .replace(/\0/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (val) return val;
        }
      }
    }
    pos = i + 1;
  }
  return null;
}

async function discoverDomainPdfs(domain, netCtx) {
  const base = `https://${domain}`;
  const paths = ["", "/about", "/press", "/investors", "/leadership", "/cv", "/resume", "/sitemap.xml"];
  const found = new Set();
  await Promise.all(
    paths.map(async (p) => {
      try {
        const r = await sovereignFetch(`${base}${p}`, { maxBytes: 200_000 }, netCtx, 8000);
        if (!r.ok) return;
        const text = (await r.text()).slice(0, 200_000);
        for (const m of text.matchAll(/(?:href|src|loc)\s*[=>]\s*["']?((?:https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\.pdf(?:\?[^\s"'<>]*)?)["'<]?/gi)) {
          const raw = m[1];
          const url = raw.startsWith("http") ? raw : `${base}${raw}`;
          found.add(url);
        }
      } catch {
        // ignore
      }
    })
  );
  return Array.from(found).slice(0, 5);
}

async function discoverPagePdfs(pageUrls, netCtx) {
  const found = []; // [{ url, sourcePage }]
  const seen = new Set();
  for (const pageUrl of pageUrls.slice(0, 6)) {
    try {
      if (pageUrl.toLowerCase().includes(".pdf")) {
        if (!seen.has(pageUrl)) {
          seen.add(pageUrl);
          found.push({ url: pageUrl, sourcePage: pageUrl });
        }
        continue;
      }
      const r = await sovereignFetch(pageUrl, { maxBytes: 180_000 }, netCtx, 8000);
      if (!r.ok) continue;
      const text = (await r.text()).slice(0, 180_000);
      const origin = new URL(pageUrl).origin;
      for (const m of text.matchAll(/(?:href|src)\s*=\s*["']((?:https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\.pdf(?:\?[^\s"'<>]*)?)["']/gi)) {
        const raw = m[1];
        let resolved = raw.startsWith("http") ? raw : `${origin}${raw}`;
        // Convert GitHub blob PDF links to raw PDF download links
        if (resolved.includes("github.com/") && resolved.includes("/blob/")) {
          resolved = resolved.replace("/blob/", "/raw/");
        }
        if (!seen.has(resolved)) {
          seen.add(resolved);
          found.push({ url: resolved, sourcePage: pageUrl });
        }
      }
    } catch {
      // ignore
    }
  }
  return found.slice(0, 5);
}

async function fetchAndParsePdf(url, netCtx) {
  try {
    const r = await sovereignFetch(
      url,
      { headers: { Range: "bytes=0-2097151" }, maxBytes: 2_097_152 },
      netCtx,
      11000
    );
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    const buf = (Buffer.isBuffer(ab) ? ab : Buffer.from(ab)).subarray(0, 2_097_152);
    if (!buf.subarray(0, 1024).includes(Buffer.from("%PDF"))) return null;

    const lossy = buf.toString("latin1");
    let author = extractPdfKey(buf, "/Author");
    let creator = extractPdfKey(buf, "/Creator");
    let producer = extractPdfKey(buf, "/Producer");
    if (!author) {
      const m = lossy.match(/<dc:creator[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]{1,200})<\/rdf:li>/i);
      if (m) author = m[1].trim();
    }
    if (!creator) {
      const m = lossy.match(/<xmp:CreatorTool[^>]*>([^<]{1,200})<\/xmp:CreatorTool>/i);
      if (m) creator = m[1].trim();
    }
    if (!producer) {
      const m = lossy.match(/<pdf:Producer[^>]*>([^<]{1,200})<\/pdf:Producer>/i);
      if (m) producer = m[1].trim();
    }

    const title = extractPdfKey(buf, "/Title");
    const xmpIdx = lossy.indexOf("<x:xmpmeta");
    const xmpChunk = xmpIdx !== -1 ? lossy.slice(xmpIdx, xmpIdx + 24_000) : "";
    const combined = [author, creator, producer, title, xmpChunk].filter(Boolean).join("\n");

    const internal_usernames = [];
    const seenU = new Set();
    for (const m of combined.matchAll(/(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)([A-Za-z0-9._\-]{2,40})(?:[\\/]|$)/gi)) {
      const u = m[1];
      const low = u.toLowerCase();
      if (!["public", "default", "administrator", "admin", "root", "runner", "shared"].includes(low) && !seenU.has(low)) {
        seenU.add(low);
        internal_usernames.push(u);
      }
    }

    const emails = [];
    const seenE = new Set();
    const readableText = lossy.replace(/[^\x20-\x7E\r\n]/g, " ").slice(0, 120_000);
    const fullScan = `${combined}\n${readableText}`;
    for (const m of fullScan.matchAll(/\b([A-Za-z0-9._%+\-]{2,64}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,12})\b/g)) {
      const em = m[1].toLowerCase();
      if (!isNoiseEmail(em) && !seenE.has(em)) {
        seenE.add(em);
        emails.push(em);
        if (emails.length >= 6) break;
      }
    }
    const phones = extractPublicPhones(fullScan);

    const file_name = url.split("?")[0].split("/").pop() || "document.pdf";
    return { url, file_name, author, creator, producer, internal_usernames, emails, phones };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine 9: Local Offline Corpus Scanner (Automatic Credential Redaction)
// ---------------------------------------------------------------------------

function redactCorpusLine(line, matchedTerm) {
  const hasCred = /[:;|,\t]\s*[^\s]{4,}/.test(line) && line.includes("@");
  if (hasCred) {
    return {
      redacted: `${matchedTerm} : [REDACTED_CREDENTIAL_FIELD]`,
      hasCred: true,
    };
  }
  const safe = line.trim().slice(0, 120);
  return { redacted: safe, hasCred: false };
}

function scanLocalCorpus(dirPath, terms) {
  if (!fs.existsSync(dirPath)) return { filesScanned: 0, hits: [] };
  const cleanTerms = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
  if (!cleanTerms.length) return { filesScanned: 0, hits: [] };
  const hits = [];
  let filesScanned = 0;
  const exts = new Set([".txt", ".csv", ".json", ".jsonl", ".log", ".tsv"]);
  const walk = (dir, depth = 0) => {
    if (depth > 3 || hits.length >= 25) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
        if (entry.name.toLowerCase() === "readme.txt") continue;
        filesScanned++;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 50 * 1024 * 1024) continue;
          const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 25; i++) {
            const low = lines[i].toLowerCase();
            const match = cleanTerms.find((t) => low.includes(t));
            if (match) {
              const { redacted, hasCred } = redactCorpusLine(lines[i], match);
              hits.push({
                file_name: entry.name,
                file_path: full,
                line_number: i + 1,
                matched_term: match,
                redacted_preview: redacted,
                has_credential_shape: hasCred,
              });
            }
          }
        } catch {
          // skip unreadable file
        }
      }
    }
  };
  walk(dirPath);
  return { filesScanned, hits };
}

// ---------------------------------------------------------------------------
// Engine 10: Local Python Sidecar Bridge (auto-prefers sidecar/.venv)
// ---------------------------------------------------------------------------

function detectPythonPath() {
  const venvWin = path.join(SIDECAR_VENV_SCRIPTS, "python.exe");
  const venvBin3 = path.join(SIDECAR_VENV_BIN, "python3");
  const venvBin = path.join(SIDECAR_VENV_BIN, "python");
  const candidates = [
    fs.existsSync(venvWin) ? venvWin : null,
    fs.existsSync(venvBin3) ? venvBin3 : null,
    fs.existsSync(venvBin) ? venvBin : null,
    fs.existsSync(SIDECAR_VENV_PYTHON) ? SIDECAR_VENV_PYTHON : null,
    process.env.TAUF_PYTHON?.trim() || null,
    process.env.PYTHON_EXE?.trim() || null,
    "python3",
    "python",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      if (r.status === 0) return c;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function buildSidecarEnv() {
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  const binDirs = [SIDECAR_VENV_SCRIPTS, SIDECAR_VENV_BIN].filter((d) => fs.existsSync(d));
  if (binDirs.length > 0) {
    env.PATH = `${binDirs.join(path.delimiter)}${path.delimiter}${env.PATH || ""}`;
  }
  return env;
}

function probeSidecarTools() {
  const py = detectPythonPath();
  if (!py || !fs.existsSync(SIDECAR_BRIDGE)) {
    return { python_path: py, sidecar_tools: [] };
  }
  const r = spawnSync(py, [SIDECAR_BRIDGE, "--probe"], {
    encoding: "utf8",
    timeout: 9000,
    env: buildSidecarEnv(),
    windowsHide: true,
  });
  if (r.status === 0 && r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout.trim());
      const list = Array.isArray(parsed) ? parsed : parsed.tools || [];
      return { python_path: py, sidecar_tools: list };
    } catch {
      // ignore
    }
  }
  return { python_path: py, sidecar_tools: [] };
}

function runSidecarBridge(input, auth, handles, emails, phones, profileUrls, netCtx, depthLevel, onEvent) {
  return new Promise((resolve) => {
    const py = detectPythonPath();
    if (!py || !fs.existsSync(SIDECAR_BRIDGE)) return resolve();
    const payload = JSON.stringify({
      full_name: input.full_name,
      org: input.org,
      email: input.email,
      handle: input.handle,
      phone: phones[0] || input.phone,
      phones,
      domain: input.domain,
      passive_only: input.passive_only,
      enable_tor: input.enable_tor,
      strict_anonymity: Boolean(netCtx?.strictAnonymity),
      depth_level: depthLevel,
      handles,
      emails,
      profile_urls: profileUrls,
      tor_socks_url: netCtx?.torEndpoint || null,
      proxy_url: auth.proxy_url || null,
      local_corpus_dir: auth.local_corpus_dir || DEFAULT_CORPUS_DIR,
    });
    const sidecarTimeout = { 1: 15_000, 2: 75_000, 3: 115_000, 4: 150_000 }[depthLevel] || 75_000;
    const child = spawn(py, [SIDECAR_BRIDGE, "--run", "--payload", payload], {
      stdio: ["ignore", "pipe", "ignore"],
      env: buildSidecarEnv(),
      windowsHide: true,
    });
    let buf = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve();
    }, sidecarTimeout);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          // ignore
        }
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// V4 General-Purpose Name-Root Discovery Engines (Zero External APIs)
// ---------------------------------------------------------------------------

/**
 * Strictly extract publicly listed international phone numbers (E.164 / tel:)
 * while rejecting dates, timestamps, CSS values, hex IDs, and random numeric runs.
 */
function extractPublicPhones(text) {
  const found = new Set();
  const str = String(text || "");
  // 1. Explicit tel: links
  for (const m of str.matchAll(/href=["']tel:(\+?[0-9][0-9\s\-().]{8,18})["']/gi)) {
    const clean = m[1].replace(/[^\d+]/g, "");
    const digits = clean.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      found.add(clean.startsWith("+") ? clean : `+${clean}`);
    }
  }
  // 2. Explicit international +CC formatted numbers in visible text
  const plain = str.replace(/<[^>]+>/g, " ");
  for (const m of plain.matchAll(/(?:^|[\s:(])(\+(?:1|44|91|49|33|61|65|81|86|31|46|41|358|971)[\s\-().]?\d{2,4}[\s\-().]?\d{3,4}[\s\-().]?\d{3,5})(?=$|[\s),.;])/g)) {
    const raw = m[1].trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15 && !/^(\d)\1{6,}$/.test(digits)) {
      found.add(raw.replace(/\s+/g, " "));
      if (found.size >= 4) break;
    }
  }
  return Array.from(found);
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlockedSpaUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return Array.from(BLOCKED_SPA_HOSTS).some((b) => host === b || host.endsWith(`.${b}`));
  } catch {
    return false;
  }
}

function detectSearchChallenge(resp, html) {
  if (!resp) return "network failure";
  if (resp.status === 202) return "HTTP 202 bot challenge";
  if (resp.status === 403) return "HTTP 403 forbidden";
  if (resp.status === 429) return "HTTP 429 rate-limited";
  if (!resp.ok) return `HTTP ${resp.status}`;
  const titleM = html.match(/<title[^>]*>([\s\S]{1,160}?)<\/title>/i);
  const titleTxt = titleM ? decodeHtmlEntities(titleM[1]) : "";
  if (/^\s*(?:attention required|just a moment|captcha|blocked|forbidden|access denied|robot check)/i.test(titleTxt)) {
    return `bot challenge (${titleTxt.slice(0, 40)})`;
  }
  if (
    /id=["']challenge-form["']|action=["'][^"']*anomaly\.js|class=["'][^"']*(?:g-recaptcha|h-captcha|cf-turnstile)|cf-challenge|verify you are human|unusual traffic from|automated queries|bot protection/i.test(
      html
    )
  ) {
    return "CAPTCHA / bot challenge";
  }
  return null;
}

function decodeSearchRedirectUrl(href) {
  let clean = String(href || "").replace(/&amp;/g, "&").trim();
  const uddg = clean.match(/[?&]uddg=([^&]+)/i);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return clean;
    }
  }
  if (/bing\.com\/ck\/a/i.test(clean)) {
    const uM = clean.match(/[?&]u=([^&]+)/i);
    if (uM && uM[1].startsWith("a1")) {
      try {
        const b64 = uM[1].slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        if (decoded.startsWith("http")) return decoded;
      } catch {
        // fallback below
      }
    }
  }
  return clean;
}

function extractAttr(attrs, name) {
  const m = String(attrs || "").match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
  return m ? m[1] : "";
}

function parseSearchResults(engineId, html) {
  const results = [];
  if (engineId === "startpage") {
    const blocks = html.split(/class=["'][^"']*(?:result\s+css-|w-gl__result)[^"']*["']/i).slice(1);
    for (const rawBlk of blocks.slice(0, 12)) {
      const blk = rawBlk
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/\.css-[\w-]+\s*\{[^}]*\}/g, " ");
      let matchedA = null;
      const priorityLink =
        blk.match(/<a\b([^>]*data-testid=["']gl-title-link["'][^>]*)>([\s\S]*?)<\/a>/i) ||
        blk.match(/<a\b([^>]*class=["'][^"']*\bresult-title\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/i);
      if (priorityLink) {
        const u = decodeSearchRedirectUrl(extractAttr(priorityLink[1], "href"));
        if (u.startsWith("http") && !/(?:^|\.)(?:startpage|ixquick)\.com(?:\/|$)/i.test(u)) {
          matchedA = { href: u, inner: priorityLink[2] };
        }
      }
      if (!matchedA) {
        for (const m of blk.matchAll(/<a\b([^>]*href=["'](https?:\/\/[^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
          const u = decodeSearchRedirectUrl(m[2]);
          if (u.startsWith("http") && !/(?:^|\.)(?:startpage|ixquick)\.com(?:\/|$)/i.test(u)) {
            matchedA = { href: u, inner: m[3] };
            break;
          }
        }
      }
      if (!matchedA) continue;
      const titleM =
        blk.match(/<h2\b[^>]*class=["'][^"']*\bwgl-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i) ||
        blk.match(/<a\b[^>]*data-testid=["']gl-title-link["'][^>]*>([\s\S]*?)<\/a>/i) ||
        blk.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
      const title = decodeHtmlEntities(
        (titleM ? titleM[1] : matchedA.inner)
          .replace(/<[^>]+>/g, " ")
          .replace(/\.css-[\w-]+\s*\{[^}]*\}/g, " ")
      );
      const snM =
        blk.match(/<p\b[^>]*class=["'][^"']*\bdescription\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) ||
        blk.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = snM
        ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, " ").replace(/\.css-[\w-]+\s*\{[^}]*\}/g, " "))
        : "";
      results.push({ url: matchedA.href, title, snippet });
    }
    return results;
  }

  if (engineId === "ddg-lite") {
    const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    const matches = Array.from(html.matchAll(linkRe));
    for (let i = 0; i < matches.length && results.length < 12; i++) {
      const attrs = matches[i][1];
      if (!/\bresult-link\b/i.test(attrs)) continue;
      let href = decodeSearchRedirectUrl(extractAttr(attrs, "href"));
      if (href.startsWith("//")) href = `https:${href}`;
      if (!href.startsWith("http") || /duckduckgo\.com\/y\.js/i.test(href)) continue;
      const title = decodeHtmlEntities(matches[i][2].replace(/<[^>]+>/g, " "));
      const afterIdx = (matches[i].index || 0) + matches[i][0].length;
      const tail = html.slice(afterIdx, afterIdx + 1200);
      const snM = tail.match(/<td\b[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
      const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, " ")) : "";
      results.push({ url: href, title, snippet });
    }
    return results;
  }

  if (engineId === "ddg-html") {
    const blocks = html.split(/class=["'][^"']*result\s+results_links/i).slice(1);
    for (const blk of blocks.slice(0, 12)) {
      const aM = blk.match(/<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/i) ||
        blk.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
      if (!aM) continue;
      let href = decodeSearchRedirectUrl(extractAttr(aM[1], "href"));
      if (href.startsWith("//")) href = `https:${href}`;
      if (!href.startsWith("http") || /duckduckgo\.com\/y\.js/i.test(href)) continue;
      const title = decodeHtmlEntities(aM[2].replace(/<[^>]+>/g, " "));
      const snM =
        blk.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) ||
        blk.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, " ")) : "";
      results.push({ url: href, title, snippet });
    }
    return results;
  }

  if (engineId === "brave") {
    const rawBlocks = html.split(/data-type=["']web["']/i).slice(1);
    const blocks = rawBlocks.length ? rawBlocks : html.split(/class=["'][^"']*snippet\s/i).slice(1);
    for (const blk of blocks.slice(0, 12)) {
      const aM = blk.match(/<a\b([^>]*href=["'](https?:\/\/(?!(?:search\.)?brave\.com)[^"']+)["'][^>]*)>([\s\S]*?)<\/a>/i);
      if (!aM) continue;
      const href = decodeSearchRedirectUrl(aM[2]);
      if (!href.startsWith("http")) continue;
      const titleM = blk.match(/class=["'][^"']*(?:title|snippet-title)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const title = decodeHtmlEntities((titleM ? titleM[1] : aM[3]).replace(/<[^>]+>/g, " "));
      const snM = blk.match(/class=["'][^"']*(?:snippet-description|description|content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, " ")) : "";
      results.push({ url: href, title, snippet });
    }
    return results;
  }

  if (engineId === "mojeek") {
    const blocks = html.split(/<li\b[^>]*class=["'][^"']*results-standard[^"']*["']/i).slice(1);
    for (const blk of blocks.slice(0, 12)) {
      const aM = blk.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
      if (!aM) continue;
      const href = decodeSearchRedirectUrl(extractAttr(aM[1], "href"));
      if (!href.startsWith("http") || /mojeek\.com/i.test(href)) continue;
      const title = decodeHtmlEntities(aM[2].replace(/<[^>]+>/g, " "));
      const snM = blk.match(/<p\b[^>]*class=["'][^"']*\bs\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
      const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, " ")) : "";
      results.push({ url: href, title, snippet });
    }
    return results;
  }

  return results;
}

const SEARCH_ENGINES = [
  { id: "startpage", timeoutMs: 15000, buildUrl: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}` },
  { id: "ddg-lite", buildUrl: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}` },
  { id: "ddg-html", buildUrl: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  { id: "brave", buildUrl: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
  { id: "mojeek", timeoutMs: 5000, buildUrl: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}` },
];

/**
 * Resilient Startpage-over-Tor helper with up to 3 total attempts (initial + 2 retries)
 * across 3 distinct RFC 1929 IsolateSOCKSAuth circuits on BOTH challenge and timeout/network error.
 */
async function queryStartpageWithRetry(query, netCtx, nextSocksUser, timeoutMs = 15000) {
  const spUrl = `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`;
  const maxAttempts = netCtx?.proxyHost ? 3 : 1;
  let lastReason = "timeout";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const r = await sovereignFetch(
        spUrl,
        { maxBytes: 450_000, jitter: false, socksUser: nextSocksUser() },
        netCtx,
        timeoutMs
      );
      const html = r.ok ? await r.text() : "";
      const challenge = detectSearchChallenge(r, html);
      if (!challenge && r.ok) {
        return { ok: true, items: parseSearchResults("startpage", html), reason: null };
      }
      lastReason = challenge || `HTTP ${r.status}`;
    } catch (err) {
      if (String(err?.message || "").includes("STRICT_ANONYMITY_BLOCKED")) {
        return { ok: false, items: [], reason: "STRICT_ANONYMITY_BLOCKED", strictBlocked: true };
      }
      lastReason = "timeout";
    }
  }
  return { ok: false, items: [], reason: lastReason };
}

const AGGREGATOR_OR_DIRECTORY_HOSTS = [
  "youtube.com", "wikipedia.org", "indiankanoon.org", "courtlistener.com", "arxiv.org",
  "zaubacorp.com", "falconebiz.com", "tofler.in", "opencorporates.com", "thecompanycheck.com",
  "companieshouse.gov.uk", "scribd.com", "researchgate.net", "realtor.ca", "theprint.in",
  "linkedin.com", "instagram.com", "facebook.com", "x.com", "twitter.com", "threads.net",
  "reddit.com", "medium.com", "github.com", "gitlab.com", "dev.to", "kaggle.com",
  "behance.net", "dribbble.com", "pinterest.com", "tiktok.com", "tumblr.com", "soundcloud.com",
  "google.com", "bing.com", "duckduckgo.com", "startpage.com", "yahoo.com",
];

function isPersonalOrCompanyWebsiteCandidate(url, title, snippet, fullName) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return false;
  }
  if (!host || !host.includes(".")) return false;
  if (PLATFORM_NOISE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  if (AGGREGATOR_OR_DIRECTORY_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  if (/\.(gov|edu|ac|nic)\.[a-z]{2}$|\.(gov|edu)$/i.test(host)) return false;
  if (sharesNameToken(host, fullName)) return true;
  const ctx = `${title || ""} ${snippet || ""}`;
  return (
    hasFullNameMatch(ctx, fullName) &&
    /\b(resume|cv|portfolio|about|founder|co-founder|director|managing director|md|partner|ceo|cto|company|private limited|pvt\.?\s*ltd|llp|studio|agency|ventures|consulting)\b/i.test(
      ctx
    )
  );
}

function inferRecordType(url, title, snippet, fallback = "Public Web Record") {
  const combined = `${url || ""} ${title || ""} ${snippet || ""}`.toLowerCase();
  if (/courtlistener\.com|indiankanoon\.org|\b(court|judgment|judgement|docket|tribunal|petition|bail|bench|vs\.|v\.)\b/i.test(combined)) {
    return "Legal / Court Record";
  }
  if (/zaubacorp|falconebiz|tofler\.in|opencorporates|thecompanycheck|companieshouse|\b(form mgt-7|mgt-7|annual return|\bcin\b|\bdin\b|llp|directorship|managing director|board of directors|incorporation)\b/i.test(combined)) {
    return "Corporate Filing";
  }
  if (/arxiv\.org|researchgate\.net|scholar\.google|\b(patent|publication|thesis|journal|proceedings|doi:|preprint)\b/i.test(combined)) {
    return "Academic Publication";
  }
  if (/youtube\.com\/watch|vimeo\.com|\b(keynote|interview|podcast|talk|panel)\b/i.test(combined)) {
    return "Media / Talk";
  }
  return fallback;
}

function extractSocialAccountFromUrl(rawHref, title, fullName) {
  let cleanUrl = rawHref;
  try {
    const u = new URL(rawHref);
    u.hash = "";
    cleanUrl = u.toString();
    if (/\.(atom|rss|xml|json|keys|gpg|asc|png|jpg|jpeg|svg|css|js|ico|txt|pdf)$/i.test(u.pathname)) {
      return null;
    }
  } catch {
    return null;
  }

  const igReserved = new Set([
    ...RESERVED_PATHS,
    "_u", "p", "reel", "reels", "stories", "explore", "tv", "accounts", "directory", "popular", "tags", "locations", "legal", "oauth",
  ]);
  const fbReserved = new Set([
    ...RESERVED_PATHS,
    "public", "people", "pages", "groups", "events", "watch", "marketplace", "gaming", "photo", "video", "sharer.php", "profile.php", "policies",
  ]);
  const kagReserved = new Set([...RESERVED_PATHS, "datasets", "competitions", "code", "learn", "discussions", "models", "organizations"]);
  const behReserved = new Set([...RESERVED_PATHS, "gallery", "joblist", "hire", "for_you", "assets"]);
  const drbReserved = new Set([...RESERVED_PATHS, "shots", "designers", "hiring", "jobs", "tags", "following"]);
  const assetExtRe = /\.(atom|rss|xml|json|keys|gpg|asc|png|jpg|jpeg|svg|css|js|ico|txt|pdf)$/i;

  let m;
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})(?:[/?#]|$)/i))) {
    const h = m[1].toLowerCase();
    if (!igReserved.has(h) && !assetExtRe.test(h)) return { platform: "Instagram", handle: h, url: `https://www.instagram.com/${m[1]}/` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]{3,80})(?:[/?#]|$)/i))) {
    const h = decodeURIComponent(m[1]).replace(/\/+$/, "").toLowerCase();
    if (!RESERVED_PATHS.has(h) && !assetExtRe.test(h) && !["dir", "pub", "company", "jobs"].includes(h)) {
      return { platform: "LinkedIn", handle: h, url: `https://www.linkedin.com/in/${h}` };
    }
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,20})(?:\/?(?:\?.*)?)?$/i))) {
    const h = m[1].toLowerCase();
    if (!RESERVED_PATHS.has(h) && !["hashtag", "home", "notifications", "messages", "tos"].includes(h)) {
      return { platform: "X/Twitter", handle: h, url: `https://x.com/${m[1]}` };
    }
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,20})\/status\//i))) {
    const h = m[1].toLowerCase();
    if (!RESERVED_PATHS.has(h) && hasFullNameMatch(title, fullName)) {
      return { platform: "X/Twitter", handle: h, url: `https://x.com/${m[1]}` };
    }
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.)?threads\.(?:net|com)\/@?([A-Za-z0-9_.]{2,30})(?:[/?#]|$)/i))) {
    const h = m[1].toLowerCase();
    if (!RESERVED_PATHS.has(h) && !assetExtRe.test(h) && !["post", "t", "login", "search", "explore"].includes(h)) {
      return { platform: "Threads", handle: h, url: `https://www.threads.net/@${m[1]}` };
    }
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.|m\.)?facebook\.com\/([A-Za-z0-9.]{4,50})(?:\/?(?:\?.*)?)?$/i))) {
    const h = m[1].toLowerCase();
    if (!fbReserved.has(h) && !assetExtRe.test(h)) return { platform: "Facebook", handle: h, url: `https://www.facebook.com/${m[1]}` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.)?youtube\.com\/@([A-Za-z0-9_.\-]{2,40})(?:[/?#]|$)/i))) {
    const h = m[1].toLowerCase();
    if (!assetExtRe.test(h)) return { platform: "YouTube", handle: h, url: `https://www.youtube.com/@${m[1]}` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9\-]{1,38})(?:\/?(?:\?.*)?)?$/i))) {
    const h = m[1].toLowerCase();
    if (!RESERVED_PATHS.has(h)) return { platform: "GitHub", handle: h, url: `https://github.com/${m[1]}` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.)?medium\.com\/@([A-Za-z0-9_.\-]{2,40})(?:[/?#]|$)/i)) ||
      (m = cleanUrl.match(/https?:\/\/([A-Za-z0-9\-]{2,40})\.medium\.com(?:\/|$)/i))) {
    const h = m[1].toLowerCase();
    if (!RESERVED_PATHS.has(h) && !assetExtRe.test(h)) return { platform: "Medium", handle: h, url: `https://medium.com/@${m[1]}` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.|old\.)?reddit\.com\/(?:user|u)\/([A-Za-z0-9_\-]{3,30})(?:[/?#]|$)/i))) {
    const h = m[1].toLowerCase();
    if (!RESERVED_PATHS.has(h)) return { platform: "Reddit", handle: h, url: `https://www.reddit.com/user/${m[1]}` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.)?kaggle\.com\/([A-Za-z0-9_\-]{3,40})(?:\/?(?:\?.*)?)?$/i))) {
    const h = m[1].toLowerCase();
    if (!kagReserved.has(h)) return { platform: "Kaggle", handle: h, url: `https://www.kaggle.com/${m[1]}` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.)?behance\.net\/([A-Za-z0-9_\-]{3,40})(?:\/?(?:\?.*)?)?$/i))) {
    const h = m[1].toLowerCase();
    if (!behReserved.has(h)) return { platform: "Behance", handle: h, url: `https://www.behance.net/${m[1]}` };
  }
  if ((m = cleanUrl.match(/https?:\/\/(?:www\.)?dribbble\.com\/([A-Za-z0-9_\-]{3,40})(?:\/?(?:\?.*)?)?$/i))) {
    const h = m[1].toLowerCase();
    if (!drbReserved.has(h)) return { platform: "Dribbble", handle: h, url: `https://dribbble.com/${m[1]}` };
  }
  return null;
}

/**
 * General-purpose Name-Root Web & Mainstream Social Discovery over Tor:
 * - YouTube Search HTML (real /@handle channels + keynote/interview appearances)
 * - Wikipedia Direct Page (bio, official website, social links, PDFs)
 * - Direct clean public HTML profile verification for top handle permutations
 * - Respectful multi-engine direct-HTML public search cascade (Startpage, DDG Lite, DDG HTML, Brave, Mojeek)
 */
async function discoverSocialAndWeb(fullName, netCtx, depthLevel = 2, rankedHandles = []) {
  const out = {
    accounts: [], // [{ platform, handle, url, title, bio, confidence, match_tier, match_reason }]
    records: [], // [{ title, url, source, snippet, category, pdfs?, websites? }]
    websites: [], // [{ url, sourceUrl }]
    pdfs: [], // [{ url, sourceUrl }]
    emails: [],
    phones: [],
    handles: [],
    engineNotices: [], // Honest per-engine bot-challenge / rate-limit telemetry
  };
  const seenUrls = new Set();
  const seenAccountIds = new Set();
  const seenHandles = new Set();
  const declinedEngines = new Map();
  const lastEngineHitAt = new Map();

  const recordAccount = (acc) => {
    const aid = normalizeAccountNodeId(acc.platform, acc.handle);
    if (seenAccountIds.has(aid)) return false;
    seenAccountIds.add(aid);
    seenUrls.add(acc.url);
    const hl = acc.handle.toLowerCase();
    if (!acc.skipHandleTrack && !seenHandles.has(hl)) {
      seenHandles.add(hl);
      out.handles.push(hl);
    }
    out.accounts.push(acc);
    return true;
  };

  // 1. YouTube Search HTML over Tor (proven 200 OK over Tor!)
  try {
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(fullName)}`;
    const r = await sovereignFetch(ytUrl, { maxBytes: 700_000, jitter: false }, netCtx, 11000);
    if (r.ok) {
      const html = await r.text();
      const rawChunks = html.split(/"channelRenderer"\s*:\s*\{/).slice(1, 40);
      const ytCandidates = [];
      const seenYtHandles = new Set();
      const normFullLower = fullName.replace(/\s+/g, " ").trim().toLowerCase();
      for (const rawChunk of rawChunks) {
        const stopIdx = rawChunk.search(/"(?:channelRenderer|videoRenderer|shelfRenderer|reelShelfRenderer)":\{/);
        const chunk = (stopIdx > 0 ? rawChunk.slice(0, stopIdx) : rawChunk).slice(0, 3500);
        const titleMatch =
          chunk.match(/"title":\{"simpleText":"([^"]{2,100})"/) ||
          chunk.match(/"title":\{"runs":\[\{"text":"([^"]{2,100})"/);
        const baseMatch = chunk.match(/"canonicalBaseUrl":"(\/@[A-Za-z0-9_.\-]{2,40})"/);
        if (!titleMatch || !baseMatch) continue;
        const chTitle = titleMatch[1].replace(/\\u0026/g, "&").trim();
        const chHandle = baseMatch[1].replace(/^\/@/, "");
        const hl = chHandle.toLowerCase();
        if (seenYtHandles.has(hl)) continue;
        seenYtHandles.add(hl);
        if (!hasFullNameMatch(chTitle, fullName) && !hasFullNameMatch(chHandle, fullName)) continue;
        const hasRandomSuffix = /\d{3,}$|-[a-z0-9]{2,4}$/i.test(chHandle);
        const exactTitle = chTitle.replace(/\s+/g, " ").trim().toLowerCase() === normFullLower;
        const score = (exactTitle ? 4 : 0) + (!hasRandomSuffix ? 3 : 0) + (hasFullNameMatch(chHandle, fullName) ? 1 : 0);
        ytCandidates.push({ chTitle, chHandle, hasRandomSuffix, score });
      }
      ytCandidates.sort((a, b) => b.score - a.score);
      for (const c of ytCandidates.slice(0, 4)) {
        recordAccount({
          platform: "YouTube",
          handle: c.chHandle,
          url: `https://www.youtube.com/@${c.chHandle}`,
          title: c.chTitle,
          bio: `YouTube channel "${c.chTitle}" (@${c.chHandle})`,
          confidence: c.hasRandomSuffix ? 0.72 : 0.84,
          match_tier: "verified",
          match_reason: "YouTube channel matches full name",
          skipHandleTrack: c.hasRandomSuffix,
        });
      }
      const vidMatches = html.matchAll(
        /"videoRenderer":\{"videoId":"([A-Za-z0-9_\-]{11})"[\s\S]{0,1200}?"title":\{"runs":\[\{"text":"([^"]{6,140})"\}\]/g
      );
      let vidCount = 0;
      for (const m of vidMatches) {
        const vidId = m[1];
        const vidTitle = m[2].replace(/\\u0026/g, "&").trim();
        if (hasFullNameMatch(vidTitle, fullName)) {
          const vUrl = `https://www.youtube.com/watch?v=${vidId}`;
          if (!seenUrls.has(vUrl)) {
            seenUrls.add(vUrl);
            out.records.push({
              title: vidTitle,
              url: vUrl,
              source: "YouTube Media",
              snippet: `Public video/interview/keynote referencing ${fullName}.`,
              category: "corporate",
            });
            vidCount++;
            if (vidCount >= (depthLevel >= 3 ? 4 : 2)) break;
          }
        }
      }
    } else if (r.status === 429 || r.status === 403) {
      out.engineNotices.push(`youtube: HTTP ${r.status}`);
    }
  } catch {
    // ignore
  }

  // 2. Wikipedia Direct Biography Page over Tor
  try {
    const wikiSlug = fullName.trim().split(/\s+/).join("_");
    const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiSlug)}`;
    const rw = await sovereignFetch(wikiUrl, { maxBytes: 250_000, jitter: false }, netCtx, 9000);
    if (rw.ok) {
      const html = await rw.text();
      if (!html.includes("Wikipedia does not have an article with this exact name")) {
        const pM = html.match(/<p[^>]*>([\s\S]{40,600}?)<\/p>/i);
        const snippet = pM ? decodeHtmlEntities(pM[1].replace(/<[^>]+>/g, " ")).slice(0, 220) : `Wikipedia biography for ${fullName}`;
        out.records.push({
          title: `${fullName} — Wikipedia Biography`,
          url: wikiUrl,
          source: "Wikipedia",
          snippet,
          category: "corporate",
        });
        for (const m of html.matchAll(/class="external[^"]*"[^>]+href="(https?:\/\/[^"]+)"/gi)) {
          const u = m[1];
          if (/wikipedia\.org|wikimedia\.org|wikidata\.org|archive\.org/i.test(u)) continue;
          const socialAcc = extractSocialAccountFromUrl(u, fullName, fullName);
          if (socialAcc) {
            recordAccount({
              ...socialAcc,
              title: `${fullName} (${socialAcc.platform})`,
              bio: "External link on Wikipedia biography",
              confidence: 0.90,
              match_tier: "verified",
              match_reason: "Linked from Wikipedia biography",
            });
            continue;
          }
          if (u.toLowerCase().includes(".pdf")) {
            if (!out.pdfs.some((p) => p.url === u)) out.pdfs.push({ url: u, sourceUrl: wikiUrl });
          } else if (out.websites.length < 4 && !out.websites.some((w) => w.url === u)) {
            out.websites.push({ url: u, sourceUrl: wikiUrl });
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Direct public profile pages/HTML indicators for top handle permutations
  //    (ONLY non-auth-walled platforms + strict full-name HTML verification — zero hallucinations!)
  const permLimit = depthLevel === 1 ? 3 : depthLevel === 2 ? 4 : 5;
  const topPerms = (rankedHandles || []).slice(0, permLimit);
  if (topPerms.length > 0) {
    const directProbes = [];
    for (const h of topPerms) {
      directProbes.push(
        {
          platform: "YouTube",
          handle: h,
          url: `https://www.youtube.com/@${encodeURIComponent(h)}`,
          missingMarker: "this page isn't available",
        },
        {
          platform: "Dev.to",
          handle: h,
          url: `https://dev.to/${encodeURIComponent(h)}`,
          missingMarker: "this page does not exist",
        },
        {
          platform: "Medium",
          handle: h,
          url: `https://medium.com/@${encodeURIComponent(h)}`,
          missingMarker: "page not found",
        },
        {
          platform: "HuggingFace",
          handle: h,
          url: `https://huggingface.co/${encodeURIComponent(h)}`,
          missingMarker: "sorry, we can't find the page",
        },
        {
          platform: "Kaggle",
          handle: h,
          url: `https://www.kaggle.com/${encodeURIComponent(h)}`,
          missingMarker: "we can't find that page",
        }
      );
    }
    let probeIdx = 0;
    const probeWorker = async () => {
      while (probeIdx < directProbes.length) {
        const spec = directProbes[probeIdx++];
        if (seenAccountIds.has(normalizeAccountNodeId(spec.platform, spec.handle))) continue;
        try {
          const r = await sovereignFetch(spec.url, { maxBytes: 90_000, jitter: false }, netCtx, 5500);
          if (!r.ok || r.status !== 200) continue;
          const html = (await r.text()).slice(0, 90_000);
          const low = html.toLowerCase();
          if (spec.missingMarker && low.includes(spec.missingMarker)) continue;
          if (SIDECAR_SOFT_404_PHRASES.some((p) => low.includes(p))) continue;
          const sig = extractPageSignals(html, spec.url);
          const cleanTitle = decodeHtmlEntities(sig.title).replace(/\s*[-|·]\s*(Medium|DEV Community|Hugging Face|Kaggle|YouTube).*$/i, "").trim();
          const cleanDesc = decodeHtmlEntities(sig.description);
          if (!cleanTitle || /^(medium|kaggle|youtube|hugging face|dev community)$/i.test(cleanTitle)) continue;
          if (!hasFullNameMatch(`${cleanTitle} ${cleanDesc}`, fullName)) continue;
          recordAccount({
            platform: spec.platform,
            handle: spec.handle,
            url: spec.url,
            title: cleanTitle,
            bio: cleanDesc.slice(0, 180) || `${spec.platform} profile confirmed for ${fullName}`,
            confidence: 0.84,
            match_tier: "verified",
            match_reason: `${spec.platform} direct HTML confirmed full name`,
          });
        } catch {
          // ignore unreachable
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, probeWorker));
  }

  // 4. Bulletproof Startpage-First Multi-Engine Direct-HTML Cascade (3-circuit IsolateSOCKSAuth retry)
  let circuitSeq = 0;
  const circuitNonce = Math.floor(Date.now() / 1000).toString(36);
  const nextSocksUser = () => `tauf-${circuitNonce}-${++circuitSeq}`;

  const processSearchItems = (engId, kind, items, filterPlatform = null) => {
    let engineHits = 0;
    for (const item of items.slice(0, 10)) {
      if (!item.url.startsWith("http") || isBlockedSpaUrl(item.url)) continue;
      const fullTextMatch =
        hasFullNameMatch(`${item.title} ${item.snippet}`, fullName) ||
        (hasFullNameMatch(item.url, fullName) && sharesNameToken(`${item.title} ${item.snippet}`, fullName));
      if (!fullTextMatch) continue;

      // Always capture public PDFs regardless of which query surfaced them
      if (/\.pdf(?:$|[?#])/i.test(item.url) || item.url.toLowerCase().includes(".pdf")) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          out.pdfs.push({
            url: item.url,
            sourceUrl: null,
            title: item.title,
            snippet: item.snippet,
          });
          engineHits++;
        }
        continue;
      }

      // Extract contacts on contact queries (without discarding websites/records below)
      if (kind === "contact") {
        let foundContact = false;
        for (const emM of `${item.title} ${item.snippet}`.matchAll(/\b([A-Za-z0-9._%+\-]{2,64}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,12})\b/g)) {
          const em = emM[1].toLowerCase();
          if (!isNoiseEmail(em) && !out.emails.includes(em)) {
            out.emails.push(em);
            foundContact = true;
          }
        }
        for (const ph of extractPublicPhones(`${item.title} ${item.snippet}`)) {
          if (!out.phones.includes(ph)) {
            out.phones.push(ph);
            foundContact = true;
          }
        }
        if (foundContact) engineHits++;
      }

      // Check mainstream social / developer profile URLs
      const acc = extractSocialAccountFromUrl(item.url, item.title, fullName);
      if (acc) {
        if (filterPlatform && acc.platform !== filterPlatform) continue;
        const ownedSocial = sharesNameToken(acc.handle, fullName) || hasFullNameMatch(item.title, fullName);
        if (!ownedSocial) continue;
        seenUrls.add(item.url);
        const added = recordAccount({
          ...acc,
          title: item.title,
          bio: item.snippet,
          confidence: 0.85,
          match_tier: "verified",
          match_reason: `${acc.platform} profile confirmed via ${engId}`,
        });
        if (added) engineHits++;
        continue;
      }

      // Non-social web results: never drop real personal/company websites or public records even during social queries
      let host = "";
      try {
        host = new URL(item.url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        host = engId;
      }
      if (/(?:^|\.)(?:instagram\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com|threads\.net)$/i.test(host)) {
        continue;
      }
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      const isPersonalOrCompany = isPersonalOrCompanyWebsiteCandidate(item.url, item.title, item.snippet, fullName);
      if (isPersonalOrCompany && out.websites.length < 4 && !out.websites.some((w) => w.url === item.url)) {
        out.websites.push({
          url: item.url,
          sourceUrl: null,
          title: item.title,
          snippet: item.snippet,
        });
      }

      if (kind !== "contact" || isPersonalOrCompany) {
        const recType = isPersonalOrCompany
          ? "Personal / Company Website"
          : inferRecordType(item.url, item.title, item.snippet, kind === "legal_corp" ? "Corporate Filing" : "Public Web Record");
        out.records.push({
          title: item.title,
          url: item.url,
          source: host,
          snippet: item.snippet,
          category: "corporate",
          record_type: recType,
        });
        engineHits++;
      }
    }
    return engineHits;
  };

  const runDorkCascade = async (kind, query, filterPlatform = null) => {
    let matchedCount = 0;

    // 1. Primary Engine: Startpage over Tor with up to 3 attempts on 3 distinct IsolateSOCKSAuth circuits
    const spRes = await queryStartpageWithRetry(query, netCtx, nextSocksUser, 15000);
    if (spRes.strictBlocked) return 0;
    if (spRes.ok) {
      matchedCount += processSearchItems("startpage", kind, spRes.items, filterPlatform);
      // Do NOT fall through to backup engines when Startpage returned clean HTTP 200 OK HTML
      return matchedCount;
    }
    // Never permanently ban Startpage across queries — only record per-query notice if all 3 circuits failed
    if (spRes.reason) {
      out.engineNotices.push(`startpage(${kind}): ${spRes.reason}`);
    }

    // 2. Fallback Engines only when Startpage failed all 3 circuits for this query
    for (const eng of SEARCH_ENGINES.filter((e) => e.id !== "startpage")) {
      if (declinedEngines.has(eng.id)) continue;
      const lastTs = lastEngineHitAt.get(eng.id) || 0;
      const since = Date.now() - lastTs;
      if (since < 350) {
        await new Promise((r) => setTimeout(r, 350 - since));
      }
      lastEngineHitAt.set(eng.id, Date.now());
      try {
        const url = eng.buildUrl(query);
        const reqTimeout = eng.timeoutMs || 9500;
        let r = await sovereignFetch(
          url,
          { maxBytes: 450_000, jitter: false, socksUser: nextSocksUser() },
          netCtx,
          reqTimeout
        );
        let html = r.ok ? await r.text() : "";
        let challenge = detectSearchChallenge(r, html);
        if (challenge && eng.id === "ddg-lite" && netCtx?.proxyHost) {
          r = await sovereignFetch(
            url,
            { maxBytes: 450_000, jitter: false, socksUser: nextSocksUser() },
            netCtx,
            reqTimeout
          );
          html = r.ok ? await r.text() : "";
          challenge = detectSearchChallenge(r, html);
        }
        if (challenge) {
          declinedEngines.set(eng.id, challenge);
          out.engineNotices.push(`${eng.id}: ${challenge}`);
          continue;
        }
        const items = parseSearchResults(eng.id, html);
        const engineHits = processSearchItems(eng.id, kind, items, filterPlatform);
        matchedCount += engineHits;
        if (engineHits > 0) break;
      } catch (err) {
        if (String(err?.message || "").includes("STRICT_ANONYMITY_BLOCKED")) break;
        declinedEngines.set(eng.id, "timeout/unreachable");
        out.engineNotices.push(`${eng.id}: timeout`);
      }
    }
    return matchedCount;
  };

  // Startpage-friendly query cascade (up to 10 results/query across engines)
  await runDorkCascade("social", `"${fullName}" instagram`);
  await runDorkCascade("social", `"${fullName}" linkedin`);
  await runDorkCascade("general", `"${fullName}"`);
  await runDorkCascade("pdf", `"${fullName}" filetype:pdf`);
  if (depthLevel >= 2) {
    await runDorkCascade("legal_corp", `"${fullName}" ("director" OR "founder" OR "CEO" OR "patent" OR "court")`);
  }
  if (depthLevel >= 3) {
    await runDorkCascade("contact", `"${fullName}" ("@gmail.com" OR "@proton.me" OR "email" OR "contact")`);
  }

  return out;
}

/**
 * Direct Legal, Court & Academic Public Records Discovery over Tor (Zero APIs!):
 * - CourtListener (www.courtlistener.com/?q="Full Name") -> real court opinions/dockets
 * - arXiv Author Search (arxiv.org/search/?query=Full+Name&searchtype=author) -> papers + direct PDFs!
 */
async function discoverPublicRecords(fullName, netCtx, depthLevel = 2) {
  const records = [];
  const pdfLinks = []; // [{ url, parentRecordUrl, title?, snippet? }]
  const seen = new Set();
  const prNonce = `pr-${Math.floor(Date.now() / 1000).toString(36)}`;
  let prSeq = 0;
  const nextPrSocksUser = () => `${prNonce}-${++prSeq}`;

  const addPdfLink = (url, parentRecordUrl = null, title = null, snippet = null) => {
    if (!url || pdfLinks.some((p) => p.url === url)) return;
    pdfLinks.push({ url, parentRecordUrl, title, snippet });
  };

  await Promise.all([
    // 1. US CourtListener Direct HTML
    (async () => {
      try {
        const clUrl = `https://www.courtlistener.com/?q=${encodeURIComponent(`"${fullName}"`)}`;
        const r = await sovereignFetch(clUrl, { maxBytes: 260_000, jitter: false }, netCtx, 11000);
        if (!r.ok) return;
        const html = await r.text();
        const arts = html.match(/<article[^>]*>[\s\S]*?<\/article>/gi) || [];
        let count = 0;
        for (const a of arts) {
          const linkM = a.match(/<a[^>]+href="(\/(?:opinion|docket)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          if (!linkM) continue;
          const title = decodeHtmlEntities(linkM[2].replace(/<[^>]+>/g, " "));
          const textClean = decodeHtmlEntities(a.replace(/<[^>]+>/g, " "));
          if (!hasFullNameMatch(textClean, fullName)) continue;
          const url = `https://www.courtlistener.com${linkM[1].split("?")[0]}`;
          if (seen.has(url)) continue;
          seen.add(url);
          records.push({
            title: title.slice(0, 110),
            url,
            source: "CourtListener",
            snippet: textClean.slice(0, 180),
            kind: "record",
            record_type: "Legal / Court Record",
          });
          count++;
          if (count >= (depthLevel >= 3 ? 4 : 2)) break;
        }
      } catch {
        // ignore
      }
    })(),

    // 2. arXiv Academic Author Search Direct HTML
    (async () => {
      try {
        const axUrl = `https://arxiv.org/search/?query=${encodeURIComponent(fullName)}&searchtype=author&abstracts=show&order=-announced_date_first&size=25`;
        const r = await sovereignFetch(axUrl, { maxBytes: 220_000, jitter: false }, netCtx, 10000);
        if (!r.ok) return;
        const html = await r.text();
        const items = html.split(/<li class="arxiv-result">/i).slice(1);
        let count = 0;
        for (const it of items) {
          const tM = it.match(/<p class="title is-5 mathjax">([\s\S]*?)<\/p>/i);
          const aM = it.match(/<p class="authors">([\s\S]*?)<\/p>/i);
          const pdfM = it.match(/href="(https:\/\/arxiv\.org\/pdf\/[^"]+)"/i);
          const absM = it.match(/href="(https:\/\/arxiv\.org\/abs\/[^"]+)"/i);
          const authorsTxt = aM ? decodeHtmlEntities(aM[1].replace(/<[^>]+>/g, " ")) : "";
          if (!hasFullNameMatch(authorsTxt, fullName)) continue;
          const title = tM ? decodeHtmlEntities(tM[1].replace(/<[^>]+>/g, " ")) : "arXiv Paper";
          const url = absM ? absM[1] : pdfM ? pdfM[1] : null;
          if (!url || seen.has(url)) continue;
          seen.add(url);
          records.push({
            title: title.slice(0, 110),
            url,
            source: "arXiv Research",
            snippet: authorsTxt.slice(0, 160),
            kind: "record",
            record_type: "Academic Publication",
          });
          if (pdfM) {
            addPdfLink(pdfM[1], url, title, authorsTxt.slice(0, 180));
          }
          count++;
          if (count >= (depthLevel >= 3 ? 5 : 3)) break;
        }
      } catch {
        // ignore
      }
    })(),

    // 3. IndianKanoon Direct HTML Legal / Court Records
    (async () => {
      try {
        const ikUrl = `https://indiankanoon.org/search/?formInput=${encodeURIComponent(`"${fullName}"`)}`;
        const r = await sovereignFetch(
          ikUrl,
          { maxBytes: 280_000, jitter: false, socksUser: nextPrSocksUser() },
          netCtx,
          12000
        );
        if (!r.ok) return;
        const html = await r.text();
        const chunks = html.split(/<div\b[^>]*class=["'][^"']*result_title[^"']*["'][^>]*>/i).slice(1);
        let count = 0;
        for (const blk of chunks) {
          const aM = blk.match(/<a\b[^>]*href=["'](\/(?:doc|docfragment)\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
          if (!aM) continue;
          const title = decodeHtmlEntities(aM[2].replace(/<[^>]+>/g, " "));
          const snM = blk.match(/<div\b[^>]*class=["'][^"']*headline[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, " ")) : title;
          if (!hasFullNameMatch(`${title} ${snippet}`, fullName)) continue;
          const docPath = aM[1].replace(/^\/docfragment\//i, "/doc/").split("?")[0];
          const url = `https://indiankanoon.org${docPath}`;
          if (seen.has(url)) continue;
          seen.add(url);
          records.push({
            title: title.slice(0, 110),
            url,
            source: "IndianKanoon",
            snippet: snippet.slice(0, 200),
            kind: "record",
            record_type: "Legal / Court Record",
          });
          count++;
          if (count >= (depthLevel >= 3 ? 4 : 2)) break;
        }
      } catch {
        // ignore
      }
    })(),

    // 4. Global Corporate, Directorship, LLP & Registry Filings (Startpage over Tor with 3-circuit retry)
    (async () => {
      const corpQuery = `"${fullName}" (director OR LLP OR CIN OR DIN OR "Form MGT-7" OR "annual return" OR "founder" OR "managing director" OR "CEO" OR site:falconebiz.com OR site:zaubacorp.com OR site:tofler.in OR site:opencorporates.com OR site:thecompanycheck.com OR site:companieshouse.gov.uk)`;
      const spRes = await queryStartpageWithRetry(corpQuery, netCtx, nextPrSocksUser, 15000);
      if (!spRes.ok) return;
      let count = 0;
      for (const item of spRes.items.slice(0, 10)) {
        if (!item.url.startsWith("http") || isBlockedSpaUrl(item.url)) continue;
        const fullMatch =
          hasFullNameMatch(`${item.title} ${item.snippet}`, fullName) ||
          (hasFullNameMatch(item.url, fullName) && sharesNameToken(`${item.title} ${item.snippet}`, fullName));
        if (!fullMatch) continue;
        if (/\.pdf(?:$|[?#])/i.test(item.url) || item.url.toLowerCase().includes(".pdf")) {
          addPdfLink(item.url, null, item.title, item.snippet);
          continue;
        }
        let host = "";
        try {
          host = new URL(item.url).hostname.replace(/^www\./, "").toLowerCase();
        } catch {
          host = "registry";
        }
        if (/(?:^|\.)(?:instagram\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com|threads\.net)$/i.test(host)) {
          continue;
        }
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        records.push({
          title: item.title.slice(0, 110),
          url: item.url,
          source: host,
          snippet: item.snippet.slice(0, 220),
          kind: "record",
          record_type: "Corporate Filing",
        });
        count++;
        if (count >= (depthLevel >= 3 ? 6 : 4)) break;
      }
    })(),

    // 5. Global Legal, Regulatory, Patent & Academic/Public Document Discovery (Startpage over Tor)
    (async () => {
      const docQuery = `"${fullName}" (court OR judgment OR docket OR tribunal OR gazette OR patent OR publication OR thesis OR scribd OR researchgate OR "executive summary" OR filetype:pdf)`;
      const spRes = await queryStartpageWithRetry(docQuery, netCtx, nextPrSocksUser, 15000);
      if (!spRes.ok) return;
      let count = 0;
      for (const item of spRes.items.slice(0, 10)) {
        if (!item.url.startsWith("http") || isBlockedSpaUrl(item.url)) continue;
        const fullMatch =
          hasFullNameMatch(`${item.title} ${item.snippet}`, fullName) ||
          (hasFullNameMatch(item.url, fullName) && sharesNameToken(`${item.title} ${item.snippet}`, fullName));
        if (!fullMatch) continue;
        if (/\.pdf(?:$|[?#])/i.test(item.url) || item.url.toLowerCase().includes(".pdf")) {
          addPdfLink(item.url, null, item.title, item.snippet);
          continue;
        }
        let host = "";
        try {
          host = new URL(item.url).hostname.replace(/^www\./, "").toLowerCase();
        } catch {
          host = "public-doc";
        }
        if (/(?:^|\.)(?:instagram\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com|threads\.net)$/i.test(host)) {
          continue;
        }
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        const recType = inferRecordType(item.url, item.title, item.snippet, "Academic Publication");
        records.push({
          title: item.title.slice(0, 110),
          url: item.url,
          source: host,
          snippet: item.snippet.slice(0, 220),
          kind: "record",
          record_type: recType,
        });
        count++;
        if (count >= (depthLevel >= 3 ? 6 : 4)) break;
      }
    })(),
  ]);

  return { records, pdfLinks };
}

/**
 * Public Paste & Leak Mention Discovery over Tor (Startpage with IsolateSOCKSAuth 3-circuit retry):
 * Searches Pastebin, Rentry, Dpaste, JustPaste.it, Ghostbin, ControlC, Paste.ee, and leak/breach
 * references for exact full-name or exact email matches (zero false positives).
 */
async function discoverPasteAndLeakMentions(fullName, knownEmails, knownHandles, netCtx, depthLevel = 2) {
  const hits = [];
  const seenUrls = new Set();
  const nonce = `pl-${Math.floor(Date.now() / 1000).toString(36)}`;
  let seq = 0;
  const nextSocksUser = () => `${nonce}-${++seq}`;

  const queries = [
    {
      q: `"${fullName}" (site:pastebin.com OR site:rentry.co OR site:dpaste.org OR site:justpaste.it OR site:ghostbin.me OR site:controlc.com OR site:paste.ee)`,
      queryType: "full_name",
      parentEmail: null,
      requireLeakKeyword: false,
    },
  ];
  if (knownEmails.length > 0) {
    queries.push({
      q: `"${knownEmails[0]}" (site:pastebin.com OR site:rentry.co OR site:justpaste.it OR "leak" OR "breach" OR "combolist" OR "paste")`,
      queryType: "email",
      parentEmail: knownEmails[0],
      requireLeakKeyword: false,
    });
  }
  if (depthLevel >= 3) {
    queries.push({
      q: `"${fullName}" ("doxbin" OR "breach" OR "combolist" OR "leaked database" OR ".onion")`,
      queryType: "full_name",
      parentEmail: null,
      requireLeakKeyword: true,
    });
  }

  const pasteOrLeakRe = /\b(doxbin|breach|combolist|leaked|leak|paste|pastebin|rentry|dpaste|justpaste|ghostbin|controlc|paste\.ee|\.onion)\b/i;

  for (const spec of queries) {
    const spRes = await queryStartpageWithRetry(spec.q, netCtx, nextSocksUser, 15000);
    if (spRes.strictBlocked) break;
    if (!spRes.ok) continue;
    for (const item of spRes.items.slice(0, 8)) {
      if (!item.url.startsWith("http") || isBlockedSpaUrl(item.url)) continue;
      if (seenUrls.has(item.url)) continue;
      const textCombined = `${item.title || ""} ${item.snippet || ""}`;
      const matched =
        spec.queryType === "email" && spec.parentEmail
          ? textCombined.toLowerCase().includes(spec.parentEmail.toLowerCase())
          : hasFullNameMatch(textCombined, fullName);
      if (!matched) continue;
      if (spec.requireLeakKeyword && !pasteOrLeakRe.test(`${item.url} ${textCombined}`)) continue;

      let host = "";
      try {
        host = new URL(item.url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        host = "paste";
      }
      // Never misclassify regular GitHub Gist user profiles as paste leaks
      if (host === "gist.github.com" && !/\/[a-f0-9]{16,}/i.test(item.url)) continue;

      seenUrls.add(item.url);
      hits.push({
        title: (item.title || host).slice(0, 110),
        url: item.url,
        snippet: (item.snippet || "").slice(0, 240),
        host,
        matchedTerm: spec.parentEmail || fullName,
        queryType: spec.queryType,
        parentEmail: spec.parentEmail,
      });
      if (hits.length >= 8) break;
    }
    if (hits.length >= 8) break;
  }

  return hits;
}

/**
 * Real Ahmia v3 .onion parser over Tor SOCKS5h (with clean https://ahmia.fi over-Tor fallback):
 * Quotes multi-word names accurately, grabs rotating hidden form token + cookie,
 * and parses `<li class="result">` items cleanly.
 */
async function queryAhmiaOnion(torHost, torPort, rawQuery) {
  const hits = [];
  const cleanQuery = String(rawQuery || "").replace(/^["']+|["']+$/g, "").trim();
  if (!cleanQuery) return hits;
  const formattedQuery = /\s/.test(cleanQuery) ? `"${cleanQuery}"` : cleanQuery;

  const queryBase = async (baseUrl, engineLabel) => {
    try {
      const home = await socks5hRequest(torHost, torPort, `${baseUrl}/`, {
        timeoutMs: 14000,
        maxBytes: 90_000,
        jitter: false,
      });
      if (!home.ok) return;
      const homeHtml = await home.text();
      const hm = homeHtml.match(/<input[^>]+type=["']hidden["'][^>]+name=["']([^"']+)["'][^>]+value=["']([^"']+)["']/i);
      const cookie = home.headers.get("set-cookie")?.split(";")[0] || null;
      const searchUrl = hm
        ? `${baseUrl}/search/?q=${encodeURIComponent(formattedQuery)}&${encodeURIComponent(hm[1])}=${encodeURIComponent(hm[2])}`
        : `${baseUrl}/search/?q=${encodeURIComponent(formattedQuery)}`;

      const res = await socks5hRequest(torHost, torPort, searchUrl, {
        timeoutMs: 16000,
        maxBytes: 750_000,
        jitter: false,
        headers: cookie ? { Cookie: cookie } : {},
      });
      if (!res.ok) return;
      const html = await res.text();
      const lis = html.match(/<li class="result"[\s\S]*?<\/li>/gi) || [];
      for (const li of lis.slice(0, 15)) {
        const h4 = li.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
        const cite = li.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
        const p = li.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        const aHref = li.match(/href="([^"]+)"/i);
        let onionUrl = cite ? decodeHtmlEntities(cite[1].replace(/<[^>]+>/g, "")) : "";
        if (aHref) {
          const redir = aHref[1].match(/redirect_url=(https?[^&"']+)/i);
          if (redir) {
            try {
              onionUrl = decodeURIComponent(redir[1]);
            } catch {
              // keep cite
            }
          }
        }
        if (!onionUrl || !onionUrl.includes(".onion")) continue;
        if (!onionUrl.startsWith("http")) onionUrl = `http://${onionUrl}`;
        if (onionUrl.includes("juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd")) continue;
        const title = h4 ? decodeHtmlEntities(h4[1].replace(/<[^>]+>/g, " ")) : onionUrl;
        const snippet = p ? decodeHtmlEntities(p[1].replace(/<[^>]+>/g, " ")) : "";
        hits.push({
          engine: engineLabel,
          query: cleanQuery,
          title: title.slice(0, 120),
          url: onionUrl,
          snippet: snippet.slice(0, 260),
        });
      }
    } catch {
      // ignore Tor circuit timeout
    }
  };

  await queryBase(AHMIA_V3_BASE, "Ahmia v3");
  if (hits.length === 0) {
    await queryBase("https://ahmia.fi", "Ahmia Mirror (Tor)");
  }
  return hits;
}

/**
 * Real OnionLand v3 .onion organic parser over Tor SOCKS5h:
 * Quotes multi-word names and parses organic `<div class="result-block">` items while skipping sponsored ads.
 */
async function queryOnionLand(torHost, torPort, rawQuery, stats = null) {
  const hits = [];
  const cleanQuery = String(rawQuery || "").replace(/^["']+|["']+$/g, "").trim();
  if (!cleanQuery) return hits;
  const formattedQuery = /\s/.test(cleanQuery) ? `"${cleanQuery}"` : cleanQuery;
  try {
    const searchUrl = `${ONIONLAND_V3_BASE}/search?q=${encodeURIComponent(formattedQuery)}`;
    const res = await socks5hRequest(torHost, torPort, searchUrl, {
      timeoutMs: 16000,
      maxBytes: 450_000,
      jitter: false,
    });
    if (!res.ok) return hits;
    const html = await res.text();
    const blocks = html.split(/<div class="result-block">/i).slice(1);
    for (const blk of blocks) {
      if (/sponsored|\/ads\/click/i.test(blk.slice(0, 450))) {
        if (stats) stats.adsFiltered++;
        continue;
      }
      const tM = blk.match(/<div class="title"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      const lM = blk.match(/<div class="link"[^>]*>([\s\S]*?)<\/div>/i);
      const dM = blk.match(/<div class="desc"[^>]*>([\s\S]*?)<\/div>/i);
      let onionUrl = lM ? decodeHtmlEntities(lM[1].replace(/<[^>]+>/g, "")) : "";
      if (!onionUrl || !onionUrl.includes(".onion")) continue;
      if (!onionUrl.startsWith("http")) onionUrl = `http://${onionUrl}`;
      const title = tM ? decodeHtmlEntities(tM[1].replace(/<[^>]+>/g, " ")) : onionUrl;
      const snippet = dM ? decodeHtmlEntities(dM[1].replace(/<[^>]+>/g, " ")) : "";
      hits.push({
        engine: "OnionLand v3",
        query: cleanQuery,
        title: title.slice(0, 120),
        url: onionUrl,
        snippet: snippet.slice(0, 260),
      });
      if (hits.length >= 8) break;
    }
  } catch {
    // ignore timeout
  }
  return hits;
}

/**
 * Bounded Tor socks5h:// GET inspection of a live .onion page (64KB max, 7s timeout).
 */
async function fetchOnionPageSnippet(torHost, torPort, onionUrl) {
  try {
    const res = await socks5hRequest(torHost, torPort, onionUrl, {
      timeoutMs: 7000,
      maxBytes: 65536,
      jitter: false,
    });
    if (!res.ok) return { reachable: false };
    const html = (await res.text()).slice(0, 65536);
    const titleM = html.match(/<title[^>]*>([\s\S]{1,180}?)<\/title>/i);
    const metaM =
      html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']{4,300})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{4,300})["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
    const h1M = html.match(/<h1[^>]*>([\s\S]{1,160}?)<\/h1>/i);
    const cleanText = decodeHtmlEntities(
      stripBoilerplateHtml(html)
        .replace(/<[^>]+>/g, " ")
    ).slice(0, 40_000);
    return {
      reachable: true,
      title: titleM ? decodeHtmlEntities(titleM[1]) : "",
      metaDesc: metaM ? decodeHtmlEntities(metaM[1]) : "",
      h1: h1M ? decodeHtmlEntities(h1M[1].replace(/<[^>]+>/g, " ")) : "",
      livePageText: cleanText,
    };
  } catch {
    return { reachable: false };
  }
}

function hasExactPhraseProximity(text, fullName) {
  const cleanText = String(text || "").toLowerCase().replace(/\s+/g, " ");
  const cleanName = String(fullName || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!cleanName) return false;
  if (cleanText.includes(cleanName)) return true;
  const parts = getNameParts(fullName);
  if (parts.length < 2) return parts.length === 1 && cleanText.includes(parts[0]);
  const first = parts[0];
  const last = parts[parts.length - 1];
  let idx = 0;
  while ((idx = cleanText.indexOf(first, idx)) !== -1) {
    const windowStr = cleanText.slice(idx, idx + 70);
    if (windowStr.includes(last)) return true;
    idx += first.length;
  }
  return false;
}

function extractContextExcerpt(text, term) {
  const clean = decodeHtmlEntities(String(text || ""));
  if (!clean) return "";
  const low = clean.toLowerCase();
  const needle = String(term || "").toLowerCase().trim();
  let idx = needle ? low.indexOf(needle) : -1;
  if (idx === -1 && needle) {
    const toks = needle.split(/\s+/).filter((t) => t.length >= 3);
    for (const t of toks) {
      idx = low.indexOf(t);
      if (idx !== -1) break;
    }
  }
  if (idx === -1) return clean.slice(0, 260);
  const start = Math.max(0, idx - 140);
  const end = Math.min(clean.length, idx + Math.max(12, needle.length) + 140);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}

function classifyOnionSitePurpose(combinedForSite) {
  const s = combinedForSite.toLowerCase();
  if (/\b(breach|leak|leaked|dump|combolist|stealer|logs|credential|password|doxbin|ransomware|exfil|database)\b/i.test(s)) {
    return {
      site_category: "Leak / Breach Archive",
      site_purpose: "Darknet leak or breach repository indexing exposed dumps, databases, or credential records.",
    };
  }
  if (/\b(paste|pastebin|dox|doxx|zerobin|privatebin|stronghold|notepad|ghostbin|cl1p)\b/i.test(s)) {
    return {
      site_category: "Paste / Dox Board",
      site_purpose: "Anonymous Tor paste or dox board where unmoderated text dumps, notes, or personal data are published.",
    };
  }
  if (/\b(forum|thread|topic|board|community|bbs|chan|dread|discussion|replies|posts|register to post)\b/i.test(s)) {
    return {
      site_category: "Darknet Forum / Discussion",
      site_purpose: "Tor hidden-service discussion forum or message board hosting user threads and replies.",
    };
  }
  if (/\b(market|marketplace|vendor|escrow|shop|store|cart|checkout|bitcoin|monero|xmr|btc|buy now|listing)\b/i.test(s)) {
    return {
      site_category: "Hidden Marketplace / Vendor",
      site_purpose: "Tor hidden marketplace or vendor storefront listing goods, digital services, or escrow listings.",
    };
  }
  if (/\b(wiki|directory|hidden wiki|index of|onion links|link list|catalog|links directory|portal)\b/i.test(s)) {
    return {
      site_category: "Hidden Service Directory / Wiki",
      site_purpose: "Tor hidden-service directory or wiki cataloging and categorizing .onion site links.",
    };
  }
  if (/\b(news|press|whistleblower|securedrop|journal|archive|library|mirror|freedom|publication|paper)\b/i.test(s)) {
    return {
      site_category: "News / Whistleblower / Archive",
      site_purpose: "Tor-accessible journalism mirror, whistleblower drop, archival library, or independent publication.",
    };
  }
  if (/\b(search engine|crawler|aggregator|search results|ahmia|torch|haystak|onionland|excavator)\b/i.test(s)) {
    return {
      site_category: "Search / Aggregator Mirror",
      site_purpose: "Tor hidden-service search engine or web crawler aggregating indexed .onion results.",
    };
  }
  return {
    site_category: "Unclassified Hidden Service",
    site_purpose: "Tor hidden service indexed on the onion network; review title, path, and excerpt for context.",
  };
}

/**
 * Filter unrelated darknet spam, score match precision/tier, and classify every .onion hit
 * with clear "where it appears" + "what this site is used for" intelligence.
 */
function classifyOnionHit(hit, query, queryType, fullName, livePageData = null) {
  const cleanQuery = String(query || hit.query || "").replace(/^["']+|["']+$/g, "").trim();
  const qType = queryType || (cleanQuery.includes("@") ? "email" : hasExactPhraseProximity(cleanQuery, fullName) ? "full_name" : "handle");

  let onionHost = "";
  let whereFound = "";
  try {
    const parsed = new URL(hit.url.startsWith("http") ? hit.url : `http://${hit.url}`);
    onionHost = parsed.hostname.toLowerCase();
    const pathAndQuery = `${parsed.pathname || "/"}${parsed.search || ""}`;
    whereFound = `${onionHost}${pathAndQuery}`;
  } catch {
    onionHost = String(hit.url || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    whereFound = String(hit.url || "").replace(/^https?:\/\//i, "");
  }
  if (!onionHost.includes(".onion")) return null;

  const isLive = Boolean(livePageData?.reachable);
  const pageStatus = isLive ? "live_verified" : "index_only";
  const bestTitle = (isLive && livePageData.title ? livePageData.title : hit.title) || onionHost;
  const indexCorpus = [hit.title, hit.snippet, hit.url].filter(Boolean).join(" ");
  const liveCorpus = isLive
    ? [livePageData.title, livePageData.metaDesc, livePageData.h1, livePageData.livePageText].filter(Boolean).join(" ")
    : "";
  const combinedCorpus = `${indexCorpus} ${liveCorpus}`;
  const lowCombined = combinedCorpus.toLowerCase();
  const lowIndex = indexCorpus.toLowerCase();

  let match_precision = null;
  let match_tier = null;
  let confidence = 0.42;
  let matched_identifier = "";
  let searchHighlightTerm = cleanQuery;

  if (qType === "email") {
    if (lowCombined.includes(cleanQuery.toLowerCase())) {
      match_precision = "exact";
      match_tier = "verified";
      confidence = isLive ? 0.91 : 0.86;
      matched_identifier = `Email: ${cleanQuery}`;
    } else {
      return null;
    }
  } else if (qType === "full_name") {
    if (hasExactPhraseProximity(combinedCorpus, fullName)) {
      match_precision = "exact";
      match_tier = "verified";
      confidence = isLive ? 0.89 : 0.84;
      matched_identifier = `Full Name: ${fullName}`;
      searchHighlightTerm = fullName;
    } else {
      const parts = getNameParts(fullName);
      const longTokens = parts.filter((p) => p.length >= 5);
      const matchedTokens = longTokens.filter((tok) => new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lowIndex));
      if (matchedTokens.length > 0 || (parts.length >= 2 && lowIndex.includes(parts[0]) && lowIndex.includes(parts[parts.length - 1]))) {
        match_precision = "partial";
        match_tier = "collision";
        confidence = 0.42;
        matched_identifier = `Partial Name: ${matchedTokens[0] || fullName}`;
        searchHighlightTerm = matchedTokens[0] || parts[0] || fullName;
      } else {
        return null; // Drop unrelated darknet spam completely!
      }
    }
  } else {
    // handle or domain
    const escQ = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactBoundary = new RegExp(`(?:^|[^a-z0-9])${escQ}(?:$|[^a-z0-9])`, "i");
    if (cleanQuery.length >= 4 && (exactBoundary.test(lowCombined) || (qType === "domain" && lowCombined.includes(cleanQuery.toLowerCase())))) {
      match_precision = "handle";
      match_tier = "probable";
      confidence = isLive ? 0.78 : 0.72;
      matched_identifier = qType === "domain" ? `Domain: ${cleanQuery}` : `Handle: @${cleanQuery}`;
    } else {
      return null; // Drop unrelated spam
    }
  }

  const { site_category, site_purpose } = classifyOnionSitePurpose(
    `${hit.url} ${bestTitle} ${hit.snippet || ""} ${livePageData?.metaDesc || ""} ${livePageData?.h1 || ""} ${(livePageData?.livePageText || "").slice(0, 4000)}`
  );

  const excerptSource =
    isLive && livePageData.livePageText && livePageData.livePageText.toLowerCase().includes(searchHighlightTerm.toLowerCase())
      ? livePageData.livePageText
      : `${hit.title || ""} ${hit.snippet || ""} ${livePageData?.metaDesc || ""}`.trim();
  const context_excerpt = extractContextExcerpt(excerptSource, searchHighlightTerm);
  const bio = (isLive && livePageData.metaDesc ? livePageData.metaDesc : hit.snippet || bestTitle).slice(0, 220);

  return {
    title: bestTitle.slice(0, 100),
    url: hit.url,
    onion_host: onionHost,
    where_found: whereFound,
    site_category,
    site_purpose,
    matched_identifier,
    matched_term: cleanQuery,
    match_precision,
    match_tier,
    page_status: pageStatus,
    engine: hit.engine || "Ahmia v3",
    context_excerpt,
    bio,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Full Sovereign V4 Investigation Pipeline (Name-Root, 4-Level Depth + ETA)
// ---------------------------------------------------------------------------

async function runInvestigation(caseId, input, auth) {
  const snap = state.cases.get(caseId);
  if (!snap) return;

  state.activeInvestigations++;
  cancelIdleShutdown();
  const startedMs = Date.now();
  const depthLevel = Math.max(1, Math.min(4, Number(input.depth_level || 2)));
  const estTotalSec = { 1: 22, 2: 65, 3: 115, 4: 185 }[depthLevel] || 65;

  const emitStage = (stage, message, progress) => {
    const elapsedSec = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    let etaSec = 0;
    if (progress < 100) {
      const rateEst = progress >= 15 ? Math.round((elapsedSec / progress) * (100 - progress)) : Math.round((estTotalSec * (100 - progress)) / 100);
      etaSec = Math.max(2, Math.min(300, Math.round((rateEst + (estTotalSec * (100 - progress)) / 100) / 2)));
    }
    broadcastEvent({
      kind: "stage",
      case_id: caseId,
      stage,
      message,
      progress,
      elapsed_seconds: elapsedSec,
      eta_seconds: etaSec,
      depth_level: depthLevel,
    });
  };
  const emitTool = (tool, toolState, hits, detail) => {
    const status = { tool, state: toolState, hits, detail };
    upsertToolRun(snap, status);
    snap.stats = computeStats(snap.nodes, snap.findings, snap.tool_runs);
    broadcastEvent({ kind: "tool_status", case_id: caseId, ...status });
  };
  const addNode = (node) => {
    const merged = upsertNode(snap, node);
    snap.stats = computeStats(snap.nodes, snap.findings, snap.tool_runs);
    broadcastEvent({ kind: "node", case_id: caseId, node: merged });
    return merged;
  };
  const addEdge = (source, target, relation, confidence, tool) => {
    if (!source || !target || source === target) return;
    const edge = upsertEdge(snap, {
      id: `${source}__${relation}__${target}`,
      source,
      target,
      relation,
      confidence,
      sources: [tool],
    });
    broadcastEvent({ kind: "edge", case_id: caseId, edge });
  };
  const addFinding = (finding) => {
    const merged = upsertFinding(snap, finding);
    snap.stats = computeStats(snap.nodes, snap.findings, snap.tool_runs);
    broadcastEvent({ kind: "finding", case_id: caseId, finding: merged });
  };

  const now = new Date().toISOString();
  const fullName = input.full_name.trim();
  const seedId = normalizeNodeId("person", fullName);

  // -------------------------------------------------------------------------
  // Network Anonymity Setup & Fail-Closed Guard
  // -------------------------------------------------------------------------
  const tor = await detectLocalTor(auth.tor_socks_url);
  const customProxy = auth.proxy_url?.trim() ? ensureSocks5h(auth.proxy_url) : null;
  let proxyHost = null;
  let proxyPort = null;
  let torEndpoint = null;

  if (tor.available && (input.enable_tor || input.strict_anonymity !== false)) {
    proxyHost = tor.host;
    proxyPort = tor.port;
    torEndpoint = tor.endpoint;
  } else if (customProxy) {
    try {
      const pu = new URL(customProxy);
      proxyHost = pu.hostname;
      proxyPort = Number(pu.port) || 1080;
      torEndpoint = customProxy;
    } catch {
      // invalid proxy
    }
  }

  const strictAnonymity =
    typeof input.strict_anonymity === "boolean" ? input.strict_anonymity : Boolean(tor.available);

  const netCtx = {
    strictAnonymity,
    proxyHost,
    proxyPort,
    torEndpoint,
    anonymityMode: tor.available && proxyHost ? "tor_socks5h" : proxyHost ? "custom_proxy" : "direct",
  };

  emitStage(
    "stage0",
    proxyHost
      ? `Registering identity seed · routing all traffic via ${torEndpoint} (zero local DNS leak)`
      : strictAnonymity
      ? "Strict Anonymity enabled — verifying local Tor SOCKS5h circuit"
      : "Registering identity seed & generating handle/email permutations (Direct mode)",
    6
  );

  addNode({
    id: seedId,
    kind: "person",
    label: fullName,
    sublabel: input.org?.trim() || (proxyHost ? "Tor Anonymized Trace" : "Identity Seed"),
    layer: "seed",
    confidence: 1.0,
    status: "confirmed",
    sources: ["seed"],
    metadata: {
      mode: input.passive_only ? "passive_only" : "full_deep",
      anonymity: netCtx.anonymityMode,
      match_tier: "verified",
      match_reason: "Operator identity seed",
    },
    url: null,
    depth: 0,
  });

  // FAIL-CLOSED GUARD: If user requires strict_anonymity and Tor/proxy is offline, refuse clearnet leaks!
  if (strictAnonymity && !proxyHost) {
    emitTool(
      "tor-socks5h",
      "error",
      0,
      "Fail-closed: Strict Anonymity is ON but local Tor SOCKS5h is offline — refused clearnet egress to protect your IP"
    );
    const localCorpusDir = auth.local_corpus_dir?.trim() || DEFAULT_CORPUS_DIR;
    const { filesScanned, hits } = scanLocalCorpus(localCorpusDir, [fullName, ...(input.email ? [input.email] : [])]);
    emitTool(
      "local-corpus",
      "done",
      hits.length,
      `Offline scan only (${filesScanned} file(s), ${hits.length} hit(s))`
    );
    snap.stats = computeStats(snap.nodes, snap.findings, snap.tool_runs);
    persistCases();
    emitStage(
      "completed",
      "Strict Anonymity blocked direct clearnet egress (Tor offline). Start Tor or turn off Strict Anonymity.",
      100
    );
    broadcastEvent({ kind: "completed", case_id: caseId, summary: snap.stats });
    state.activeInvestigations = Math.max(0, state.activeInvestigations - 1);
    scheduleIdleShutdownIfNeeded();
    return;
  }

  const knownEmails = [];
  const knownHandles = [];
  const knownDomains = [];
  const knownOrgs = [];
  const knownPhones = [];
  const seenEmails = new Set();
  const seenHandles = new Set();
  const seenDomains = new Set();
  const seenOrgs = new Set();
  const seenPhones = new Set();
  const seedHandleNorm = input.handle?.trim().replace(/^@/, "").toLowerCase() || null;

  const trackPhone = (ph) => {
    const c = String(ph || "").trim();
    const digits = c.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15 && !seenPhones.has(digits)) {
      seenPhones.add(digits);
      knownPhones.push(c);
      return true;
    }
    return false;
  };

  const trackEmail = (em) => {
    const c = String(em || "").trim().toLowerCase();
    if (c && !isNoiseEmail(c) && !seenEmails.has(c)) {
      seenEmails.add(c);
      knownEmails.push(c);
      const dom = c.split("@")[1];
      if (dom && !FREE_MAIL_DOMAINS.has(dom) && !seenDomains.has(dom)) {
        seenDomains.add(dom);
        knownDomains.push(dom);
      }
      return true;
    }
    return false;
  };
  const trackHandle = (h) => {
    const c = String(h || "").trim().replace(/^@/, "").toLowerCase();
    if (c.length >= 2 && !seenHandles.has(c)) {
      seenHandles.add(c);
      knownHandles.push(c);
      return true;
    }
    return false;
  };
  const trackOrg = (o) => {
    const c = String(o || "").trim();
    if (c.length >= 2 && !seenOrgs.has(c.toLowerCase())) {
      seenOrgs.add(c.toLowerCase());
      knownOrgs.push(c);
    }
  };

  const pdfParentMap = new Map(); // pdfUrl -> { parentId, relation }
  const pageParentMap = new Map(); // pageUrl -> parentNodeId
  const domainParentMap = new Map(); // domain -> { parentId, relation }
  const hasParentEdge = (nodeId) => snap.edges.some((e) => e.target === nodeId);
  const findNodeDepth = (nodeId) => snap.nodes.find((n) => n.id === nodeId)?.depth ?? 1;
  const findHandleHubOrAccount = (h) => {
    const clean = String(h || "").replace(/^@+/, "").toLowerCase();
    const hub = snap.nodes.find((n) => n.id === normalizeNodeId("handle", clean));
    if (hub) return hub.id;
    const acc = snap.nodes.find(
      (n) => n.kind === "account" && String(n.metadata?.handle || "").toLowerCase() === clean
    );
    return acc ? acc.id : null;
  };
  const findAnchorForTerm = (term) => {
    const t = String(term || "").trim().toLowerCase();
    if (!t) return seedId;
    if (t.includes("@")) {
      const emId = normalizeNodeId("email", t);
      if (snap.nodes.some((n) => n.id === emId)) return emId;
    }
    const digits = t.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 16) {
      const phNode = snap.nodes.find(
        (n) => n.kind === "phone" && n.label.replace(/\D/g, "") === digits
      );
      if (phNode) return phNode.id;
    }
    const hNodeId = findHandleHubOrAccount(t);
    if (hNodeId) return hNodeId;
    const domId = normalizeNodeId("domain", t);
    if (snap.nodes.some((n) => n.id === domId)) return domId;
    return seedId;
  };

  if (input.org?.trim()) {
    trackOrg(input.org.trim());
    const orgId = normalizeNodeId("org", input.org);
    addNode({
      id: orgId,
      kind: "org",
      label: input.org.trim(),
      sublabel: "Provided Organization",
      layer: "anchor",
      confidence: 0.95,
      status: "confirmed",
      sources: ["seed"],
      metadata: { match_tier: "verified", match_reason: "Provided organization context" },
      url: null,
      depth: 1,
    });
    addEdge(seedId, orgId, "affiliated_with", 0.95, "seed");
  }

  if (input.email?.trim() && input.email.includes("@")) {
    const em = input.email.trim().toLowerCase();
    trackEmail(em);
    const emId = normalizeNodeId("email", em);
    addNode({
      id: emId,
      kind: "email",
      label: em,
      sublabel: "Provided Email",
      layer: "anchor",
      confidence: 0.98,
      status: "confirmed",
      sources: ["seed"],
      metadata: { match_tier: "verified", match_reason: "Provided email anchor" },
      url: null,
      depth: 1,
    });
    addEdge(seedId, emId, "owns_email", 0.98, "seed");
  }

  if (input.phone?.trim()) {
    const ph = input.phone.trim();
    trackPhone(ph);
    const phId = normalizeNodeId("phone", ph);
    addNode({
      id: phId,
      kind: "phone",
      label: ph,
      sublabel: "Provided Phone",
      layer: "anchor",
      confidence: 0.95,
      status: "confirmed",
      sources: ["seed"],
      metadata: { match_tier: "verified", match_reason: "Provided phone anchor" },
      url: null,
      depth: 1,
    });
    addEdge(seedId, phId, "owns_phone", 0.95, "seed");
  }

  const seedDom = normalizeDomain(input.domain, input.org);
  if (seedDom && !seenDomains.has(seedDom)) {
    seenDomains.add(seedDom);
    knownDomains.push(seedDom);
    const domId = normalizeNodeId("domain", seedDom);
    addNode({
      id: domId,
      kind: "domain",
      label: seedDom,
      sublabel: "Target Domain",
      layer: "anchor",
      confidence: 0.92,
      status: "confirmed",
      sources: ["seed"],
      metadata: { match_tier: "verified", match_reason: "Provided domain context" },
      url: `https://${seedDom}`,
      depth: 1,
    });
    addEdge(seedId, domId, "domain_context", 0.92, "seed");
  }

  // Stage 0A: Permutator
  emitTool("permutator", "running", 0, "Generating ranked handle & corporate email patterns");
  const handleCands = generateHandles(fullName, input.handle);
  for (const c of handleCands) {
    trackHandle(c.handle);
    if (c.pattern === "seed_handle") {
      const hId = normalizeNodeId("handle", c.handle);
      addNode({
        id: hId,
        kind: "handle",
        label: `@${c.handle}`,
        sublabel: "Provided Handle",
        layer: "anchor",
        confidence: 0.95,
        status: "confirmed",
        sources: ["seed"],
        metadata: { match_tier: "verified", match_reason: "Provided handle anchor" },
        url: null,
        depth: 1,
      });
      addEdge(seedId, hId, "uses_handle", 0.95, "seed");
    }
  }
  const permutedEmails = [];
  for (const dom of knownDomains) {
    permutedEmails.push(...generateCorporateEmails(fullName, dom, input.email));
  }
  emitTool(
    "permutator",
    "done",
    handleCands.length + permutedEmails.length,
    `${handleCands.length} handles, ${permutedEmails.length} email patterns`
  );

  // -------------------------------------------------------------------------
  // Stage 0A: General-Purpose Name-Root Web, Social & Public Records Discovery
  // -------------------------------------------------------------------------
  emitStage("web_social", "Searching public social profiles, media, legal & academic records", 14);
  emitTool("web-social", "running", 0, "YouTube, Wikipedia & multi-engine social/web cascade");
  emitTool("public-records", "running", 0, "Global corporate filings, legal/court & academic records");

  const webDiscoveredPdfs = [];
  const pdfMetaMap = new Map(); // pdfUrl -> { title, snippet, parentRecordId, verifiedFromSearch }
  const webDiscoveredSites = [];
  const verifiedHandlesPriority = [];

  const [socialWebRes, pubRecordsRes] = await Promise.all([
    discoverSocialAndWeb(fullName, netCtx, depthLevel, knownHandles),
    depthLevel >= 2
      ? discoverPublicRecords(fullName, netCtx, depthLevel)
      : Promise.resolve({ records: [], pdfLinks: [] }),
  ]);

  let webSocialHits = 0;
  const confirmedProfileUrls = [];
  for (const acc of socialWebRes.accounts) {
    const acctId = normalizeAccountNodeId(acc.platform, acc.handle);
    addNode({
      id: acctId,
      kind: "account",
      label: `${acc.platform} (@${acc.handle})`,
      sublabel: acc.title || acc.platform,
      layer: "anchor",
      confidence: acc.confidence,
      status: "unverified",
      sources: ["web-social"],
      metadata: {
        platform: acc.platform,
        handle: acc.handle,
        display_name: acc.title,
        bio: acc.bio,
        match_tier: acc.match_tier,
        match_reason: acc.match_reason,
      },
      url: acc.url,
      depth: 1,
    });
    if (!hasParentEdge(acctId)) {
      addEdge(seedId, acctId, "social_profile", acc.confidence, "web-social");
    }
    const trail = [`Name: ${fullName}`, `${acc.platform} -> @${acc.handle}`];
    addFinding({
      id: `finding:websocial:${normalizePlatformSlug(acc.platform)}:${acc.handle.toLowerCase()}`,
      node_id: acctId,
      title: `${acc.platform} (@${acc.handle})`,
      category: "account",
      severity: "low",
      confidence: acc.confidence,
      consensus_count: 1,
      sources: ["web-social"],
      summary: `${acc.match_reason}${acc.bio ? ` · ${acc.bio.slice(0, 140)}` : ""}`,
      pivot_trail: trail,
      url: acc.url,
      timestamp: now,
      sensitive_fields: [acc.handle],
    });
    const isYtAcc = (acc.platform || "").toLowerCase() === "youtube";
    const isLiSlug = (acc.platform || "").toLowerCase() === "linkedin";
    if (!acc.skipHandleTrack) trackHandle(acc.handle);
    if (acc.match_tier !== "collision") {
      const hl = acc.handle.toLowerCase();
      const isRandomSlug = /\d{3,}$|-[a-z0-9]{2,4}$|-[0-9a-f]{6,}$/i.test(hl) || (isLiSlug && /-[a-z0-9]{5,}$/i.test(hl));
      const cleanNonYt = !isYtAcc && !isRandomSlug && sharesNameToken(hl, fullName);
      if (cleanNonYt && hl.length >= 3 && hl.length <= 28 && !verifiedHandlesPriority.includes(hl)) {
        verifiedHandlesPriority.push(hl);
      }
      const ytCountInConfirmed = confirmedProfileUrls.filter(([, u]) => /youtube\.com/i.test(u)).length;
      if (
        acc.url &&
        !isAuthWalledUrl(acc.url) &&
        confirmedProfileUrls.length < 10 &&
        (!isYtAcc || ytCountInConfirmed < 1)
      ) {
        confirmedProfileUrls.push([acctId, acc.url, trail]);
        pageParentMap.set(acc.url, acctId);
      }
    }
    webSocialHits++;
  }
  for (const h of socialWebRes.handles) trackHandle(h);
  for (const em of socialWebRes.emails) {
    if (trackEmail(em)) {
      const emId = normalizeNodeId("email", em);
      addNode({
        id: emId,
        kind: "email",
        label: em,
        sublabel: "Public Web Discovery",
        layer: "anchor",
        confidence: 0.84,
        status: "unverified",
        sources: ["web-social"],
        metadata: { match_tier: "verified", match_reason: "Public email linked to full name" },
        url: null,
        depth: 1,
      });
      if (!hasParentEdge(emId)) {
        addEdge(seedId, emId, "owns_email", 0.84, "web-social");
      }
      webSocialHits++;
    }
  }
  for (const ph of socialWebRes.phones) {
    if (trackPhone(ph)) {
      const phId = normalizeNodeId("phone", ph);
      addNode({
        id: phId,
        kind: "phone",
        label: ph,
        sublabel: "Public Listed Phone",
        layer: "anchor",
        confidence: 0.82,
        status: "unverified",
        sources: ["web-social"],
        metadata: { match_tier: "verified", match_reason: "Public phone linked to full name" },
        url: null,
        depth: 1,
      });
      if (!hasParentEdge(phId)) {
        addEdge(seedId, phId, "owns_phone", 0.82, "web-social");
      }
      addFinding({
        id: `finding:phone:${phId}`,
        node_id: phId,
        title: `Public Phone Number: ${ph}`,
        category: "anchor",
        severity: "medium",
        confidence: 0.82,
        consensus_count: 1,
        sources: ["web-social"],
        summary: `Publicly listed phone number ${ph} found associated with ${fullName}.`,
        pivot_trail: [`Name: ${fullName}`, `Phone -> ${ph}`],
        url: null,
        timestamp: now,
        sensitive_fields: [ph],
      });
      webSocialHits++;
    }
  }
  for (const rec of socialWebRes.records) {
    const recId = normalizeNodeId("record", rec.url);
    const recType =
      rec.record_type ||
      inferRecordType(rec.url, rec.title, rec.snippet, rec.source === "YouTube Media" ? "Media / Talk" : "Public Web Record");
    addNode({
      id: recId,
      kind: "record",
      label: rec.title.slice(0, 68),
      sublabel: rec.source,
      layer: "anchor",
      confidence: 0.82,
      status: "unverified",
      sources: ["web-social"],
      metadata: {
        source: rec.source,
        record_type: recType,
        bio: rec.snippet,
        match_tier: "verified",
        match_reason: `${rec.source} match for full name`,
      },
      url: rec.url,
      depth: 1,
    });
    if (!hasParentEdge(recId)) {
      addEdge(seedId, recId, "public_record", 0.82, "web-social");
    }
    addFinding({
      id: `finding:rec:${recId}`,
      node_id: recId,
      title: rec.title,
      category: "corporate",
      severity: "low",
      confidence: 0.82,
      consensus_count: 1,
      sources: ["web-social"],
      summary: `${rec.source}: ${rec.snippet}`,
      pivot_trail: [`Name: ${fullName}`, `${rec.source} -> ${rec.title.slice(0, 48)}`],
      url: rec.url,
      timestamp: now,
      sensitive_fields: [],
    });
    webSocialHits++;
  }
  for (const wObj of socialWebRes.websites) {
    const u = typeof wObj === "string" ? wObj : wObj.url;
    const srcUrl = typeof wObj === "string" ? null : wObj.sourceUrl;
    const wTitle = typeof wObj === "string" ? null : wObj.title;
    const wSnippet = typeof wObj === "string" ? null : wObj.snippet;
    if (!u) continue;
    if (!webDiscoveredSites.includes(u)) webDiscoveredSites.push(u);
    try {
      const dom = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
      let parentId = srcUrl ? normalizeNodeId("record", srcUrl) : normalizeNodeId("record", u);
      if (!srcUrl && !snap.nodes.some((n) => n.id === parentId)) {
        addNode({
          id: parentId,
          kind: "record",
          label: (wTitle || dom).slice(0, 68),
          sublabel: dom,
          layer: "anchor",
          confidence: 0.82,
          status: "unverified",
          sources: ["web-social"],
          metadata: {
            source: dom,
            record_type: "Personal / Company Website",
            bio: wSnippet || `Personal or company website linked to ${fullName}`,
            match_tier: "verified",
            match_reason: `${dom} website matched full name`,
          },
          url: u,
          depth: 1,
        });
        if (!hasParentEdge(parentId)) {
          addEdge(seedId, parentId, "public_record", 0.82, "web-social");
        }
      }
      pageParentMap.set(u, parentId);
      if (dom && !PLATFORM_NOISE_DOMAINS.some((d) => dom === d || dom.endsWith(`.${d}`))) {
        if (!domainParentMap.has(dom)) {
          domainParentMap.set(dom, { parentId, relation: "links_to" });
        }
        if (!seenDomains.has(dom)) {
          seenDomains.add(dom);
          knownDomains.push(dom);
        }
      }
    } catch {
      // ignore invalid URL
    }
  }
  for (const pObj of socialWebRes.pdfs) {
    const pUrl = typeof pObj === "string" ? pObj : pObj.url;
    const srcUrl = typeof pObj === "string" ? null : pObj.sourceUrl;
    if (pUrl && !webDiscoveredPdfs.includes(pUrl)) webDiscoveredPdfs.push(pUrl);
    if (pUrl) {
      const parentRecId = srcUrl ? normalizeNodeId("record", srcUrl) : null;
      if (parentRecId) {
        pdfParentMap.set(pUrl, { parentId: parentRecId, relation: "linked_pdf" });
      }
      if (!pdfMetaMap.has(pUrl)) {
        pdfMetaMap.set(pUrl, {
          title: typeof pObj === "string" ? null : pObj.title || null,
          snippet: typeof pObj === "string" ? null : pObj.snippet || null,
          parentRecordId: parentRecId,
          verifiedFromSearch: true,
        });
      }
    }
  }
  for (const pLink of pubRecordsRes.pdfLinks || []) {
    if (pLink.url && !webDiscoveredPdfs.includes(pLink.url)) webDiscoveredPdfs.push(pLink.url);
    if (pLink.url) {
      const parentRecId = pLink.parentRecordUrl ? normalizeNodeId("record", pLink.parentRecordUrl) : null;
      if (parentRecId) {
        pdfParentMap.set(pLink.url, { parentId: parentRecId, relation: "has_pdf" });
      }
      if (!pdfMetaMap.has(pLink.url)) {
        pdfMetaMap.set(pLink.url, {
          title: pLink.title || null,
          snippet: pLink.snippet || null,
          parentRecordId: parentRecId,
          verifiedFromSearch: true,
        });
      }
    }
  }

  // Promote seedHandle + verified web-social handles ahead of permutations while keeping top permutations intact
  if (verifiedHandlesPriority.length || seedHandleNorm) {
    const lead = Array.from(new Set([...(seedHandleNorm ? [seedHandleNorm] : []), ...verifiedHandlesPriority]));
    const reordered = [...lead, ...knownHandles.filter((x) => !lead.includes(x))];
    knownHandles.splice(0, knownHandles.length, ...reordered);
  }

  const noticeSuffix =
    socialWebRes.engineNotices?.length > 0
      ? ` · declined/challenged: ${socialWebRes.engineNotices.slice(0, 4).join(", ")}`
      : "";
  emitTool("web-social", "done", webSocialHits, `${webSocialHits} social/web hit(s)${noticeSuffix}`);

  let pubRecHits = 0;
  for (const rec of pubRecordsRes.records) {
    const recId = normalizeNodeId("record", rec.url);
    const recType = rec.record_type || inferRecordType(rec.url, rec.title, rec.snippet, "Public Web Record");
    addNode({
      id: recId,
      kind: "record",
      label: rec.title.slice(0, 68),
      sublabel: rec.source,
      layer: "anchor",
      confidence: 0.84,
      status: "unverified",
      sources: ["public-records"],
      metadata: {
        source: rec.source,
        record_type: recType,
        bio: rec.snippet,
        match_tier: "verified",
        match_reason: `${rec.source} public record`,
      },
      url: rec.url,
      depth: 1,
    });
    if (!hasParentEdge(recId)) {
      addEdge(seedId, recId, "public_record", 0.84, "public-records");
    }
    addFinding({
      id: `finding:pubrec:${recId}`,
      node_id: recId,
      title: `${rec.source}: ${rec.title}`,
      category: "corporate",
      severity: recType === "Legal / Court Record" ? "medium" : "low",
      confidence: 0.84,
      consensus_count: 1,
      sources: ["public-records"],
      summary: rec.snippet,
      pivot_trail: [`Name: ${fullName}`, `${rec.source} -> ${rec.title.slice(0, 48)}`],
      url: rec.url,
      timestamp: now,
      sensitive_fields: [],
    });
    pubRecHits++;
  }
  emitTool(
    "public-records",
    depthLevel >= 2 ? "done" : "skipped",
    pubRecHits,
    depthLevel >= 2 ? `${pubRecHits} corporate/legal/academic record(s), ${(pubRecordsRes.pdfLinks || []).length} PDF(s)` : "Quick depth (L1)"
  );

  // -------------------------------------------------------------------------
  // Stage 0B: Direct OpenPGP HKP Keyserver Lookup
  // -------------------------------------------------------------------------
  emitStage("hkp", "Querying federated OpenPGP HKP keyserver directly", 16);
  emitTool("openpgp-hkp", "running", 0, "Direct HKP index lookup on Ubuntu keyserver");
  let hkpHits = 0;
  const seenKeys = new Set();
  for (const q of [fullName, ...knownEmails].slice(0, 3)) {
    try {
      const recs = await lookupHkp(q, netCtx);
      for (const rec of recs) {
        if (!rec.key_id || seenKeys.has(rec.key_id)) continue;
        seenKeys.add(rec.key_id);
        const shortKey = rec.key_id.slice(-16);
        const pgpId = normalizeNodeId("pgp_key", rec.key_id);
        const keyUrl = `https://keyserver.ubuntu.com/pks/lookup?search=0x${rec.key_id}&fingerprint=on&op=index`;
        const exactName = rec.uids.some((u) => hasFullNameMatch(u.raw_uid, fullName));
        const keyConf = exactName ? 0.88 : 0.72;

        // Branch from matching existing email anchor if available, else seedId
        const existingEmailParent =
          (q.includes("@") && snap.nodes.some((n) => n.id === normalizeNodeId("email", q))
            ? normalizeNodeId("email", q)
            : null) ||
          rec.uids
            .map((u) => (u.email ? normalizeNodeId("email", u.email) : null))
            .find((id) => id && snap.nodes.some((n) => n.id === id)) ||
          null;
        const pgpParentId = existingEmailParent || seedId;
        const pgpRel = existingEmailParent ? "has_pgp_key" : "pgp_key_match";
        const pgpDepth = existingEmailParent ? findNodeDepth(existingEmailParent) + 1 : 1;

        addNode({
          id: pgpId,
          kind: "pgp_key",
          label: `PGP 0x${shortKey}`,
          sublabel: rec.uids[0]?.display_name || "OpenPGP Key",
          layer: "anchor",
          confidence: keyConf,
          status: "unverified",
          sources: ["openpgp-hkp"],
          metadata: {
            fingerprint: rec.key_id,
            key_length: rec.key_len,
            match_tier: exactName ? "verified" : "probable",
            match_reason: "OpenPGP HKP key UID",
          },
          url: keyUrl,
          depth: pgpDepth,
        });
        addEdge(pgpParentId, pgpId, pgpRel, keyConf, "openpgp-hkp");
        hkpHits++;

        for (const uid of rec.uids) {
          if (!uid.email || isNoiseEmail(uid.email)) continue;
          const emId = normalizeNodeId("email", uid.email);
          if (emId === existingEmailParent) continue;
          addNode({
            id: emId,
            kind: "email",
            label: uid.email,
            sublabel: "OpenPGP Key UID",
            layer: "anchor",
            confidence: 0.88,
            status: "unverified",
            sources: ["openpgp-hkp"],
            metadata: {
              pgp_uid: uid.raw_uid,
              pgp_key: shortKey,
              match_tier: "verified",
              match_reason: "OpenPGP cryptographic UID",
            },
            url: null,
            depth: pgpDepth + 1,
          });
          addEdge(pgpId, emId, "pgp_uid_email", 0.9, "openpgp-hkp");
          addFinding({
            id: `finding:hkp:${shortKey}:${uid.email}`,
            node_id: emId,
            title: `OpenPGP Key UID exposes ${uid.email}`,
            category: "anchor",
            severity: "medium",
            confidence: 0.88,
            consensus_count: 1,
            sources: ["openpgp-hkp"],
            summary: `Federated HKP keyserver returned key 0x${shortKey} binding UID '${uid.raw_uid}'.`,
            pivot_trail: [`Name: ${fullName}`, `OpenPGP HKP -> 0x${shortKey}`, `UID -> ${uid.email}`],
            url: keyUrl,
            timestamp: now,
            sensitive_fields: [uid.email, rec.key_id],
          });
          trackEmail(uid.email);
          const localPart = uid.email.split("@")[0];
          if (localPart && localPart.length >= 3) trackHandle(localPart);
        }
      }
    } catch {
      // ignore timeout
    }
  }
  emitTool("openpgp-hkp", "done", hkpHits, `${hkpHits} PGP key record(s)`);

  // -------------------------------------------------------------------------
  // Stage 1: Deep Raw GitHub & GitLab Harvester (.keys + .gpg + .atom + .patch!)
  // -------------------------------------------------------------------------
  emitStage("git_raw", "Harvesting raw GitHub/GitLab HTML, .keys, .gpg & commit .patch emails", 30);
  emitTool("git-raw", "running", 0, "Deep raw HTML + .keys + .gpg + commit .patch (zero API)");
  let gitHits = 0;
  const personalWebsites = [...webDiscoveredSites];
  const githubRepoPages = [];
  const accountArtifacts = []; // For multi-signal avatar + reciprocal link corroboration!

  const authorConflictsFirstName = (authorStr) => {
    const tParts = getNameParts(fullName);
    if (tParts.length < 2) return false;
    const tFirst = tParts[0];
    const tLast = tParts[tParts.length - 1];
    const aParts = String(authorStr || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (aParts.length >= 2) {
      const aFirst = aParts[0];
      if (aFirst.length >= 2 && aFirst !== tFirst && !tFirst.startsWith(aFirst) && !aFirst.startsWith(tFirst)) {
        return true;
      }
    } else if (aParts.length === 1 && aParts[0].endsWith(tLast) && aParts[0].length > tLast.length + 1) {
      const p = aParts[0].slice(0, -tLast.length);
      if (p.length >= 2 && p !== tFirst && !tFirst.startsWith(p)) return true;
    }
    return false;
  };

  const confirmedHandlesPriority = [];
  const githubProbeHandles = knownHandles.slice(0, 6);
  const githubProfiles = await Promise.all(
    githubProbeHandles.map((h) => probeGithubRawDeep(h, netCtx))
  );

  for (let gi = 0; gi < githubProbeHandles.length; gi++) {
    const h = githubProbeHandles[gi];
    const isSeed = seedHandleNorm === h;
    const prof = githubProfiles[gi];
    if (prof.exists) {
      const ghId = normalizeAccountNodeId("GitHub", h);
      const hHubId = normalizeNodeId("handle", h);
      const hasHub = snap.nodes.some((n) => n.id === hHubId);
      const fullMatch = hasFullNameMatch(`${prof.display_name || ""} ${prof.bio || ""}`, fullName);
      const matchingPatchEmails = prof.patch_emails.filter(
        (pe) =>
          hasFullNameMatch(pe.author_name, fullName) ||
          ((fullMatch || isSeed) &&
            !authorConflictsFirstName(pe.author_name) &&
            !authorConflictsFirstName(String(pe.email || "").split("@")[0]))
      );
      const matchingGpgEmails = prof.gpg_emails.filter(
        (em) =>
          hasFullNameMatch(em, fullName) ||
          ((fullMatch || isSeed) && !authorConflictsFirstName(String(em || "").split("@")[0]))
      );
      const hasCrypto = matchingGpgEmails.length > 0 || matchingPatchEmails.length > 0;
      const matchTier = hasCrypto
        ? "verified"
        : fullMatch || isSeed
        ? "probable"
        : "collision";
      const matchReason = hasCrypto
        ? "Git .patch/.gpg cryptographic proof"
        : fullMatch
        ? "Full name confirmed in GitHub bio"
        : isSeed
        ? "Exact provided handle match"
        : "Handle match only — collision risk";
      const conf = hasCrypto ? 0.92 : fullMatch ? 0.78 : isSeed ? 0.72 : 0.38;

      if (matchTier !== "collision" && !confirmedHandlesPriority.includes(h)) {
        confirmedHandlesPriority.push(h);
      }
      if (prof.org && matchTier !== "collision") trackOrg(prof.org);

      const tzStr = prof.timezones.length
        ? `${prof.timezones.map((t) => `${t.offset} (${t.region})`).join(", ")}${
            prof.commit_hours.length ? ` · active ${prof.commit_hours.slice(0, 3).join(", ")}` : ""
          }`
        : null;

      const ghDepth = hasHub ? findNodeDepth(hHubId) + 1 : 1;
      addNode({
        id: ghId,
        kind: "account",
        label: `GitHub (@${h})`,
        sublabel: prof.display_name || "GitHub Profile",
        layer: matchTier === "verified" ? "anchor" : "surface",
        confidence: conf,
        status: "unverified",
        sources: ["git-raw"],
        metadata: {
          platform: "GitHub",
          handle: h,
          match_tier: matchTier,
          match_reason: matchReason,
          ...(prof.display_name ? { display_name: prof.display_name } : {}),
          ...(prof.bio ? { bio: prof.bio } : {}),
          ...(prof.org ? { org: prof.org } : {}),
          ...(prof.location ? { location: prof.location } : {}),
          ...(prof.website ? { website: prof.website } : {}),
          ...(prof.skills.length ? { skills: prof.skills.slice(0, 6).join(", ") } : {}),
          ...(prof.followers ? { followers: prof.followers } : {}),
          ...(prof.ssh_keys.length ? { ssh_key_count: String(prof.ssh_keys.length) } : {}),
          ...(tzStr ? { timezone: tzStr } : {}),
        },
        url: prof.profile_url,
        depth: ghDepth,
      });
      if (!hasParentEdge(ghId)) {
        addEdge(hasHub ? hHubId : seedId, ghId, hasHub ? "account_on" : "github_profile", conf, "git-raw");
      }
      gitHits++;
      pageParentMap.set(prof.profile_url, ghId);

      const baseTrail = [`Name: ${fullName}`, `GitHub Raw -> @${h}`];
      if (matchTier !== "collision") {
        confirmedProfileUrls.push([ghId, prof.profile_url, baseTrail]);
      }
      accountArtifacts.push({
        nodeId: ghId,
        url: prof.profile_url,
        site: "GitHub",
        avatarUrl: prof.avatar_url,
        outboundUrls: matchTier !== "collision" ? prof.external_links : [],
      });

      const ghBioSummary = [
        prof.bio && `Bio: ${prof.bio}`,
        prof.org && `Org: ${prof.org}`,
        prof.location && `Location: ${prof.location}`,
        prof.skills.length && `Stack: ${prof.skills.slice(0, 5).join(", ")}`,
        prof.website && `Site: ${prof.website}`,
      ]
        .filter(Boolean)
        .join(" · ");
      if (ghBioSummary && matchTier !== "collision") {
        addFinding({
          id: `finding:git-profile:${h}`,
          node_id: ghId,
          title: `GitHub Profile Intel: @${h}${prof.display_name ? ` (${prof.display_name})` : ""}`,
          category: "code",
          severity: "low",
          confidence: conf,
          consensus_count: 1,
          sources: ["git-raw"],
          summary: ghBioSummary,
          pivot_trail: baseTrail,
          url: prof.profile_url,
          timestamp: now,
          sensitive_fields: [h],
        });
      }

      if (matchTier !== "collision") {
        for (const rUrl of prof.repo_urls) {
          if (!githubRepoPages.includes(rUrl)) githubRepoPages.push(rUrl);
          pageParentMap.set(rUrl, ghId);
        }
      }

      if (prof.ssh_keys.length && matchTier !== "collision") {
        for (const k of prof.ssh_keys.slice(0, 4)) {
          const sshId = normalizeNodeId("ssh_key", k.fingerprint);
          addNode({
            id: sshId,
            kind: "ssh_key",
            label: `SSH ${k.algo} (${k.short_fp})`,
            sublabel: `GitHub @${h} .keys`,
            layer: "deep",
            confidence: conf,
            status: "unverified",
            sources: ["git-raw"],
            metadata: {
              fingerprint: k.fingerprint,
              algorithm: k.algo,
              owner: `@${h}`,
              match_tier: matchTier,
              match_reason: `Public SSH key on github.com/${h}.keys`,
            },
            url: `https://github.com/${h}.keys`,
            depth: ghDepth + 1,
          });
          addEdge(ghId, sshId, "exposes_ssh_key", conf, "git-raw");
        }
        addFinding({
          id: `finding:git-ssh:${h}`,
          node_id: ghId,
          title: `${prof.ssh_keys.length} Public SSH Key(s) Exposed on github.com/${h}.keys`,
          category: "code",
          severity: "low",
          confidence: conf,
          consensus_count: 1,
          sources: ["git-raw"],
          summary: `Direct fetch of /${h}.keys returned: ${prof.ssh_keys.map((k) => k.display).join("; ")}`,
          pivot_trail: baseTrail,
          url: `https://github.com/${h}.keys`,
          timestamp: now,
          sensitive_fields: [h],
        });
      }

      // Raw .gpg Packet Tag 6 & 13 -> pgp_key -> email
      if ((matchingGpgEmails.length || prof.gpg_key_id) && matchTier !== "collision") {
        const keyToken = prof.gpg_key_id || `github_${h}`;
        const shortK = keyToken.slice(-16);
        const pgpId = normalizeNodeId("pgp_key", keyToken);
        addNode({
          id: pgpId,
          kind: "pgp_key",
          label: `PGP 0x${shortK}`,
          sublabel: `GitHub @${h} .gpg`,
          layer: "deep",
          confidence: 0.93,
          status: "unverified",
          sources: ["git-raw-gpg"],
          metadata: {
            fingerprint: keyToken,
            uid: `@${h}`,
            match_tier: "verified",
            match_reason: `GitHub .gpg public key (${h}.gpg)`,
          },
          url: `https://github.com/${h}.gpg`,
          depth: ghDepth + 1,
        });
        addEdge(ghId, pgpId, "has_pgp_key", 0.93, "git-raw-gpg");

        for (const gpgEm of matchingGpgEmails) {
          const emId = normalizeNodeId("email", gpgEm);
          addNode({
            id: emId,
            kind: "email",
            label: gpgEm,
            sublabel: "Extracted from GitHub .gpg",
            layer: "anchor",
            confidence: 0.93,
            status: "unverified",
            sources: ["git-raw-gpg"],
            metadata: { pgp_key: shortK, match_tier: "verified", match_reason: "Raw .gpg cryptographic UID" },
            url: `https://github.com/${h}.gpg`,
            depth: ghDepth + 2,
          });
          addEdge(pgpId, emId, "pgp_uid_email", 0.93, "git-raw-gpg");
          addFinding({
            id: `finding:git-gpg:${h}:${gpgEm}`,
            node_id: emId,
            title: `Raw GitHub .gpg Key Exposes Email ${gpgEm}`,
            category: "code",
            severity: "high",
            confidence: 0.93,
            consensus_count: 1,
            sources: ["git-raw-gpg"],
            summary: `RFC 4880 parser decoded OpenPGP User ID packets directly from github.com/${h}.gpg.`,
            pivot_trail: [...baseTrail, `Raw .gpg Packet 13 -> ${gpgEm}`],
            url: `https://github.com/${h}.gpg`,
            timestamp: now,
            sensitive_fields: [gpgEm],
          });
          trackEmail(gpgEm);
        }
      }

      // Deep Raw Commit `.patch` Emails + Timezone Pattern-of-Life (target-matched only)!
      for (const pe of matchingPatchEmails) {
        const authorMatchesName = hasFullNameMatch(pe.author_name, fullName);
        const emId = normalizeNodeId("email", pe.email);
        const pConf = authorMatchesName ? 0.95 : 0.88;
        addNode({
          id: emId,
          kind: "email",
          label: pe.email,
          sublabel: `Git .patch (${pe.repo})`,
          layer: "anchor",
          confidence: pConf,
          status: "unverified",
          sources: ["git-raw-patch"],
          metadata: {
            match_tier: "verified",
            match_reason: "Git .patch commit email",
            commit_author: pe.author_name,
            repo: pe.repo,
            ...(pe.tz_offset ? { timezone: `${pe.tz_offset} (${pe.tz_region})` } : {}),
          },
          url: pe.patch_url,
          depth: ghDepth + 1,
        });
        addEdge(ghId, emId, "commit_email", pConf, "git-raw-patch");
        addFinding({
          id: `finding:git-patch:${pe.email}`,
          node_id: emId,
          title: `Commit .patch Email Exposed: ${pe.email}`,
          category: "code",
          severity: "high",
          confidence: pConf,
          consensus_count: 1,
          sources: ["git-raw-patch"],
          summary: `Raw commit ${pe.sha} in ${h}/${pe.repo} authored by '${pe.author_name}' <${pe.email}>${
            pe.tz_region ? ` · Commit timezone ${pe.tz_offset} (${pe.tz_region})` : ""
          }.`,
          pivot_trail: [...baseTrail, `Repo ${pe.repo} (.patch)`, `Commit -> ${pe.email}`],
          url: pe.patch_url,
          timestamp: now,
          sensitive_fields: [pe.email, pe.author_name],
        });
        trackEmail(pe.email);
        gitHits++;
      }

      if (prof.timezones.length && matchTier !== "collision") {
        const tzSummary = prof.timezones.map((t) => `${t.offset} (${t.region})`).join(", ");
        addFinding({
          id: `finding:git-tz:${h}`,
          node_id: ghId,
          title: `Git Commit Timezone Pattern: ${tzSummary}`,
          category: "code",
          severity: "low",
          confidence: 0.84,
          consensus_count: 1,
          sources: ["git-raw-patch"],
          summary: `Direct .patch headers on @${h} repositories show consistent author UTC offset(s): ${tzSummary}.`,
          pivot_trail: [...baseTrail, `Commit Date Header -> ${tzSummary}`],
          url: prof.profile_url,
          timestamp: now,
          sensitive_fields: [],
        });
      }

      if (matchTier !== "collision") {
        for (const extUrl of prof.external_links.slice(0, 4)) {
          confirmedProfileUrls.push([ghId, extUrl, baseTrail]);
          if (!personalWebsites.includes(extUrl)) personalWebsites.push(extUrl);
          pageParentMap.set(extUrl, ghId);
          try {
            const dom = new URL(extUrl).hostname.replace(/^www\./, "").toLowerCase();
            if (dom && !PLATFORM_NOISE_DOMAINS.some((d) => dom === d || dom.endsWith(`.${d}`))) {
              if (!seenDomains.has(dom)) {
                seenDomains.add(dom);
                knownDomains.push(dom);
              }
              const domId = normalizeNodeId("domain", dom);
              addNode({
                id: domId,
                kind: "domain",
                label: dom,
                sublabel: "Linked Personal Website",
                layer: "deep",
                confidence: conf,
                status: "unverified",
                sources: ["git-raw"],
                metadata: { domain: dom, match_tier: matchTier, match_reason: `Linked from GitHub @${h}` },
                url: `https://${dom}`,
                depth: ghDepth + 1,
              });
              addEdge(ghId, domId, "links_to", conf, "git-raw");
              domainParentMap.set(dom, { parentId: ghId, relation: "links_to" });
              pageParentMap.set(extUrl, domId);
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // Raw GitLab check (top 2 handles)
    if (knownHandles.indexOf(h) < 2) {
      const gl = await probeGitlabRaw(h, netCtx);
      if (gl.exists) {
        const glId = normalizeAccountNodeId("GitLab", h);
        const hHubId = normalizeNodeId("handle", h);
        const hasHub = snap.nodes.some((n) => n.id === hHubId);
        const fullMatch = hasFullNameMatch(gl.display_name || "", fullName);
        const isGlSeed = seedHandleNorm === h;
        const matchingGlGpgEmails = gl.gpg_emails.filter(
          (em) =>
            hasFullNameMatch(em, fullName) ||
            ((fullMatch || isGlSeed) && !authorConflictsFirstName(String(em || "").split("@")[0]))
        );
        const tier = matchingGlGpgEmails.length ? "verified" : fullMatch || isGlSeed ? "probable" : "collision";
        const glConf = matchingGlGpgEmails.length ? 0.9 : fullMatch ? 0.74 : isGlSeed ? 0.7 : 0.38;
        const glDepth = hasHub ? findNodeDepth(hHubId) + 1 : 1;
        addNode({
          id: glId,
          kind: "account",
          label: `GitLab (@${h})`,
          sublabel: gl.display_name || "GitLab Raw Profile",
          layer: tier === "verified" ? "anchor" : "surface",
          confidence: glConf,
          status: "unverified",
          sources: ["gitlab-raw"],
          metadata: {
            platform: "GitLab",
            handle: h,
            match_tier: tier,
            match_reason: matchingGlGpgEmails.length
              ? "GitLab raw .gpg UID"
              : fullMatch
              ? "Full name confirmed on GitLab"
              : isGlSeed
              ? "Exact provided handle match"
              : "Handle match only — collision risk",
          },
          url: gl.profile_url,
          depth: glDepth,
        });
        if (!hasParentEdge(glId)) {
          addEdge(hasHub ? hHubId : seedId, glId, hasHub ? "account_on" : "gitlab_profile", glConf, "gitlab-raw");
        }
        gitHits++;
        pageParentMap.set(gl.profile_url, glId);

        if (gl.ssh_keys.length && tier !== "collision") {
          for (const k of gl.ssh_keys.slice(0, 4)) {
            const sshId = normalizeNodeId("ssh_key", k.fingerprint);
            addNode({
              id: sshId,
              kind: "ssh_key",
              label: `SSH ${k.algo} (${k.short_fp})`,
              sublabel: `GitLab @${h} .keys`,
              layer: "deep",
              confidence: glConf,
              status: "unverified",
              sources: ["gitlab-raw"],
              metadata: {
                fingerprint: k.fingerprint,
                algorithm: k.algo,
                owner: `@${h}`,
                match_tier: tier,
                match_reason: `Public SSH key on gitlab.com/${h}.keys`,
              },
              url: `https://gitlab.com/${h}.keys`,
              depth: glDepth + 1,
            });
            addEdge(glId, sshId, "exposes_ssh_key", glConf, "gitlab-raw");
          }
        }
        if ((matchingGlGpgEmails.length || gl.gpg_key_id) && tier !== "collision") {
          const keyToken = gl.gpg_key_id || `gitlab_${h}`;
          const shortK = keyToken.slice(-16);
          const pgpId = normalizeNodeId("pgp_key", keyToken);
          addNode({
            id: pgpId,
            kind: "pgp_key",
            label: `PGP 0x${shortK}`,
            sublabel: `GitLab @${h} .gpg`,
            layer: "deep",
            confidence: 0.92,
            status: "unverified",
            sources: ["gitlab-raw"],
            metadata: { fingerprint: keyToken, uid: `@${h}`, match_tier: "verified", match_reason: "GitLab .gpg public key" },
            url: `https://gitlab.com/${h}.gpg`,
            depth: glDepth + 1,
          });
          addEdge(glId, pgpId, "has_pgp_key", 0.92, "gitlab-raw");
          for (const em of matchingGlGpgEmails) {
            const emId = normalizeNodeId("email", em);
            addNode({
              id: emId,
              kind: "email",
              label: em,
              sublabel: "GitLab Raw .gpg",
              layer: "anchor",
              confidence: 0.92,
              status: "unverified",
              sources: ["gitlab-raw"],
              metadata: { pgp_key: shortK, match_tier: "verified", match_reason: "GitLab .gpg cryptographic UID" },
              url: `https://gitlab.com/${h}.gpg`,
              depth: glDepth + 2,
            });
            addEdge(pgpId, emId, "pgp_uid_email", 0.92, "gitlab-raw");
            trackEmail(em);
          }
        }
      }
    }
  }
  emitTool("git-raw", "done", gitHits, `${gitHits} GitHub/GitLab raw + .patch artifact(s)`);

  // Promote confirmed GitHub handles to the front of knownHandles so WMN/Maigret/Sherlock pivot on real handles FIRST!
  if (confirmedHandlesPriority.length) {
    const lead = Array.from(new Set([...(seedHandleNorm ? [seedHandleNorm] : []), ...confirmedHandlesPriority, ...verifiedHandlesPriority]));
    const reordered = [...lead, ...knownHandles.filter((x) => !lead.includes(x))];
    knownHandles.splice(0, knownHandles.length, ...reordered);
  }

  // Deep Personal Website / Portfolio Crawler
  const personalSitePdfs = [];
  if (personalWebsites.length) {
    for (const pUrl of personalWebsites.slice(0, 3)) {
      const crawled = await crawlPersonalSite(pUrl, netCtx);
      let siteDom = "";
      try {
        siteDom = new URL(pUrl).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        siteDom = "";
      }
      const isNoiseDom = !siteDom || PLATFORM_NOISE_DOMAINS.some((d) => siteDom === d || siteDom.endsWith(`.${d}`));
      let parentForSite = pageParentMap.get(pUrl) || seedId;
      if (!isNoiseDom) {
        const domId = normalizeNodeId("domain", siteDom);
        if (!snap.nodes.some((n) => n.id === domId)) {
          const domParent = domainParentMap.get(siteDom)?.parentId || pageParentMap.get(pUrl) || seedId;
          addNode({
            id: domId,
            kind: "domain",
            label: siteDom,
            sublabel: "Personal Website",
            layer: "deep",
            confidence: 0.86,
            status: "unverified",
            sources: ["personal-site"],
            metadata: { domain: siteDom, match_tier: "probable", match_reason: "Linked personal website" },
            url: `https://${siteDom}`,
            depth: findNodeDepth(domParent) + 1,
          });
          addEdge(domParent, domId, domainParentMap.get(siteDom)?.relation || "links_to", 0.86, "personal-site");
        }
        parentForSite = domId;
      }
      for (const pdf of crawled.pdf_urls) {
        if (!personalSitePdfs.includes(pdf)) personalSitePdfs.push(pdf);
        pdfParentMap.set(pdf, { parentId: parentForSite, relation: "hosts_pdf" });
      }
      for (const em of crawled.emails) {
        const emId = normalizeNodeId("email", em);
        addNode({
          id: emId,
          kind: "email",
          label: em,
          sublabel: `Personal Site (${siteDom || "site"})`,
          layer: "anchor",
          confidence: 0.9,
          status: "unverified",
          sources: ["personal-site"],
          metadata: {
            match_tier: "verified",
            match_reason: "Extracted from linked personal site",
            website: pUrl,
          },
          url: pUrl,
          depth: findNodeDepth(parentForSite) + 1,
        });
        addEdge(parentForSite, emId, "mentions_email", 0.9, "personal-site");
        addFinding({
          id: `finding:site-email:${em}`,
          node_id: emId,
          title: `Personal Site Email Exposed: ${em}`,
          category: "anchor",
          severity: "medium",
          confidence: 0.9,
          consensus_count: 1,
          sources: ["personal-site"],
          summary: `Direct crawl of ${pUrl} (/about, /contact, /pgp.txt, /security.txt) surfaced email '${em}'${
            crawled.bio ? ` · Bio: ${crawled.bio.slice(0, 120)}` : ""
          }.`,
          pivot_trail: [`Name: ${fullName}`, `Personal Site -> ${pUrl}`, `Email -> ${em}`],
          url: pUrl,
          timestamp: now,
          sensitive_fields: [em],
        });
        trackEmail(em);
      }
    }
  }

  // Passive Zero-Alert Email Anchor Discovery (ONLY if Stage 0/1 found 0 real emails!)
  if (knownEmails.length === 0) {
    const nParts = getNameParts(fullName);
    if (nParts.length >= 2) {
      const first = nParts[0];
      const last = nParts[nParts.length - 1];
      const likelyPersonal = [
        `${first}.${last}@gmail.com`,
        `${first}${last}@gmail.com`,
        `${first}.${last}@proton.me`,
        `${first}.${last}@outlook.com`,
      ];
      const knownAvatarHashes = new Set();
      for (const art of accountArtifacts.slice(0, 3)) {
        if (art.avatarUrl) {
          const h = await computeAvatarSha256(art.avatarUrl, netCtx);
          if (h) knownAvatarHashes.add(h);
        }
      }
      for (const candEmail of likelyPersonal) {
        const g = await checkGravatarRawHash(candEmail, netCtx);
        if (!g) continue;
        const gravHash = await computeAvatarSha256(g.avatarUrl, netCtx);
        const avatarMatched = Boolean(gravHash && knownAvatarHashes.has(gravHash));
        const conf = avatarMatched ? 0.95 : 0.68;
        const tier = avatarMatched ? "verified" : "probable";
        const reason = avatarMatched
          ? "Gravatar avatar SHA-256 matches profile"
          : "Passive Gravatar MD5 hash exists";
        const emId = normalizeNodeId("email", candEmail);
        addNode({
          id: emId,
          kind: "email",
          label: candEmail,
          sublabel: avatarMatched ? "Verified via Avatar SHA-256" : "Probable Gravatar Email",
          layer: avatarMatched ? "anchor" : "surface",
          confidence: conf,
          status: "unverified",
          sources: ["gravatar-raw"],
          metadata: {
            gravatar_md5: g.md5,
            avatar_url: g.avatarUrl,
            ...(gravHash ? { avatar_sha256: gravHash.slice(0, 16) } : {}),
            match_tier: tier,
            match_reason: reason,
          },
          url: g.avatarUrl,
          depth: 1,
        });
        if (!hasParentEdge(emId)) {
          addEdge(seedId, emId, avatarMatched ? "avatar_match" : "gravatar_confirmed", conf, "gravatar-raw");
        }
        addFinding({
          id: `finding:gravatar-discovery:${candEmail}`,
          node_id: emId,
          title: `${avatarMatched ? "Verified" : "Probable"} Email via Passive Gravatar: ${candEmail}`,
          category: "anchor",
          severity: avatarMatched ? "high" : "low",
          confidence: conf,
          consensus_count: avatarMatched ? 2 : 1,
          sources: avatarMatched ? ["gravatar-raw", "avatar-corroborator"] : ["gravatar-raw"],
          summary: avatarMatched
            ? `Passive Gravatar MD5 HEAD confirmed ${candEmail} AND its avatar SHA-256 matched a discovered profile avatar byte-for-byte.`
            : `Passive Gravatar MD5 HEAD returned HTTP 200 for ${candEmail} (zero alert, zero API).`,
          pivot_trail: [`Name: ${fullName}`, `Gravatar Raw MD5 -> ${candEmail}`],
          url: g.avatarUrl,
          timestamp: now,
          sensitive_fields: [candEmail, g.md5],
        });
        trackEmail(candEmail);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 1B: Direct DNS (MX/SPF/DMARC), TLS X.509 Cert Inspector & Gravatar HEAD
  // -------------------------------------------------------------------------
  emitStage("dns_gravatar", "Inspecting domain DNS, TLS X.509 certs & Gravatar hashes", 42);
  emitTool("dns-gravatar", "running", 0, "Direct DNS, TLS X.509 SANs & Gravatar MD5 checks");
  let dnsGravHits = 0;

  for (const dom of knownDomains.slice(0, 4)) {
    const [rep, cert] = await Promise.all([
      inspectDomainDns(dom, netCtx),
      inspectDomainTlsCert(dom, netCtx),
    ]);
    if (rep.mx_records.length || rep.spf_record || rep.dmarc_record || cert) {
      const domId = normalizeNodeId("domain", dom);
      const domParent = domainParentMap.get(dom);
      addNode({
        id: domId,
        kind: "domain",
        label: dom,
        sublabel: rep.mail_provider_hint || cert?.org || "Verified Domain",
        layer: "anchor",
        confidence: 0.86,
        status: "unverified",
        sources: ["direct-dns"],
        metadata: {
          domain: dom,
          match_tier: "verified",
          match_reason: cert?.org ? `TLS X.509 Org: ${cert.org}` : "Direct DNS/TLS verified",
          ...(rep.mx_records.length ? { mx: rep.mx_records.join(", ") } : {}),
          ...(rep.spf_record ? { spf: rep.spf_record } : {}),
          ...(rep.dmarc_record ? { dmarc: rep.dmarc_record } : {}),
          ...(cert?.org ? { tls_org: cert.org } : {}),
          ...(cert?.sans?.length ? { tls_sans: cert.sans.slice(0, 5).join(", ") } : {}),
        },
        url: `https://${dom}`,
        depth: domParent ? findNodeDepth(domParent.parentId) + 1 : 1,
      });
      if (!hasParentEdge(domId)) {
        addEdge(domParent?.parentId || seedId, domId, domParent?.relation || "domain_dns", 0.84, "direct-dns");
      }
      const summaryParts = [];
      if (rep.mx_records.length) summaryParts.push(`${rep.mx_records.length} MX record(s)`);
      if (rep.dmarc_record) summaryParts.push(`DMARC present`);
      else if (rep.mx_records.length) summaryParts.push("No DMARC (spoofing exposure)");
      if (cert?.org) summaryParts.push(`TLS X.509 Org: ${cert.org}`);
      if (cert?.sans?.length) summaryParts.push(`SANs: ${cert.sans.slice(0, 4).join(", ")}`);
      addFinding({
        id: `finding:dns:${dom}`,
        node_id: domId,
        title: `Domain Infrastructure & TLS Posture: ${dom}`,
        category: "corporate",
        severity: !rep.dmarc_record && rep.mx_records.length ? "medium" : "info",
        confidence: 0.86,
        consensus_count: 1,
        sources: ["direct-dns"],
        summary: summaryParts.join(" · ") || `Direct TLS/DNS probe succeeded for ${dom}.`,
        pivot_trail: [`Name: ${fullName}`, `Domain -> ${dom}`, "Direct DNS & TLS X.509"],
        url: `https://${dom}`,
        timestamp: now,
        sensitive_fields: [dom],
      });
      dnsGravHits++;
    }
  }

  const gravEmails = Array.from(new Set([...knownEmails, ...permutedEmails])).slice(0, 8);
  for (const em of gravEmails) {
    const g = await checkGravatarRawHash(em, netCtx);
    if (g) {
      const emId = normalizeNodeId("email", em);
      addNode({
        id: emId,
        kind: "email",
        label: em,
        sublabel: "Gravatar Hash Confirmed",
        layer: "anchor",
        confidence: 0.88,
        status: "unverified",
        sources: ["gravatar-raw"],
        metadata: {
          gravatar_md5: g.md5,
          avatar_url: g.avatarUrl,
          match_tier: "verified",
          match_reason: "Gravatar MD5 hash confirmed",
        },
        url: g.avatarUrl,
        depth: 1,
      });
      if (!hasParentEdge(emId)) {
        addEdge(seedId, emId, "gravatar_confirmed", 0.88, "gravatar-raw");
      }
      addFinding({
        id: `finding:gravatar:${em}`,
        node_id: emId,
        title: `Active Gravatar Avatar Confirmed for ${em}`,
        category: "anchor",
        severity: "medium",
        confidence: 0.88,
        consensus_count: 1,
        sources: ["gravatar-raw"],
        summary: `Direct HEAD check against Gravatar MD5 hash (${g.md5.slice(0, 12)}) returned HTTP 200.`,
        pivot_trail: [`Name: ${fullName}`, `Email -> ${em}`, "Gravatar Raw MD5 HEAD -> 200 OK"],
        url: g.avatarUrl,
        timestamp: now,
        sensitive_fields: [em, g.md5],
      });
      trackEmail(em);
      dnsGravHits++;
    }
  }
  emitTool("dns-gravatar", "done", dnsGravHits, `${dnsGravHits} DNS/TLS/Gravatar confirmation(s)`);

  // -------------------------------------------------------------------------
  // Stage 2: Native Calibrated WhatsMyName + Multi-Signal Entity Resolution
  // -------------------------------------------------------------------------
  const wmnSiteLimit = depthLevel === 1 ? 25 : WMN_SITES.length;
  const wmnHandleLimit = { 1: 2, 2: 3, 3: 4, 4: 5 }[depthLevel] || 3;
  const wmnBudgetMs = { 1: 12_000, 2: 20_000, 3: 28_000, 4: 35_000 }[depthLevel] || 20_000;
  emitStage("wmn", `Checking ${wmnSiteLimit} calibrated platforms (L${depthLevel} depth, zero-canary FP)`, 54);
  emitTool("wmn-native", "running", 0, `Scanning ${wmnSiteLimit} verified sites across ${Math.min(wmnHandleLimit, knownHandles.length)} handle(s)`);
  const wmnHandles = knownHandles.slice(0, wmnHandleLimit);
  let wmnCorroborated = 0;
  let wmnCollisions = 0;

  for (const h of wmnHandles) {
    const hId = normalizeNodeId("handle", h);
    const isSeed = seedHandleNorm === h;
    const hits = await runWmnForHandle(
      h,
      fullName,
      knownOrgs,
      knownDomains,
      knownEmails,
      isSeed,
      netCtx,
      18,
      wmnSiteLimit,
      wmnBudgetMs
    );

    const existingForHandle = snap.nodes.filter(
      (n) => n.kind === "account" && String(n.metadata?.handle || "").toLowerCase() === h
    );
    const useHandleHub =
      isSeed ||
      snap.nodes.some((n) => n.id === hId) ||
      existingForHandle.length + hits.length >= 2;
    if (useHandleHub && hits.length > 0 && !snap.nodes.some((n) => n.id === hId)) {
      const anyVerified = hits.some((x) => x.match_tier === "verified") || existingForHandle.some((n) => n.metadata?.match_tier === "verified");
      const anyProbable = hits.some((x) => x.match_tier === "probable") || existingForHandle.some((n) => n.metadata?.match_tier === "probable");
      const hubTier = anyVerified ? "verified" : anyProbable ? "probable" : "collision";
      addNode({
        id: hId,
        kind: "handle",
        label: `@${h}`,
        sublabel: "Handle Hub",
        layer: hubTier === "verified" ? "anchor" : "surface",
        confidence: hubTier === "verified" ? 0.85 : hubTier === "probable" ? 0.7 : 0.4,
        status: "unverified",
        sources: ["wmn-native"],
        metadata: { handle: h, match_tier: hubTier, match_reason: `Handle hub linking ${existingForHandle.length + hits.length} account(s)` },
        url: null,
        depth: 1,
      });
      addEdge(seedId, hId, "uses_handle", hubTier === "collision" ? 0.4 : 0.8, "wmn-native");
      // Reparent prior git-raw direct accounts for this handle under the handle hub
      for (const exAcc of existingForHandle) {
        const directIdx = snap.edges.findIndex(
          (e) =>
            e.source === seedId &&
            e.target === exAcc.id &&
            (e.relation === "github_profile" || e.relation === "gitlab_profile")
        );
        if (directIdx !== -1) {
          snap.edges.splice(directIdx, 1);
          addEdge(hId, exAcc.id, "account_on", exAcc.confidence || 0.78, "wmn-native");
        }
      }
    }

    for (const hit of hits) {
      if (hit.match_tier === "collision") wmnCollisions++;
      else wmnCorroborated++;

      const acctId = normalizeAccountNodeId(hit.site_name, hit.handle);
      const hubExists = snap.nodes.some((n) => n.id === hId);
      const parentId = hubExists ? hId : seedId;
      addNode({
        id: acctId,
        kind: "account",
        label: `${hit.site_name} (@${hit.handle})`,
        sublabel: hit.title ? hit.title.slice(0, 48) : hit.site_name,
        layer: hit.match_tier === "verified" ? "anchor" : "surface",
        confidence: hit.confidence,
        status: "unverified",
        sources: ["wmn-native"],
        metadata: {
          platform: hit.site_name,
          handle: hit.handle,
          match_tier: hit.match_tier,
          match_reason: hit.match_reason,
          ...(hit.title ? { display_name: hit.title.slice(0, 120) } : {}),
          ...(hit.description ? { bio: hit.description.slice(0, 200) } : {}),
          ...(hit.avatar_url ? { avatar_url: hit.avatar_url } : {}),
          ...(hit.outbound_urls?.length ? { linked_accounts: hit.outbound_urls.slice(0, 3).join(", ") } : {}),
        },
        url: hit.url,
        depth: hubExists ? 2 : 1,
      });
      if (!hasParentEdge(acctId)) {
        addEdge(parentId, acctId, "account_on", hit.confidence, "wmn-native");
      }

      const trail = [`Name: ${fullName}`, `Handle -> @${hit.handle}`, `WhatsMyName -> ${hit.site_name}`];
      const wmnSummaryParts = [
        hit.title && `Title: ${hit.title.slice(0, 90)}`,
        hit.description && `Bio: ${hit.description.slice(0, 130)}`,
        hit.outbound_urls?.length && `Links: ${hit.outbound_urls.slice(0, 2).join(", ")}`,
      ].filter(Boolean);
      addFinding({
        id: `finding:account:${normalizePlatformSlug(hit.site_name)}:${hit.handle.toLowerCase()}`,
        node_id: acctId,
        title: `${hit.site_name} (@${hit.handle})`,
        category: hit.category,
        severity:
          hit.match_tier === "collision"
            ? "info"
            : hit.category === "code" || hit.category === "corporate"
            ? "low"
            : "info",
        confidence: hit.confidence,
        consensus_count: 1,
        sources: ["wmn-native"],
        summary: wmnSummaryParts.length
          ? `${hit.match_reason} · ${wmnSummaryParts.join(" · ")}`
          : `${hit.match_reason} (${hit.site_name} profile at ${hit.url}).`,
        pivot_trail: trail,
        url: hit.url,
        timestamp: now,
        sensitive_fields: [hit.handle],
      });

      accountArtifacts.push({
        nodeId: acctId,
        url: hit.url,
        site: hit.site_name,
        avatarUrl: hit.avatar_url,
        outboundUrls: hit.outbound_urls,
      });
      pageParentMap.set(hit.url, acctId);

      if (hit.match_tier !== "collision" && confirmedProfileUrls.length < 10) {
        confirmedProfileUrls.push([acctId, hit.url, trail]);
      }
    }
  }
  emitTool(
    "wmn-native",
    "done",
    wmnCorroborated + wmnCollisions,
    `${wmnCorroborated} corroborated, ${wmnCollisions} collision lead(s)`
  );

  // -------------------------------------------------------------------------
  // Stage 2A: Cross-Account Avatar SHA-256 & Reciprocal Link Corroboration
  // -------------------------------------------------------------------------
  const dedupArtMap = new Map();
  for (const art of accountArtifacts) {
    if (!art?.nodeId) continue;
    const prev = dedupArtMap.get(art.nodeId);
    if (!prev) {
      dedupArtMap.set(art.nodeId, { ...art, outboundUrls: [...(art.outboundUrls || [])] });
    } else {
      if (!prev.avatarUrl && art.avatarUrl) prev.avatarUrl = art.avatarUrl;
      for (const u of art.outboundUrls || []) {
        if (!prev.outboundUrls.includes(u)) prev.outboundUrls.push(u);
      }
    }
  }
  accountArtifacts.splice(0, accountArtifacts.length, ...dedupArtMap.values());

  if (accountArtifacts.length >= 2) {
    emitStage("corroborate", "Running cross-platform avatar SHA-256 & reciprocal link proof", 65);
    const avatarGroups = new Map();
    await Promise.all(
      accountArtifacts.slice(0, 14).map(async (art) => {
        if (!art.avatarUrl) return;
        const hash = await computeAvatarSha256(art.avatarUrl, netCtx);
        if (!hash) return;
        art.avatarHash = hash;
        if (!avatarGroups.has(hash)) avatarGroups.set(hash, []);
        avatarGroups.get(hash).push(art);
      })
    );

    for (const [hash, group] of avatarGroups.entries()) {
      if (group.length < 2) continue;
      const sites = group.map((g) => g.site).join(" + ");
      for (let i = 0; i < group.length; i++) {
        const g = group[i];
        const existing = snap.nodes.find((n) => n.id === g.nodeId);
        if (existing) {
          addNode({
            ...existing,
            layer: "anchor",
            confidence: 0.94,
            sources: ["avatar-corroborator"],
            metadata: {
              ...existing.metadata,
              avatar_sha256: hash.slice(0, 16),
              match_tier: "verified",
              match_reason: `Identical avatar across ${group.length} sites`,
            },
          });
        }
        if (i > 0 && group[0].nodeId !== g.nodeId) {
          addEdge(group[0].nodeId, g.nodeId, "avatar_match", 0.94, "avatar-corroborator");
        }
      }
      addFinding({
        id: `finding:avatar-match:${hash.slice(0, 16)}`,
        node_id: group[0].nodeId,
        title: `Identical Avatar Verified Across ${group.length} Platforms (${sites})`,
        category: "anchor",
        severity: "medium",
        confidence: 0.94,
        consensus_count: group.length,
        sources: ["avatar-corroborator", "wmn-native"],
        summary: `SHA-256 avatar fingerprint (${hash.slice(0, 16)}…) matched byte-for-byte across ${sites}, cryptographically linking these accounts beyond username similarity.`,
        pivot_trail: [`Name: ${fullName}`, `Avatar SHA-256 -> ${sites}`],
        url: group[0].url,
        timestamp: now,
        sensitive_fields: [],
      });
    }

    for (let i = 0; i < accountArtifacts.length; i++) {
      for (let j = i + 1; j < accountArtifacts.length; j++) {
        const a = accountArtifacts[i];
        const b = accountArtifacts[j];
        if (a.nodeId === b.nodeId) continue;
        const aNorm = normUrlForMatch(a.url);
        const bNorm = normUrlForMatch(b.url);
        const aLinksB = (a.outboundUrls || []).some((u) => normUrlForMatch(u).includes(bNorm) || bNorm.includes(normUrlForMatch(u)));
        const bLinksA = (b.outboundUrls || []).some((u) => normUrlForMatch(u).includes(aNorm) || aNorm.includes(normUrlForMatch(u)));
        if (aLinksB && bLinksA) {
          addEdge(a.nodeId, b.nodeId, "reciprocal_proof", 0.97, "reciprocal-proof");
          for (const g of [a, b]) {
            const ex = snap.nodes.find((n) => n.id === g.nodeId);
            if (ex) {
              addNode({
                ...ex,
                layer: "anchor",
                confidence: 0.97,
                sources: ["reciprocal-proof"],
                metadata: {
                  ...ex.metadata,
                  match_tier: "verified",
                  match_reason: "Reciprocal profile link",
                },
              });
            }
          }
          addFinding({
            id: `finding:reciprocal:${a.nodeId}:${b.nodeId}`,
            node_id: a.nodeId,
            title: `Reciprocal Profile Proof: ${a.site} ↔ ${b.site}`,
            category: "anchor",
            severity: "medium",
            confidence: 0.97,
            consensus_count: 2,
            sources: ["reciprocal-proof", "html-extractor"],
            summary: `Bidirectional link verified between ${a.url} and ${b.url} — strong proof both accounts belong to the same individual.`,
            pivot_trail: [`Name: ${fullName}`, `${a.site} <-> ${b.site}`],
            url: a.url,
            timestamp: now,
            sensitive_fields: [],
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 2B: Depth-2 Noise-Stripped HTML Extractor
  // -------------------------------------------------------------------------
  const discoveredPdfUrls = Array.from(new Set([...personalSitePdfs, ...webDiscoveredPdfs]));
  if (input.max_depth >= 2 && confirmedProfileUrls.length) {
    emitStage("html_extractor", "Deep-extracting OpenGraph, JSON-LD sameAs & clean profile links", 72);
    emitTool("html-extractor", "running", 0, `Parsing ${Math.min(8, confirmedProfileUrls.length)} verified profile(s)`);
    let extHits = 0;
    const seenUrls = new Set();
    for (const [parentId, url, baseTrail] of confirmedProfileUrls.slice(0, 8)) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const data = await extractProfileHtml(url, netCtx);
      if (!data) continue;
      const parentDepth = findNodeDepth(parentId);
      for (const p of data.pdf_urls) {
        if (!discoveredPdfUrls.includes(p)) discoveredPdfUrls.push(p);
        pdfParentMap.set(p, { parentId, relation: "linked_pdf" });
      }
      for (const sa of data.same_as_urls) {
        if (sa.toLowerCase().includes(".pdf")) {
          if (!discoveredPdfUrls.includes(sa)) discoveredPdfUrls.push(sa);
          pdfParentMap.set(sa, { parentId, relation: "linked_pdf" });
        } else {
          if (!personalWebsites.includes(sa)) personalWebsites.push(sa);
          pageParentMap.set(sa, parentId);
          try {
            const dom = new URL(sa).hostname.replace(/^www\./, "").toLowerCase();
            if (dom && !PLATFORM_NOISE_DOMAINS.some((d) => dom === d || dom.endsWith(`.${d}`))) {
              domainParentMap.set(dom, { parentId, relation: "links_to" });
            }
          } catch {
            // ignore
          }
        }
      }
      for (const em of data.emails) {
        if (isNoiseEmail(em)) continue;
        const emId = normalizeNodeId("email", em);
        addNode({
          id: emId,
          kind: "email",
          label: em,
          sublabel: "Extracted from Profile HTML",
          layer: "deep",
          confidence: 0.82,
          status: "unverified",
          sources: ["html-extractor"],
          metadata: { match_tier: "verified", match_reason: "Embedded email in profile body" },
          url,
          depth: parentDepth + 1,
        });
        addEdge(parentId, emId, "mentions_email", 0.82, "html-extractor");
        addFinding({
          id: `finding:html-email:${em}`,
          node_id: emId,
          title: `Embedded Email Discovered: ${em}`,
          category: "anchor",
          severity: "medium",
          confidence: 0.82,
          consensus_count: 1,
          sources: ["html-extractor"],
          summary: `Boilerplate-stripped HTML/JSON-LD extraction from ${url} surfaced email '${em}'.`,
          pivot_trail: [...baseTrail, `HTML Extract -> ${em}`],
          url,
          timestamp: now,
          sensitive_fields: [em],
        });
        trackEmail(em);
        extHits++;
      }
      for (const ph of data.phones || []) {
        if (trackPhone(ph)) {
          const phId = normalizeNodeId("phone", ph);
          addNode({
            id: phId,
            kind: "phone",
            label: ph,
            sublabel: "Extracted from Profile HTML",
            layer: "deep",
            confidence: 0.8,
            status: "unverified",
            sources: ["html-extractor"],
            metadata: { match_tier: "verified", match_reason: "Embedded phone in profile body" },
            url,
            depth: parentDepth + 1,
          });
          addEdge(parentId, phId, "mentions_phone", 0.8, "html-extractor");
          extHits++;
        }
      }
      for (const [plat, ch] of data.cross_handles.slice(0, 4)) {
        const acctId = normalizeAccountNodeId(plat, ch);
        const crossUrl = buildCanonicalProfileUrl(plat, ch) || url;
        if (isBlockedSpaUrl(crossUrl)) continue;
        addNode({
          id: acctId,
          kind: "account",
          label: `${plat} (@${ch})`,
          sublabel: "Cross-linked Profile",
          layer: "deep",
          confidence: 0.78,
          status: "unverified",
          sources: ["html-extractor"],
          metadata: {
            platform: plat,
            handle: ch,
            match_tier: "probable",
            match_reason: "Linked from confirmed profile",
          },
          url: crossUrl,
          depth: parentDepth + 1,
        });
        if (parentId !== acctId) {
          addEdge(parentId, acctId, "links_to", 0.78, "html-extractor");
        }
        extHits++;
      }
      for (const org of data.orgs) {
        trackOrg(org);
        const orgId = normalizeNodeId("org", org);
        addNode({
          id: orgId,
          kind: "org",
          label: org,
          sublabel: "JSON-LD Affiliation",
          layer: "deep",
          confidence: 0.78,
          status: "unverified",
          sources: ["html-extractor"],
          metadata: { match_tier: "probable", match_reason: "JSON-LD worksFor affiliation" },
          url,
          depth: parentDepth + 1,
        });
        addEdge(parentId, orgId, "works_for", 0.78, "html-extractor");
        extHits++;
      }
    }
    emitTool("html-extractor", "done", extHits, `${extHits} clean depth-2 pivot(s)`);
  } else {
    emitTool("html-extractor", "done", 0, "0 corroborated profiles to expand");
  }

  // -------------------------------------------------------------------------
  // Stage 2C: Always-Active Public PDF Metadata Extractor (Domains + Sites + Repos)
  // -------------------------------------------------------------------------
  emitStage("doc_meta", "Scanning domains, personal sites & repos for public PDFs", 78);
  emitTool("doc-meta", "running", 0, "Searching corporate domains, portfolios & GitHub repos for PDFs");

  const corpDomains = knownDomains.filter((d) => !FREE_MAIL_DOMAINS.has(d)).slice(0, 2);
  for (const dom of corpDomains) {
    if (discoveredPdfUrls.length >= 6) break;
    for (const u of await discoverDomainPdfs(dom, netCtx)) {
      if (!discoveredPdfUrls.includes(u)) discoveredPdfUrls.push(u);
      if (!pdfParentMap.has(u)) {
        pdfParentMap.set(u, { parentId: normalizeNodeId("domain", dom), relation: "hosts_pdf" });
      }
    }
  }
  const extraPages = [...personalWebsites, ...githubRepoPages].slice(0, 6);
  if (extraPages.length && discoveredPdfUrls.length < 6) {
    for (const pItem of await discoverPagePdfs(extraPages, netCtx)) {
      if (!discoveredPdfUrls.includes(pItem.url)) discoveredPdfUrls.push(pItem.url);
      if (!pdfParentMap.has(pItem.url)) {
        pdfParentMap.set(pItem.url, {
          parentId: pageParentMap.get(pItem.sourcePage) || seedId,
          relation: "linked_pdf",
        });
      }
    }
  }

  const docPdfCap = { 1: 0, 2: 5, 3: 12, 4: 20 }[depthLevel] || 5;
  let docHits = 0;
  if (docPdfCap > 0) {
    for (const pdfUrl of discoveredPdfUrls.slice(0, docPdfCap)) {
      const searchMeta = pdfMetaMap.get(pdfUrl) || null;
      const meta = await fetchAndParsePdf(pdfUrl, netCtx);
      const pInfo = pdfParentMap.get(pdfUrl);
      const isArxivPdf = pInfo?.relation === "has_pdf";
      const isSearchVerified = Boolean(searchMeta?.verifiedFromSearch);
      if (!meta && !isSearchVerified) continue;
      if (
        meta &&
        !isArxivPdf &&
        !isSearchVerified &&
        !meta.author &&
        !meta.creator &&
        !meta.internal_usernames.length &&
        !meta.emails.length &&
        !meta.phones?.length
      ) {
        continue;
      }
      let fallbackFileName = "document.pdf";
      try {
        const seg = decodeURIComponent(new URL(pdfUrl).pathname.split("/").filter(Boolean).pop() || "");
        if (seg) fallbackFileName = seg.slice(0, 80);
      } catch {
        // ignore
      }
      const fileName = meta?.file_name || fallbackFileName;
      const docTitle = (searchMeta?.title || meta?.title || fileName).slice(0, 120);
      const docBio = searchMeta?.snippet || null;
      const docId = normalizeNodeId("document", pdfUrl);
      const authorMatch = Boolean(meta?.author && sharesNameToken(meta.author, fullName));
      const conf =
        authorMatch || meta?.emails?.length || meta?.phones?.length
          ? 0.86
          : isArxivPdf || isSearchVerified
          ? 0.82
          : 0.74;
      const fallbackDomId = corpDomains[0] ? normalizeNodeId("domain", corpDomains[0]) : seedId;
      const parentId =
        pInfo?.parentId && snap.nodes.some((n) => n.id === pInfo.parentId)
          ? pInfo.parentId
          : searchMeta?.parentRecordId && snap.nodes.some((n) => n.id === searchMeta.parentRecordId)
          ? searchMeta.parentRecordId
          : snap.nodes.some((n) => n.id === fallbackDomId)
          ? fallbackDomId
          : seedId;
      const docDepth = findNodeDepth(parentId) + 1;
      const docRel = pInfo?.relation || "hosts_pdf";

      addNode({
        id: docId,
        kind: "document",
        label: docTitle.slice(0, 68),
        sublabel: meta?.author || meta?.creator || meta?.producer || (isSearchVerified ? "Verified Public PDF" : "Public PDF Metadata"),
        layer: authorMatch || isSearchVerified ? "anchor" : "deep",
        confidence: conf,
        status: "unverified",
        sources: ["doc-meta"],
        metadata: {
          filename: fileName,
          title: docTitle,
          ...(docBio ? { bio: docBio } : {}),
          match_tier: authorMatch || meta?.emails?.length || isArxivPdf || isSearchVerified ? "verified" : "probable",
          match_reason: authorMatch
            ? "PDF /Author matches target"
            : isArxivPdf
            ? "Academic paper PDF"
            : isSearchVerified
            ? "Public PDF verified in search index"
            : "Public PDF Info/XMP metadata",
          ...(meta?.author ? { author: meta.author } : {}),
          ...(meta?.creator ? { creator: meta.creator } : {}),
          ...(meta?.producer ? { producer: meta.producer } : {}),
          ...(meta?.internal_usernames?.length ? { os_user: meta.internal_usernames.join(", ") } : {}),
          ...(meta?.emails?.length ? { extracted_emails: meta.emails.join(", ") } : {}),
        },
        url: pdfUrl,
        depth: docDepth,
      });
      addEdge(parentId, docId, docRel, conf, "doc-meta");
      const details = [
        meta?.author && `Author: ${meta.author}`,
        meta?.creator && `Creator: ${meta.creator}`,
        meta?.producer && `Producer: ${meta.producer}`,
      ].filter(Boolean);
      addFinding({
        id: `finding:pdf:${docId}`,
        node_id: docId,
        title: `Public PDF Document: ${docTitle}`,
        category: "corporate",
        severity: authorMatch || meta?.internal_usernames?.length ? "medium" : "low",
        confidence: conf,
        consensus_count: 1,
        sources: ["doc-meta"],
        summary: details.length
          ? `PDF parser extracted ${details.join(" · ")} from ${fileName}.${docBio ? ` ${docBio}` : ""}`
          : docBio || `Verified public PDF document ${fileName} linked to ${fullName}.`,
        pivot_trail: [`Name: ${fullName}`, `Public PDF -> ${fileName}`, details[0] || "Search-Verified PDF"],
        url: pdfUrl,
        timestamp: now,
        sensitive_fields: meta?.author ? [meta.author] : [],
      });
      docHits++;
      for (const u of meta?.internal_usernames || []) {
        const uId = normalizeNodeId("handle", u);
        addNode({
          id: uId,
          kind: "handle",
          label: `@${u}`,
          sublabel: "PDF Internal Path Username",
          layer: "deep",
          confidence: 0.82,
          status: "unverified",
          sources: ["doc-meta"],
          metadata: { handle: u, match_tier: "verified", match_reason: "PDF internal file path username" },
          url: pdfUrl,
          depth: docDepth + 1,
        });
        addEdge(docId, uId, "leaked_os_user", 0.82, "doc-meta");
        trackHandle(u);
        docHits++;
      }
      for (const em of meta?.emails || []) {
        const emId = normalizeNodeId("email", em);
        addNode({
          id: emId,
          kind: "email",
          label: em,
          sublabel: "Embedded PDF Email",
          layer: "anchor",
          confidence: 0.86,
          status: "unverified",
          sources: ["doc-meta"],
          metadata: { match_tier: "verified", match_reason: "Embedded PDF email" },
          url: pdfUrl,
          depth: docDepth + 1,
        });
        addEdge(docId, emId, "pdf_author_email", 0.86, "doc-meta");
        trackEmail(em);
        docHits++;
      }
      for (const ph of meta?.phones || []) {
        if (trackPhone(ph)) {
          const phId = normalizeNodeId("phone", ph);
          addNode({
            id: phId,
            kind: "phone",
            label: ph,
            sublabel: "Embedded PDF Phone",
            layer: "anchor",
            confidence: 0.84,
            status: "unverified",
            sources: ["doc-meta"],
            metadata: { match_tier: "verified", match_reason: "Extracted from public PDF" },
            url: pdfUrl,
            depth: docDepth + 1,
          });
          addEdge(docId, phId, "pdf_phone", 0.84, "doc-meta");
          docHits++;
        }
      }
    }
  }
  emitTool(
    "doc-meta",
    docPdfCap > 0 ? "done" : "skipped",
    docHits,
    docPdfCap === 0
      ? "Quick depth (L1)"
      : discoveredPdfUrls.length
      ? `Parsed ${Math.min(docPdfCap, discoveredPdfUrls.length)} PDF(s) — ${docHits} hit(s)`
      : `Scanned ${corpDomains.length + extraPages.length} surface(s) — 0 public PDFs`
  );

  // -------------------------------------------------------------------------
  // Stage 3A: Actionable Tor SOCKS5h .onion Search + Live Inspection & Classification
  // -------------------------------------------------------------------------
  const searchTerms = [
    fullName,
    ...knownEmails.slice(0, 4),
    ...knownHandles.slice(0, 3),
    ...knownPhones.slice(0, 2),
  ];

  const seenOnions = new Set();
  const onionLiveProbesUsed = { count: 0 };

  const admitClassifiedOnion = async (rawHit, query, queryType, parentNodeId, sourceTool) => {
    const canonUrl = normUrlForMatch(rawHit.url);
    if (!canonUrl || !canonUrl.includes(".onion")) return "filtered";
    const onionId = normalizeNodeId("onion", rawHit.url);

    // If already admitted from tor-socks5h/onionsearch, merge source cleanly without re-probing!
    if (seenOnions.has(canonUrl) && snap.nodes.some((n) => n.id === onionId)) {
      addNode({
        ...snap.nodes.find((n) => n.id === onionId),
        sources: [sourceTool],
      });
      return "duplicate";
    }

    // Pre-screen with index data first so we don't spend live Tor probes on obvious spam
    const preCheck = classifyOnionHit(rawHit, query, queryType, fullName, null);
    let livePageData = null;
    if (tor.available && onionLiveProbesUsed.count < 5 && (preCheck !== null || onionLiveProbesUsed.count < 2)) {
      onionLiveProbesUsed.count++;
      livePageData = await fetchOnionPageSnippet(tor.host, tor.port, rawHit.url);
    }

    const classified = classifyOnionHit(rawHit, query, queryType, fullName, livePageData);
    if (!classified) return "filtered"; // Dropped unrelated darknet spam!

    seenOnions.add(canonUrl);
    const parentId =
      parentNodeId && snap.nodes.some((n) => n.id === parentNodeId) ? parentNodeId : seedId;
    const onionDepth = findNodeDepth(parentId) + 1;

    addNode({
      id: onionId,
      kind: "onion",
      label: classified.title.slice(0, 62),
      sublabel: `${classified.site_category} · ${classified.engine}`,
      layer: "darkweb",
      confidence: classified.confidence,
      status: "unverified",
      sources: [sourceTool],
      metadata: {
        onion_host: classified.onion_host,
        where_found: classified.where_found,
        site_category: classified.site_category,
        site_purpose: classified.site_purpose,
        matched_identifier: classified.matched_identifier,
        matched_term: classified.matched_term,
        match_precision: classified.match_precision,
        match_tier: classified.match_tier,
        page_status: classified.page_status,
        engine: classified.engine,
        context_excerpt: classified.context_excerpt,
        bio: classified.bio,
        transport: tor.endpoint || "socks5h://127.0.0.1:9050",
        match_reason: `${
          classified.page_status === "live_verified" ? "Live .onion page verified" : `${classified.engine} index`
        } (${classified.matched_identifier})`,
      },
      url: classified.url,
      depth: onionDepth,
    });
    addEdge(parentId, onionId, "onion_mention", classified.confidence, sourceTool);
    addFinding({
      id: `finding:onion:${onionId}`,
      node_id: onionId,
      title: `${classified.title} [${classified.site_category}]`,
      category: "darkweb",
      severity: classified.match_tier === "verified" ? "high" : classified.match_tier === "probable" ? "medium" : "info",
      confidence: classified.confidence,
      consensus_count: 1,
      sources: [sourceTool],
      summary: `${classified.site_category} (${classified.where_found}) — ${classified.matched_identifier}. ${classified.context_excerpt || classified.bio}`,
      pivot_trail: [`Name: ${fullName}`, `${classified.engine} (Tor) -> ${classified.matched_identifier}`, classified.where_found],
      url: classified.url,
      timestamp: now,
      sensitive_fields: [classified.matched_term, classified.onion_host],
    });
    return "admitted";
  };

  if (input.enable_tor) {
    emitStage("tor_darkweb", "Searching live Tor .onion indexes (Ahmia v3 + OnionLand v3) & paste/leak indexes", 82);
    emitTool("tor-socks5h", "running", 0, "Querying Ahmia v3, OnionLand v3 & paste/leak indexes over socks5h://");
    if (!tor.available) {
      emitTool("tor-socks5h", "skipped", 0, "Tor offline (127.0.0.1:9050)");
    } else {
      const termLimit = { 1: 1, 2: 2, 3: 4, 4: 6 }[depthLevel] || 2;
      const structuredQueries = [];
      const seenQ = new Set();
      const pushQ = (query, queryType, parentNodeId) => {
        const clean = String(query || "").trim();
        const key = clean.toLowerCase();
        if (!clean || clean.length < 3 || seenQ.has(key)) return;
        seenQ.add(key);
        structuredQueries.push({ query: clean, queryType, parentNodeId });
      };
      pushQ(fullName, "full_name", seedId);
      for (const em of knownEmails.slice(0, 2)) pushQ(em, "email", normalizeNodeId("email", em));
      for (const h of knownHandles.filter((x) => x.length >= 5).slice(0, 2)) {
        pushQ(h, "handle", findHandleHubOrAccount(h) || seedId);
      }
      for (const d of knownDomains.filter((x) => !FREE_MAIL_DOMAINS.has(x)).slice(0, 1)) {
        pushQ(d, "domain", normalizeNodeId("domain", d));
      }

      const queriesToRun = structuredQueries.slice(0, termLimit);
      const rawCandidates = []; // [{ hit, queryObj }]
      const darkStats = { adsFiltered: 0 };

      // Run public paste/leak index search over Tor in parallel with live .onion index queries
      const pastePromise =
        depthLevel >= 2
          ? discoverPasteAndLeakMentions(fullName, knownEmails, knownHandles, netCtx, depthLevel).catch(() => [])
          : Promise.resolve([]);

      for (const qObj of queriesToRun) {
        const [ahmiaHits, olHits] = await Promise.all([
          queryAhmiaOnion(tor.host, tor.port, qObj.query),
          queryOnionLand(tor.host, tor.port, qObj.query, darkStats),
        ]);
        for (const h of [...ahmiaHits, ...olHits]) {
          rawCandidates.push({ hit: h, queryObj: qObj });
        }
      }

      // Prioritize exact/email/full_name matches and non-spam hits first before live Tor probing
      rawCandidates.sort((a, b) => {
        const score = (c) => {
          const pre = classifyOnionHit(c.hit, c.queryObj.query, c.queryObj.queryType, fullName, null);
          if (!pre) return 0;
          return pre.match_precision === "exact" ? 3 : pre.match_precision === "handle" ? 2 : 1;
        };
        return score(b) - score(a);
      });

      const maxOnionHits = depthLevel >= 3 ? 16 : 10;
      let torHits = 0;
      let spamRejected = 0;
      const seenSpamUrls = new Set();
      for (const cand of rawCandidates) {
        if (torHits >= maxOnionHits) break;
        const outcome = await admitClassifiedOnion(
          cand.hit,
          cand.queryObj.query,
          cand.queryObj.queryType,
          cand.queryObj.parentNodeId,
          "tor-socks5h"
        );
        if (outcome === "admitted") {
          torHits++;
        } else if (outcome === "filtered") {
          const cu = normUrlForMatch(cand.hit.url);
          if (!seenSpamUrls.has(cu)) {
            seenSpamUrls.add(cu);
            spamRejected++;
          }
        }
      }

      const pasteMentions = await pastePromise;
      let pasteHits = 0;
      for (const p of pasteMentions) {
        const pasteId = normalizeNodeId("paste", p.url);
        const emParentId = p.parentEmail ? normalizeNodeId("email", p.parentEmail) : null;
        const parentId =
          emParentId && snap.nodes.some((n) => n.id === emParentId) ? emParentId : seedId;
        const pDepth = findNodeDepth(parentId) + 1;
        const conf = p.queryType === "email" ? 0.88 : 0.8;
        addNode({
          id: pasteId,
          kind: "paste",
          label: p.title.slice(0, 64),
          sublabel: `${p.host} · Paste / Leak Mention`,
          layer: "darkweb",
          confidence: conf,
          status: "unverified",
          sources: ["tor-socks5h"],
          metadata: {
            source: p.host,
            matched_term: p.matchedTerm,
            matched_identifier: p.queryType === "email" ? `Email: ${p.matchedTerm}` : `Full Name: ${p.matchedTerm}`,
            bio: p.snippet,
            match_tier: "verified",
            match_reason: `Public paste/leak mention on ${p.host}`,
          },
          url: p.url,
          depth: pDepth,
        });
        addEdge(parentId, pasteId, "paste_mention", conf, "tor-socks5h");
        addFinding({
          id: `finding:paste:${pasteId}`,
          node_id: pasteId,
          title: `Public Paste / Leak Mention: ${p.title}`,
          category: "darkweb",
          severity: p.queryType === "email" ? "high" : "medium",
          confidence: conf,
          consensus_count: 1,
          sources: ["tor-socks5h"],
          summary: `${p.host} matched ${p.matchedTerm}: ${p.snippet || p.title}`,
          pivot_trail: [`Name: ${fullName}`, `Paste/Leak Index -> ${p.host}`, p.url],
          url: p.url,
          timestamp: now,
          sensitive_fields: [p.matchedTerm],
        });
        pasteHits++;
      }

      const filteredCount = darkStats.adsFiltered + spamRejected;
      const exitSuffix = state.torExitIp ? ` · exit ${state.torExitIp}` : "";
      const pasteSuffix = depthLevel >= 2 ? ` + ${pasteHits} paste/leak hit(s)` : "";
      const enginesLabel = depthLevel >= 2 ? "Ahmia v3, OnionLand v3 & Paste/Leak indexes" : "Ahmia v3 & OnionLand v3";
      emitTool(
        "tor-socks5h",
        "done",
        torHits + pasteHits,
        `Searched ${enginesLabel} across ${queriesToRun.length} term(s) — ${torHits} relevant .onion hit(s)${pasteSuffix} (${filteredCount} spam/ads filtered)${exitSuffix}`
      );
    }
  } else {
    emitTool("tor-socks5h", "skipped", 0, "Tor toggle OFF");
  }

  // -------------------------------------------------------------------------
  // Stage 3B: Always-Armed Local Sovereign Corpus Scanner
  // -------------------------------------------------------------------------
  const corpusDir = auth.local_corpus_dir?.trim() || DEFAULT_CORPUS_DIR;
  emitStage("local_corpus", "Scanning local offline breach/paste corpus folder", 89);
  emitTool("local-corpus", "running", 0, `Scanning ${path.basename(corpusDir)}`);
  const { filesScanned, hits: corpusHits } = scanLocalCorpus(corpusDir, searchTerms);
  for (const hit of corpusHits) {
    const bId = normalizeNodeId("breach", `${hit.file_name}:${hit.matched_term}`);
    const parentId = findAnchorForTerm(hit.matched_term);
    addNode({
      id: bId,
      kind: "breach",
      label: `Corpus: ${hit.file_name}`,
      sublabel: `Line ${hit.line_number} · Redacted`,
      layer: "darkweb",
      confidence: 0.92,
      status: "unverified",
      sources: ["local-corpus"],
      metadata: {
        file: hit.file_path,
        line: String(hit.line_number),
        matched: hit.matched_term,
        match_tier: "verified",
        match_reason: "Local breach corpus match",
      },
      url: null,
      depth: findNodeDepth(parentId) + 1,
    });
    addEdge(parentId, bId, "exposed_in", 0.92, "local-corpus");
    addFinding({
      id: `finding:corpus:${hit.file_name}:${hit.line_number}`,
      node_id: bId,
      title: `Local Corpus Exposure in ${hit.file_name} (line ${hit.line_number})`,
      category: "breach",
      severity: hit.has_credential_shape ? "high" : "medium",
      confidence: 0.92,
      consensus_count: 1,
      sources: ["local-corpus"],
      summary: `Matched '${hit.matched_term}' in local authorized corpus '${hit.file_name}'. Preview: ${hit.redacted_preview}`,
      pivot_trail: [`Name: ${fullName}`, `Local Corpus -> ${hit.file_name}`, `Match -> ${hit.matched_term}`],
      url: null,
      timestamp: now,
      sensitive_fields: [hit.matched_term, hit.redacted_preview],
    });
  }
  emitTool(
    "local-corpus",
    "done",
    corpusHits.length,
    filesScanned === 0
      ? "0 hits (drop files in corpus folder)"
      : `${corpusHits.length} hit(s) across ${filesScanned} file(s)`
  );

  // -------------------------------------------------------------------------
  // Stage 4: Local Python Open-Source Sidecar Bridge (sidecar/.venv)
  // -------------------------------------------------------------------------
  emitStage("sidecar", `Running local open-source CLI sidecar tools (L${depthLevel} depth)`, 92);
  const sidecarProfileUrls = confirmedProfileUrls.map((x) => x[1]).slice(0, depthLevel >= 3 ? 10 : 6);
  const sidecarHandleLimit = { 1: 2, 2: 3, 3: 4, 4: 5 }[depthLevel] || 3;
  const pendingSidecarTasks = [];
  const verifiedUrlCache = new Map();
  let sidecarActiveVerifies = 0;
  const runLimitedVerify = async (url) => {
    const canon = normUrlForMatch(url);
    if (verifiedUrlCache.has(canon)) return verifiedUrlCache.get(canon);
    while (sidecarActiveVerifies >= 6) {
      await new Promise((r) => setTimeout(r, 80));
    }
    sidecarActiveVerifies++;
    try {
      const verdict = await verifyLiveAccountUrl(url, netCtx);
      verifiedUrlCache.set(canon, verdict);
      return verdict;
    } finally {
      sidecarActiveVerifies--;
    }
  };

  await runSidecarBridge(
    input,
    { ...auth, local_corpus_dir: corpusDir },
    knownHandles.slice(0, sidecarHandleLimit),
    knownEmails.slice(0, depthLevel >= 3 ? 4 : 2),
    knownPhones,
    sidecarProfileUrls,
    netCtx,
    depthLevel,
    (ev) => {
      if (ev.kind === "tool_status") {
        emitTool(ev.tool, ev.state || "done", ev.hits || 0, ev.detail || "");
        return;
      }
      if (ev.kind !== "finding" && ev.kind !== "node") return;

      const task = (async () => {
        if (ev.url && isBlockedSpaUrl(ev.url)) return;
        const evMeta = ev.metadata && typeof ev.metadata === "object" ? ev.metadata : {};
        const entityKind = ev.entity_kind || "account";

        // 1. socid-extractor enrichment: merge into existing node matching ev.url, NEVER create a duplicate node!
        if (entityKind === "enrichment" || ev.tool === "socid-extractor" || /^Structured Profile\b/i.test(ev.label || "")) {
          if (!ev.url) return;
          const canonEvUrl = normUrlForMatch(ev.url);
          const targetNode = snap.nodes.find((n) => n.url && normUrlForMatch(n.url) === canonEvUrl);
          if (!targetNode) return;
          const enrichMeta = {};
          for (const k of ["display_name", "bio", "location", "org", "avatar_url", "uid"]) {
            if (evMeta[k] && !targetNode.metadata?.[k]) enrichMeta[k] = evMeta[k];
          }
          addNode({
            ...targetNode,
            confidence: Math.max(targetNode.confidence, ev.confidence ?? 0.84),
            sources: ["socid-extractor"],
            metadata: {
              ...(targetNode.metadata || {}),
              ...enrichMeta,
            },
          });
          return;
        }

        // 2. onionsearch dark-web hits: route through identical deduplication, live verification & classification
        if (entityKind === "onion" || ev.tool === "onionsearch") {
          if (!ev.url || !ev.url.includes(".onion")) return;
          const matchedTerm = String(evMeta.matched_term || fullName).replace(/^["']+|["']+$/g, "").trim();
          const qType = matchedTerm.includes("@")
            ? "email"
            : hasExactPhraseProximity(matchedTerm, fullName)
            ? "full_name"
            : "handle";
          const parentId = findAnchorForTerm(matchedTerm);
          await admitClassifiedOnion(
            {
              engine: evMeta.engine || "onionsearch",
              query: matchedTerm,
              title: ev.label || ev.url,
              url: ev.url,
              snippet: ev.summary || "",
            },
            matchedTerm,
            qType,
            parentId,
            ev.tool || "onionsearch"
          );
          return;
        }

        // 3. Registered services (holehe / ignorant): branch strictly from email / phone parent
        if (entityKind === "service") {
          const label = ev.label || evMeta.service_name || ev.tool;
          const nodeId = normalizeNodeId("service", label);
          let parentId = seedId;
          if (evMeta.email) {
            const emId = normalizeNodeId("email", evMeta.email);
            if (snap.nodes.some((n) => n.id === emId)) parentId = emId;
          } else if (evMeta.phone) {
            const targetDigits = String(evMeta.phone).replace(/\D/g, "");
            const phNode = snap.nodes.find((n) => n.kind === "phone" && n.label.replace(/\D/g, "") === targetDigits);
            if (phNode) parentId = phNode.id;
          } else if (ev.tool === "ignorant") {
            const phNode = snap.nodes.find((n) => n.kind === "phone");
            if (phNode) parentId = phNode.id;
          }
          const conf = ev.confidence ?? 0.86;
          addNode({
            id: nodeId,
            kind: "service",
            label,
            sublabel: evMeta.service_name ? `Service (${ev.tool})` : `Sidecar: ${ev.tool}`,
            layer: "anchor",
            confidence: conf,
            status: "unverified",
            sources: [ev.tool],
            metadata: {
              ...evMeta,
              match_tier: ev.match_tier || "verified",
              match_reason: ev.match_reason || `Confirmed via ${ev.tool}`,
            },
            url: ev.url || null,
            depth: findNodeDepth(parentId) + 1,
          });
          addEdge(parentId, nodeId, "registered_on", conf, ev.tool);
          addFinding({
            id: `finding:sidecar:service:${nodeId}`,
            node_id: nodeId,
            title: `Registered Service: ${label}`,
            category: "service",
            severity: "low",
            confidence: conf,
            consensus_count: 1,
            sources: [ev.tool],
            summary: ev.summary || `Local sidecar tool '${ev.tool}' confirmed registration on '${label}'.`,
            pivot_trail: [`Name: ${fullName}`, `Sidecar (${ev.tool}) -> ${label}`],
            url: ev.url || null,
            timestamp: new Date().toISOString(),
            sensitive_fields: evMeta.email ? [evMeta.email] : [label],
          });
          return;
        }

        // 4. h8mail offline breach hits: branch from matching email anchor
        if (entityKind === "breach") {
          const label = ev.label || ev.tool;
          const nodeId = normalizeNodeId("breach", label);
          const parentId = evMeta.email ? findAnchorForTerm(evMeta.email) : seedId;
          const conf = ev.confidence ?? 0.92;
          addNode({
            id: nodeId,
            kind: "breach",
            label,
            sublabel: `Sidecar: ${ev.tool}`,
            layer: "darkweb",
            confidence: conf,
            status: "unverified",
            sources: [ev.tool],
            metadata: {
              ...evMeta,
              match_tier: ev.match_tier || "verified",
              match_reason: ev.match_reason || `Confirmed via ${ev.tool}`,
            },
            url: ev.url || null,
            depth: findNodeDepth(parentId) + 1,
          });
          addEdge(parentId, nodeId, "exposed_in", conf, ev.tool);
          addFinding({
            id: `finding:sidecar:breach:${nodeId}`,
            node_id: nodeId,
            title: `${label} (${ev.tool})`,
            category: "breach",
            severity: "high",
            confidence: conf,
            consensus_count: 1,
            sources: [ev.tool],
            summary: ev.summary || `Local sidecar tool '${ev.tool}' matched local breach record '${label}'.`,
            pivot_trail: [`Name: ${fullName}`, `Sidecar (${ev.tool}) -> ${label}`],
            url: ev.url || null,
            timestamp: new Date().toISOString(),
            sensitive_fields: evMeta.email ? [evMeta.email] : [label],
          });
          return;
        }

        // 5. Account hits (maigret / sherlock): canonical ID normalization + live soft-404 verification gate
        const { platform, handle, rejectedFeedOrAsset } = extractPlatformAndHandleFromSidecar(ev);
        if (rejectedFeedOrAsset) return;
        const canonicalId = normalizeAccountNodeId(platform, handle);
        const existingByUrl = ev.url
          ? snap.nodes.find((n) => n.kind === "account" && n.url && normUrlForMatch(n.url) === normUrlForMatch(ev.url))
          : null;
        const targetNodeId = existingByUrl ? existingByUrl.id : canonicalId;
        const alreadyInGraph = snap.nodes.some((n) => n.id === targetNodeId);

        if (!alreadyInGraph && ev.url) {
          const liveCheck = await runLimitedVerify(ev.url);
          if (!liveCheck.ok) return; // Reject dead 404 / soft-404 URLs before entering graph!
        }

        const conf = ev.confidence ?? 0.72;
        const hHubId = normalizeNodeId("handle", handle);
        const hubExists = snap.nodes.some((n) => n.id === hHubId);
        const parentId = hubExists ? hHubId : seedId;
        addNode({
          id: targetNodeId,
          kind: "account",
          label: `${platform} (@${handle})`,
          sublabel: existingByUrl?.sublabel || `Sidecar: ${ev.tool}`,
          layer: ev.category === "anchor" ? "anchor" : "surface",
          confidence: conf,
          status: "unverified",
          sources: [ev.tool],
          metadata: {
            ...evMeta,
            platform,
            handle,
            match_tier: ev.match_tier || (conf >= 0.8 ? "verified" : "probable"),
            match_reason: ev.match_reason || `Confirmed via ${ev.tool}`,
          },
          url: ev.url || null,
          depth: hubExists ? findNodeDepth(hHubId) + 1 : 1,
        });
        if (!hasParentEdge(targetNodeId)) {
          addEdge(parentId, targetNodeId, hubExists ? "account_on" : "sidecar_match", conf, ev.tool);
        }
        addFinding({
          id: `finding:account:${normalizePlatformSlug(platform)}:${handle.toLowerCase()}`,
          node_id: targetNodeId,
          title: `${platform} (@${handle})`,
          category: ev.category || "account",
          severity: conf >= 0.82 ? "medium" : "low",
          confidence: conf,
          consensus_count: 1,
          sources: [ev.tool],
          summary: ev.summary || `Local sidecar tool '${ev.tool}' corroborated ${platform} account @${handle}.`,
          pivot_trail: [`Name: ${fullName}`, `Sidecar (${ev.tool}) -> ${platform} (@${handle})`],
          url: ev.url || null,
          timestamp: new Date().toISOString(),
          sensitive_fields: [handle],
        });
      })();
      pendingSidecarTasks.push(task);
    }
  );

  await Promise.allSettled(pendingSidecarTasks);
  for (const t of snap.tool_runs || []) {
    if (t.state === "running") {
      emitTool(t.tool, "done", t.hits || 0, t.detail ? `${t.detail} (finalized)` : "Completed");
    }
  }
  ensureGraphIntegrity(snap, seedId);

  snap.stats = computeStats(snap.nodes, snap.findings, snap.tool_runs);
  persistCases();
  emitStage("completed", "Investigation complete", 100);
  broadcastEvent({ kind: "completed", case_id: caseId, summary: snap.stats });
  state.activeInvestigations = Math.max(0, state.activeInvestigations - 1);
  scheduleIdleShutdownIfNeeded();
}

async function runDeepenNode(caseId, nodeId) {
  const snap = state.cases.get(caseId);
  if (!snap) return;
  const node = snap.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  node.status = "confirmed";
  node.metadata = {
    ...(node.metadata || {}),
    match_tier: "verified",
    match_reason: "Operator confirmed anchor",
  };
  broadcastEvent({ kind: "node", case_id: caseId, node });

  const tor = await detectLocalTor(state.config.tor_socks_url);
  const netCtx = {
    strictAnonymity: Boolean(snap.input.strict_anonymity),
    proxyHost: tor.available ? tor.host : null,
    proxyPort: tor.available ? tor.port : null,
    torEndpoint: tor.available ? tor.endpoint : null,
  };
  if (netCtx.strictAnonymity && !netCtx.proxyHost) return;

  const now = new Date().toISOString();
  const addNode = (n) => {
    const m = upsertNode(snap, n);
    broadcastEvent({ kind: "node", case_id: caseId, node: m });
  };
  const addEdge = (s, t, rel, conf, src) => {
    if (!s || !t || s === t) return;
    const e = upsertEdge(snap, {
      id: `${s}__${rel}__${t}`,
      source: s,
      target: t,
      relation: rel,
      confidence: conf,
      sources: [src],
    });
    broadcastEvent({ kind: "edge", case_id: caseId, edge: e });
  };
  const addFinding = (f) => {
    const m = upsertFinding(snap, f);
    broadcastEvent({ kind: "finding", case_id: caseId, finding: m });
  };

  if (node.kind === "handle" || (node.kind === "account" && normalizePlatformSlug(node.metadata?.platform) === "github")) {
    const h = (node.metadata?.handle || node.label).replace(/^@/, "").replace(/^GitHub\s*\(@?/i, "").replace(/\)$/, "").trim();
    const prof = await probeGithubRawDeep(h, netCtx);
    for (const pe of prof.patch_emails) {
      const emId = normalizeNodeId("email", pe.email);
      addNode({
        id: emId,
        kind: "email",
        label: pe.email,
        sublabel: `Git .patch (${pe.repo})`,
        layer: "deep",
        confidence: 0.94,
        status: "unverified",
        sources: ["deepen-patch"],
        metadata: { match_tier: "verified", match_reason: "Git .patch commit email" },
        url: pe.patch_url,
        depth: node.depth + 1,
      });
      addEdge(nodeId, emId, "commit_email", 0.94, "deepen-patch");
    }
    const hits = await runWmnForHandle(h, snap.input.full_name, [], [], [], true, netCtx, 12);
    for (const hit of hits) {
      const acctId = normalizeAccountNodeId(hit.site_name, hit.handle);
      addNode({
        id: acctId,
        kind: "account",
        label: `${hit.site_name} (@${hit.handle})`,
        sublabel: hit.site_name,
        layer: "deep",
        confidence: Math.min(0.95, hit.confidence + 0.08),
        status: "unverified",
        sources: ["deepen-wmn"],
        metadata: { platform: hit.site_name, handle: hit.handle, match_tier: hit.match_tier, match_reason: hit.match_reason },
        url: hit.url,
        depth: node.depth + 1,
      });
      if (nodeId !== acctId) addEdge(nodeId, acctId, "account_on", 0.82, "deepen-wmn");
      addFinding({
        id: `finding:account:${normalizePlatformSlug(hit.site_name)}:${hit.handle.toLowerCase()}`,
        node_id: acctId,
        title: `${hit.site_name} Account: @${hit.handle}`,
        category: hit.category,
        severity: "low",
        confidence: Math.min(0.95, hit.confidence + 0.08),
        consensus_count: 1,
        sources: ["deepen-wmn"],
        summary: `Confirmed handle pivot verified ${hit.site_name} profile for @${hit.handle}.`,
        pivot_trail: [`Confirmed: @${h}`, `WhatsMyName -> ${hit.site_name}`],
        url: hit.url,
        timestamp: now,
        sensitive_fields: [hit.handle],
      });
    }
  } else if (node.kind === "email") {
    const em = node.label.trim().toLowerCase();
    const localPart = em.split("@")[0];
    if (localPart && localPart.length >= 3) {
      const hits = await runWmnForHandle(localPart, snap.input.full_name, [], [], [em], false, netCtx, 12);
      for (const hit of hits) {
        const acctId = normalizeAccountNodeId(hit.site_name, hit.handle);
        addNode({
          id: acctId,
          kind: "account",
          label: `${hit.site_name} (@${hit.handle})`,
          sublabel: "From Email Local-Part",
          layer: "deep",
          confidence: hit.confidence,
          status: "unverified",
          sources: ["deepen-wmn"],
          metadata: { platform: hit.site_name, handle: hit.handle, match_tier: hit.match_tier, match_reason: hit.match_reason },
          url: hit.url,
          depth: node.depth + 1,
        });
        addEdge(nodeId, acctId, "local_part_account", hit.confidence, "deepen-wmn");
      }
    }
  } else if (node.url) {
    const ext = await extractProfileHtml(node.url, netCtx);
    if (ext) {
      for (const em of ext.emails) {
        const emId = normalizeNodeId("email", em);
        addNode({
          id: emId,
          kind: "email",
          label: em,
          sublabel: "HTML Deep Extract",
          layer: "deep",
          confidence: 0.84,
          status: "unverified",
          sources: ["deepen-html"],
          metadata: { match_tier: "verified", match_reason: "Embedded email in profile body" },
          url: node.url,
          depth: node.depth + 1,
        });
        addEdge(nodeId, emId, "mentions_email", 0.84, "deepen-html");
      }
    }
  }

  const seedNode = snap.nodes.find((n) => n.layer === "seed");
  if (seedNode) ensureGraphIntegrity(snap, seedNode.id);
  snap.stats = computeStats(snap.nodes, snap.findings, snap.tool_runs);
  persistCases();
  broadcastEvent({ kind: "completed", case_id: caseId, summary: snap.stats });
}

function renderDossierHtml(snap, redact) {
  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const mask = (text, sens = []) => {
    if (!redact) return esc(text);
    let out = String(text || "");
    for (const s of sens) {
      if (s && s.length >= 3) out = out.split(s).join("[REDACTED]");
    }
    out = out.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
    return esc(out);
  };
  const rows = snap.findings
    .map(
      (f) =>
        `<tr><td>${esc(f.severity)}</td><td>${esc(f.category)}</td><td>${mask(
          f.title,
          f.sensitive_fields
        )}</td><td>${mask(f.summary, f.sensitive_fields)}</td><td>${esc(
          f.sources.join(", ")
        )}</td></tr>`
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>TAUF Dossier — ${esc(
    snap.input.full_name
  )}</title><style>body{font-family:"IBM Plex Sans",system-ui,sans-serif;background:#121316;color:#ecece9;padding:36px;max-width:1080px;margin:auto}h1{margin:0 0 8px}p{color:#a1a4ac}table{width:100%;border-collapse:collapse;margin-top:24px;font-size:13px}th,td{border-bottom:1px solid rgba(236,236,233,.1);padding:10px;text-align:left;vertical-align:top}th{color:#d99b38}</style></head><body><h1>TAUF Executive Dossier — ${esc(
    snap.input.full_name
  )}</h1><p>${redact ? "REDACTED BRIEF · " : ""}Generated locally (Zero External APIs) · Nodes: ${
    snap.nodes.length
  } · Findings: ${snap.findings.length}</p><table><thead><tr><th>Severity</th><th>Category</th><th>Finding</th><th>Summary</th><th>Sources</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

// ---------------------------------------------------------------------------
// RPC Router + Static dist/ Server
// ---------------------------------------------------------------------------

async function handleRpc(cmd, args = {}) {
  switch (cmd) {
    case "start_investigation": {
      const input = args.input;
      if (!input?.full_name?.trim()) throw new Error("Full Name is required");
      const caseId = crypto.randomUUID();
      const snap = {
        case_id: caseId,
        input,
        created_at: new Date().toISOString(),
        nodes: [],
        edges: [],
        findings: [],
        tool_runs: [],
        stats: {
          total_nodes: 0,
          confirmed_anchors: 0,
          verified_findings: 0,
          low_conf_findings: 0,
          darkweb_hits: 0,
          breach_hits: 0,
          tools_completed: 0,
          tools_total: 0,
        },
      };
      state.cases.set(caseId, snap);
      persistCases();
      void runInvestigation(caseId, input, { ...state.config });
      return caseId;
    }
    case "deepen_node": {
      void runDeepenNode(args.caseId, args.nodeId);
      return null;
    }
    case "set_node_status": {
      const snap = state.cases.get(args.caseId);
      if (!snap) throw new Error("Case not found");
      const node = snap.nodes.find((n) => n.id === args.nodeId);
      if (node) node.status = args.status;
      snap.stats = computeStats(snap.nodes, snap.findings, snap.tool_runs);
      persistCases();
      return snap;
    }
    case "get_case_snapshot": {
      const snap = state.cases.get(args.caseId);
      if (!snap) throw new Error("Case not found");
      return snap;
    }
    case "list_cases": {
      return Array.from(state.cases.values())
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((c) => ({
          case_id: c.case_id,
          full_name: c.input.full_name,
          created_at: c.created_at,
          node_count: c.nodes.length,
          finding_count: c.findings.length,
          darkweb_count: c.stats.darkweb_hits + c.stats.breach_hits,
        }));
    }
    case "purge_case": {
      state.cases.delete(args.caseId);
      persistCases();
      return null;
    }
    case "purge_all_cases": {
      state.cases.clear();
      persistCases();
      return null;
    }
    case "get_environment_status": {
      const tor = await detectLocalTor(state.config.tor_socks_url);
      let exitIp = null;
      if (tor.available) {
        exitIp = await checkTorExitIp(tor.host, tor.port, false);
      }
      const { python_path, sidecar_tools } = probeSidecarTools();
      const hasCustomProxy = Boolean(state.config.proxy_url?.trim());
      return {
        tor_socks_available: tor.available,
        tor_endpoint: tor.endpoint,
        tor_exit_ip: exitIp,
        anonymity_active: tor.available || hasCustomProxy,
        anonymity_mode: tor.available
          ? "tor_socks5h"
          : hasCustomProxy
          ? "custom_proxy"
          : "direct",
        python_path,
        sidecar_tools,
      };
    }
    case "save_auth_config": {
      state.config = {
        tor_socks_url: args.config?.tor_socks_url || "socks5h://127.0.0.1:9050",
        proxy_url: args.config?.proxy_url || null,
        local_corpus_dir: args.config?.local_corpus_dir?.trim() || DEFAULT_CORPUS_DIR,
        custom_onion_seeds: Array.isArray(args.config?.custom_onion_seeds)
          ? args.config.custom_onion_seeds
          : [...DEFAULT_ONION_SEEDS],
      };
      persistConfig();
      return null;
    }
    case "get_auth_config": {
      return state.config;
    }
    case "export_dossier_html": {
      const snap = state.cases.get(args.caseId);
      if (!snap) throw new Error("Case not found");
      return renderDossierHtml(snap, Boolean(args.redact));
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

function openDesktopWindow(url) {
  const profileDir = path.join(DATA_DIR, "edge-app-profile");
  const appArgs = [
    `--app=${url}`,
    "--window-size=1380,860",
    `--user-data-dir=${profileDir}`,
    "--class=TAUFDesktopApp",
    "--app-id=TAUFDesktopApp",
    "--no-first-run",
  ];

  if (process.platform === "win32") {
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const lad = process.env.LOCALAPPDATA || "";
    const browserPaths = [
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      lad ? path.join(lad, "Google", "Chrome", "Application", "chrome.exe") : null,
      path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      lad ? path.join(lad, "BraveSoftware", "Brave-Browser", "Application", "brave.exe") : null,
    ].filter(Boolean);
    const browser = browserPaths.find((p) => fs.existsSync(p));
    if (browser) {
      // Request WindowStyle Normal via hidden PowerShell so browser never inherits SW_HIDE (0)
      const quotedArgs = appArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
      const psCmd = `Start-Process -FilePath '${browser.replace(/'/g, "''")}' -ArgumentList ${quotedArgs} -WindowStyle Normal`;
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psCmd],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.unref();

      const iconScript = path.join(__dirname, "scripts", "apply-taskbar-icon.ps1");
      if (fs.existsSync(iconScript)) {
        const iconChild = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", iconScript],
          { detached: true, stdio: "ignore", windowsHide: true }
        );
        iconChild.unref();
      }
    } else {
      const child = spawn("explorer.exe", [url], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
    }
    return;
  }

  if (process.platform === "darwin") {
    const macBrowsers = [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    const browser = macBrowsers.find((p) => fs.existsSync(p));
    const child = browser
      ? spawn(browser, appArgs, { detached: true, stdio: "ignore" })
      : spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  // Linux / Unix desktop
  const linuxCandidates = ["microsoft-edge", "google-chrome", "chromium", "chromium-browser", "brave-browser"];
  let linuxBrowser = null;
  for (const bin of linuxCandidates) {
    try {
      const r = spawnSync("which", [bin], { encoding: "utf8", timeout: 1500 });
      if (r.status === 0 && r.stdout?.trim()) {
        linuxBrowser = r.stdout.trim().split(/\r?\n/)[0];
        break;
      }
    } catch {
      // ignore
    }
  }
  const child = linuxBrowser
    ? spawn(linuxBrowser, appArgs, { detached: true, stdio: "ignore" })
    : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

  if (reqUrl.pathname === "/__tauf_health__") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        build_id: SERVER_BUILD_ID,
        runtime: "sovereign-local-v5",
        tor_bootstrap: state.torBootstrapPct,
        tor_exit_ip: state.torExitIp,
      })
    );
  }

  if (reqUrl.pathname === "/__tauf_shutdown__" && req.method === "POST") {
    const remote = req.socket?.remoteAddress || "";
    if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, shutting_down: true }));
      setTimeout(() => {
        stopSupervisedTor();
        process.exit(0);
      }, 150);
      return;
    }
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Loopback only" }));
  }

  if (reqUrl.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    state.hasHadSseClient = true;
    cancelIdleShutdown();
    state.sseClients.add(res);
    req.on("close", () => {
      state.sseClients.delete(res);
      scheduleIdleShutdownIfNeeded();
    });
    return;
  }

  if (reqUrl.pathname === "/rpc" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const data = await handleRpc(body.cmd, body.args || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
    return;
  }

  // Static dist/ files
  const safePath = path.normalize(reqUrl.pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(
    DIST_DIR,
    safePath === "/" || safePath === "\\" ? "index.html" : safePath
  );
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, "index.html");
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") {
    const html = fs
      .readFileSync(filePath, "utf8")
      .replace("</head>", `<script>window.__TAUF_LOCAL__ = true;</script></head>`);
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    return res.end(html);
  }
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

async function main() {
  const shouldOpen = process.argv.includes("--open");
  let preferredPort = Number(process.env.TAUF_PORT || 1420);

  // Check if an existing TAUF server is on preferredPort:
  // - If same SERVER_BUILD_ID -> reuse it cleanly!
  // - If stale/older build_id -> request graceful shutdown so we NEVER reuse stale V1/V2!
  try {
    const existing = await fetchDirectWithTimeout(
      `http://127.0.0.1:${preferredPort}/__tauf_health__`,
      {},
      700
    );
    if (existing.ok) {
      const info = await existing.json().catch(() => ({}));
      if (info.build_id === SERVER_BUILD_ID) {
        if (shouldOpen) {
          openDesktopWindow(`http://127.0.0.1:${preferredPort}`);
          await new Promise((r) => setTimeout(r, 450));
        }
        process.exit(0);
      }
      console.log(`[Runtime] Replacing stale server (build_id=${info.build_id || "legacy"}) on port ${preferredPort}...`);
      try {
        await fetchDirectWithTimeout(
          `http://127.0.0.1:${preferredPort}/__tauf_shutdown__`,
          { method: "POST" },
          800
        );
        await new Promise((r) => setTimeout(r, 650));
      } catch {
        // Older server without shutdown endpoint — bind fresh port cleanly!
        preferredPort = 0;
      }
    }
  } catch {
    // not running yet
  }

  // Launch supervised local Tor daemon in the background (non-blocking for fast UI startup,
  // while pre-warming the circuit and caching the live Tor exit IP!)
  void startSupervisedTorIfAvailable().then(async (torInfo) => {
    if (torInfo?.available) {
      const ip = await checkTorExitIp(torInfo.host, torInfo.port, true);
      if (ip) logRuntime(`[Tor] Live anonymized exit IP verified: ${ip}`);
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      server.listen(0, "127.0.0.1");
    } else {
      logRuntime(`[Runtime] Server error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

  server.listen(preferredPort, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : preferredPort;
    const url = `http://127.0.0.1:${port}`;
    logRuntime(`TAUF sovereign V5 runtime (${SERVER_BUILD_ID}) listening on ${url}`);
    if (shouldOpen) openDesktopWindow(url);
  });
}

main();
