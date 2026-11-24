#!/usr/bin/env node
/**
 * TAUF — Integration / Packaging / Build / Static-Regression Suite
 * ================================================================
 * Standalone, dependency-free harness. Prints one PASS / FAIL / WARN line per
 * check, a summary, and exits non-zero when any check FAILs.
 *
 *   node tests/integration/integration.test.mjs
 *   node tests/integration/integration.test.mjs --verbose     # full child output
 *   node tests/integration/integration.test.mjs --only=A,B     # run selected checks
 *   node tests/integration/integration.test.mjs --list         # list check ids
 *
 * Coverage:
 *   A. Static / syntax / audit-fix presence / UI-untouched
 *   B. Python sidecar (probe, malformed payload safety, charset handle handling)
 *   C. Portable packaging (verify-portable, package-portable --help/--dry-run)
 *   D. Frontend typecheck + production build, Rust formatting (env-gated)
 *
 * Design notes
 * ------------
 *  - The suite never mutates app code. `py_compile` may (re)create
 *    `sidecar/__pycache__`; `vite build` rewrites `dist/` — both are expected
 *    build artefacts, not source edits.
 *  - `node` on PATH may be a broken shim in this environment, so every child
 *    process is launched with `process.execPath` and a PATH whose first entry is
 *    the directory of the running node binary (esbuild inside vite spawns "node").
 *  - The sidecar venv interpreter can be blocked by Windows Application Control
 *    (os error 4551). That is treated as WARN (environment), never as PASS.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ paths */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const NODE_BIN = process.execPath;
const NODE_DIR = path.dirname(NODE_BIN);

const VENV_PY = path.join(ROOT, "sidecar", ".venv", "Scripts", "python.exe");
const VENV_PY_POSIX = path.join(ROOT, "sidecar", ".venv", "bin", "python");
const FALLBACK_PY = "C:\\Users\\laksh\\.local\\bin\\python3.12.exe";

const BRIDGE = path.join(ROOT, "sidecar", "bridge.py");
const SERVER = path.join(ROOT, "local-server.mjs");

const RUST_FILES = [
  "src-tauri/src/lib.rs",
  "src-tauri/src/models.rs",
  "src-tauri/src/commands.rs",
  "src-tauri/src/db.rs",
  "src-tauri/src/export.rs",
  "src-tauri/src/engine/mod.rs",
];

/* --------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose") || argv.includes("-v");
const LIST_ONLY = argv.includes("--list");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg
  ? onlyArg
      .slice("--only=".length)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  : null;

/* ----------------------------------------------------------------- helpers */

const results = [];
let currentCheckId = "?";

function pad(s, n) {
  return String(s).padEnd(n, " ");
}

function indent(text, prefix = "        ") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (l.length ? prefix + l : l))
    .join("\n");
}

function firstLines(text, n = 25) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= n) return lines.join("\n");
  return lines.slice(0, n).join("\n") + `\n… (${lines.length - n} more line(s) truncated)`;
}

function shouldRun(id) {
  if (!ONLY) return true;
  const norm = id.toUpperCase();
  return ONLY.some((sel) => norm === sel || norm.startsWith(sel + "."));
}

/**
 * Record + print one result.
 * status: "PASS" | "FAIL" | "WARN" | "SKIP"
 */
function check(id, title, status, detail = "", extra = null) {
  if (!shouldRun(id)) return null;
  const rec = { id, title, status, detail: String(detail || ""), extra, ms: extra?.ms ?? null };
  results.push(rec);
  const line = `[${pad(status, 4)}] ${pad(id, 4)} ${title}`;
  console.log(line);
  if (rec.detail) console.log(indent(rec.detail));
  if (VERBOSE && extra?.stdout) console.log(indent(`--- stdout ---\n${firstLines(extra.stdout, 200)}`, "        | "));
  if (VERBOSE && extra?.stderr) console.log(indent(`--- stderr ---\n${firstLines(extra.stderr, 200)}`, "        | "));
  return rec;
}

function skip(id, title, reason) {
  const rec = { id, title, status: "SKIP", detail: reason, extra: null, ms: null };
  results.push(rec);
  console.log(`[SKIP] ${pad(id, 4)} ${title}`);
  console.log(indent(reason));
  return rec;
}

/* ------------------------------------------------------- process execution */

function buildEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Windows env keys are case-insensitive on lookup but Node forwards them
  // verbatim; set both spellings so the child always sees the good PATH.
  const base = process.env.PATH || process.env.Path || "";
  const prefixed = NODE_DIR + path.delimiter + base;
  env.PATH = prefixed;
  env.Path = prefixed;
  env.TAUF_TEST_NODE = NODE_BIN;
  return env;
}

function run(cmd, args = [], opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: buildEnv(opts.env || {}),
    encoding: "utf8",
    timeout: opts.timeout ?? 120000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    cmd,
    args,
    status: res.status,
    signal: res.signal,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error ? String(res.error.message || res.error) : null,
    errorCode: res.error?.code || null,
    ms: Date.now() - started,
    timedOut: res.error?.code === "ETIMEDOUT" || (res.signal === "SIGTERM" && res.status === null),
  };
}

function runNode(args, opts = {}) {
  return run(NODE_BIN, args, opts);
}

function fmtRun(r) {
  const bits = [`exit=${r.status === null ? "null" : r.status}`, `${r.ms}ms`];
  if (r.signal) bits.push(`signal=${r.signal}`);
  if (r.errorCode) bits.push(`error=${r.errorCode}`);
  return bits.join(" · ");
}

function looksBlocked(r) {
  const blob = `${r.stderr || ""}\n${r.error || ""}`.toLowerCase();
  return (
    /application control|os error 4551|blocked this file|operation did not complete|access is denied/.test(blob) ||
    (r.status === null && !r.timedOut)
  );
}

/* ------------------------------------------------------------- file walking */

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "__pycache__", "target", ".venv", "reports", "tests"]);
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".7z", ".tar", ".exe", ".dll", ".so", ".node", ".wasm",
  ".pdf", ".db", ".sqlite", ".sqlite3", ".pyc", ".pyd", ".lockb",
]);

function walk(absPath, out = []) {
  let st;
  try {
    st = fs.statSync(absPath);
  } catch {
    return out;
  }
  if (st.isFile()) {
    out.push(absPath);
    return out;
  }
  if (!st.isDirectory()) return out;
  if (SKIP_DIRS.has(path.basename(absPath).toLowerCase())) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = path.join(absPath, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walk(child, out);
    } else if (e.isFile()) {
      if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.push(child);
    }
  }
  return out;
}

function readText(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function rel(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

/**
 * Literal, case-insensitive token scan. Returns [{file, line, token, text}].
 */
function scanTokens(files, tokens) {
  const hits = [];
  const lowTokens = tokens.map((t) => ({ token: t, low: t.toLowerCase() }));
  for (const f of files) {
    const text = readText(f);
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const low = lines[i].toLowerCase();
      for (const { token, low: lt } of lowTokens) {
        if (low.includes(lt)) {
          hits.push({ file: rel(f), line: i + 1, token, text: lines[i].trim() });
        }
      }
    }
  }
  return hits;
}

function isCommentLine(line, file) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) return true;
  if (file.endsWith(".py") && t.startsWith("#")) return true;
  if (t.startsWith("#!") || t.startsWith("<!--")) return true;
  if (file.endsWith(".ps1") && t.startsWith("#")) return true;
  if (t.startsWith("--") && (file.endsWith(".sql") || file.endsWith(".lua"))) return true;
  return false;
}

/** Heuristic: the line is a detector regex / parser for user paths, not a path. */
function isPathDetectorLine(line) {
  return /\[A-Za-z\]:|Users\[|\[\^?[^\]]*\\\\\/\]|\\\\Users\\\\|\[\/\\\\\]/.test(line) || /\(\\d\{/.test(line);
}

function shortExcerpt(text, token, width = 110) {
  const idx = text.toLowerCase().indexOf(String(token).toLowerCase());
  if (idx < 0) return text.slice(0, width);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + token.length + 70);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/* --------------------------------------------------------------- python env */

const pyInfo = {
  path: null,
  label: "",
  venvUsable: false,
  venvError: "",
  fallbackUsed: false,
  fallbackError: "",
};

function probePythonCandidate(p) {
  if (!p) return null;
  if (!fs.existsSync(p)) return { ok: false, reason: "not found" };
  const r = run(p, ["-c", "import sys; print(sys.version.split()[0]); print(sys.executable)"], { timeout: 45000 });
  if (r.status === 0) {
    return { ok: true, version: r.stdout.trim().split(/\r?\n/)[0], exe: r.stdout.trim().split(/\r?\n/)[1] || p, raw: r };
  }
  return { ok: false, reason: looksBlocked(r) ? "blocked by Application Control (os error 4551)" : firstLines(r.stderr || r.error || "unknown failure", 3), raw: r };
}

function resolvePython() {
  const venv = fs.existsSync(VENV_PY) ? VENV_PY : fs.existsSync(VENV_PY_POSIX) ? VENV_PY_POSIX : null;
  const venvProbe = probePythonCandidate(venv);
  if (venvProbe?.ok) {
    pyInfo.path = venv;
    pyInfo.label = rel(venv);
    pyInfo.venvUsable = true;
    return;
  }
  pyInfo.venvError = venvProbe?.reason || "venv python not present";

  const candidates = [process.env.TAUF_TEST_PYTHON, FALLBACK_PY, "py", "python3", "python"].filter(Boolean);
  for (const cand of candidates) {
    const p = probePythonCandidate(cand);
    if (p?.ok) {
      pyInfo.path = cand;
      pyInfo.label = cand;
      pyInfo.fallbackUsed = true;
      pyInfo.fallbackVersion = p.version;
      return;
    }
    if (!pyInfo.fallbackError) pyInfo.fallbackError = `${cand}: ${p?.reason || "unusable"}`;
  }
}

/* ================================================================== header */

function readBuildId() {
  try {
    const text = fs.readFileSync(SERVER, "utf8").slice(0, 200000);
    const m = text.match(/SERVER_BUILD_ID\s*=\s*["'`]([^"'`]+)["'`]/);
    return m ? m[1] : "unknown";
  } catch {
    return "unknown";
  }
}

console.log("=".repeat(78));
console.log("TAUF integration / packaging / build / static-regression suite");
console.log("=".repeat(78));
console.log(`  repo root      : ${ROOT}`);
console.log(`  node           : ${process.version}  (${NODE_BIN})`);
console.log(`  platform       : ${process.platform}/${process.arch}`);
console.log(`  server build id: ${readBuildId()}`);
if (ONLY) console.log(`  filter         : ${ONLY.join(", ")}`);
console.log("");

if (LIST_ONLY) {
  const ids = [
    "A1 node --check local-server.mjs",
    "A2 python -m py_compile bridge.py",
    "A3 forbidden external OSINT API audit",
    "A4 hardcoded user-path audit",
    "A5 audit-fix presence (server + bridge)",
    "A6 UI untouched (git status src, src-tauri/src)",
    "B7 bridge.py --probe (7 tools)",
    "B8 malformed payload safety (list payload)",
    "B9 string 'handles' not split into chars",
    "C10 verify-portable.mjs",
    "C11 package-portable.mjs --help",
    "C12 package-portable.mjs --dry-run",
    "C13 node --check packaging scripts",
    "D14 tsc --noEmit",
    "D15 vite build",
    "D16 rustfmt --check (6 files)",
  ];
  for (const id of ids) console.log("  " + id);
  process.exit(0);
}

resolvePython();
console.log(`  sidecar python : ${pyInfo.path || "(none)"}${pyInfo.fallbackUsed ? "  [FALLBACK — venv blocked]" : ""}`);
if (pyInfo.fallbackUsed) console.log(`                    venv: ${pyInfo.venvError}`);
console.log("");

/* =========================================================== A. STATIC ==== */

/* A1 */
if (shouldRun("A1")) {
  const r = runNode(["--check", "local-server.mjs"], { timeout: 120000 });
  check(
    "A1",
    "node --check local-server.mjs",
    r.status === 0 ? "PASS" : "FAIL",
    `${fmtRun(r)}${r.status === 0 ? "" : "\n" + indent(firstLines(r.stderr || r.stdout, 20))}`,
    r,
  );
}

/* A2 */
if (shouldRun("A2")) {
  if (!pyInfo.path) {
    check("A2", "python -m py_compile sidecar/bridge.py", "FAIL", "no usable python interpreter found");
  } else {
    const r = run(pyInfo.path, ["-m", "py_compile", "sidecar/bridge.py"], { timeout: 120000 });
    check(
      "A2",
      `python -m py_compile sidecar/bridge.py (${pyInfo.fallbackUsed ? "fallback python" : "venv python"})`,
      r.status === 0 ? "PASS" : "FAIL",
      `${fmtRun(r)}${pyInfo.fallbackUsed ? `  [venv blocked: ${pyInfo.venvError}]` : ""}${
        r.status === 0 ? "" : "\n" + indent(firstLines(r.stderr, 20))
      }`,
      r,
    );
  }
}

/* A3 — forbidden external OSINT SaaS APIs */
const FORBIDDEN_APIS = [
  "api.github.com",
  "api.gitlab.com",
  "crt.sh",
  "haveibeenpwned",
  "dehashed",
  "hibp",
  "hunter.io",
  "shodan",
  "censys",
  "intelx",
  "leakcheck",
  "snusbase",
  "breachdirectory",
  "peopledatalabs",
  "rocketreach",
  "clearbit",
  "fullcontact",
  "pipl",
  "virustotal",
  "urlscan",
  "securitytrails",
  "whoisxml",
  "abstractapi",
  "numverify",
  "serpapi",
  "RapidAPI",
];

const AUDIT_TARGETS = [
  "src",
  "src-tauri/src",
  "local-server.mjs",
  "sidecar/bridge.py",
  "src-tauri/resources/wmn_curated.json",
];

function auditFiles() {
  const files = [];
  for (const target of AUDIT_TARGETS) {
    const abs = path.join(ROOT, target);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, files);
    else files.push(abs);
  }
  return files;
}

if (shouldRun("A3")) {
  const files = auditFiles();
  const hits = scanTokens(files, FORBIDDEN_APIS);
  const unique = [...new Map(hits.map((h) => [`${h.file}:${h.line}`, h])).values()];
  check(
    "A3",
    `forbidden external OSINT API audit (${files.length} files scanned)`,
    unique.length === 0 ? "PASS" : "FAIL",
    unique.length === 0
      ? `0 hits across ${AUDIT_TARGETS.join(", ")} for ${FORBIDDEN_APIS.length} forbidden tokens`
      : `${unique.length} hit(s):\n` +
        indent(unique.map((h) => `${h.file}:${h.line}  [${h.token}]  ${shortExcerpt(h.text, h.token)}`).join("\n")),
    { hits: unique },
  );
}

/* A4 — hardcoded user paths */
if (shouldRun("A4")) {
  const files = [
    ...walk(path.join(ROOT, "src")),
    ...walk(path.join(ROOT, "src-tauri", "src")),
    ...walk(path.join(ROOT, "scripts")),
    SERVER,
    BRIDGE,
    path.join(ROOT, "launch-tauf.cmd"),
    path.join(ROOT, "launch-tauf.vbs"),
    path.join(ROOT, "launch-tauf.sh"),
  ].filter((f) => fs.existsSync(f));

  const PATTERNS = ["C:\\Users\\", "/home/", "laksh"];
  const rawHits = scanTokens(files, PATTERNS);

  // De-duplicate per (file,line,pattern) — a line can contain several patterns.
  const seen = new Set();
  const deduped = [];
  for (const h of rawHits) {
    const key = `${h.file}:${h.line}:${h.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
  }

  const annotated = deduped.map((h) => {
    let cls = "app-code";
    if (isCommentLine(h.text, h.file)) cls = "comment";
    else if (isPathDetectorLine(h.text)) cls = "detector-regex";
    else if (/placeholder\s*=/.test(h.text)) cls = "ui-placeholder";
    return { ...h, cls };
  });

  // UI placeholder examples (e.g. "C:\\Users\\analyst\\...") are illustrative, not
  // executable hardcoded paths. Only real app/launcher lines are violations.
  const violations = annotated.filter((h) => h.cls === "app-code");
  const excluded = annotated.filter(
    (h) => h.cls === "comment" || h.cls === "detector-regex" || h.cls === "ui-placeholder"
  );

  const lines = [];
  if (violations.length) {
    lines.push(`${violations.length} non-comment hit(s) in ${files.length} app files:`);
    lines.push(
      indent(
        violations
          .map((h) => `${h.file}:${h.line}  [${h.token}]  classify=${h.cls}  ${shortExcerpt(h.text, h.token)}`)
          .join("\n"),
      ),
    );
  } else {
    lines.push(`0 non-comment hits in ${files.length} app files (patterns: C:\\Users\\, /home/, laksh)`);
  }
  if (excluded.length) {
    lines.push(`excluded ${excluded.length} comment/detector line(s):`);
    lines.push(
      indent(
        excluded.map((h) => `${h.file}:${h.line}  [${h.token}]  classify=${h.cls}  ${shortExcerpt(h.text, h.token, 90)}`).join("\n"),
      ),
    );
  }

  check(
    "A4",
    "hardcoded user-path audit (C:\\Users\\, /home/, laksh)",
    violations.length === 0 ? "PASS" : "FAIL",
    lines.join("\n"),
    { violations, excluded },
  );
}

/* A5 — audit-fix presence */
if (shouldRun("A5")) {
  const serverText = readText(SERVER) || "";
  const bridgeText = readText(BRIDGE) || "";

  const serverTokens = [
    "replyBuf",
    "nameEvidence",
    "quarantined",
    "redactProxyUrl",
    "isUnsafeCorpusRoot",
    "getConfiguredOnionBases",
    "scanLocalCorpus",
    "createReadStream",
    "readline",
    "fsyncSync",
  ];
  const bridgeTokens = ["as_completed", "sidecar_budget_ms"];

  const missing = [];
  const present = [];
  for (const t of serverTokens) {
    const n = serverText.split(t).length - 1;
    if (n === 0) missing.push(`local-server.mjs: ${t}`);
    else present.push(`local-server.mjs: ${t} (${n}x)`);
  }
  for (const t of bridgeTokens) {
    const n = bridgeText.split(t).length - 1;
    if (n === 0) missing.push(`sidecar/bridge.py: ${t}`);
    else present.push(`sidecar/bridge.py: ${t} (${n}x)`);
  }

  // to_httpx_socks5 must preserve socks5h (remote DNS) — extract the def block.
  let socksBlock = "";
  const sIdx = bridgeText.indexOf("def to_httpx_socks5");
  if (sIdx >= 0) socksBlock = bridgeText.slice(sIdx, bridgeText.indexOf("\ndef ", sIdx + 10) > 0 ? bridgeText.indexOf("\ndef ", sIdx + 10) : sIdx + 900);
  const preservesSocks5h =
    socksBlock.includes("socks5h://") &&
    /if s\.startswith\("socks5h:\/\/"\):\s*\n\s*return s/.test(socksBlock) &&
    !/socks5h:\/\/"?\s*,\s*"socks5:\/\/"/.test(socksBlock);
  if (preservesSocks5h) present.push("sidecar/bridge.py: to_httpx_socks5 preserves socks5h:// (remote DNS)");
  else missing.push("sidecar/bridge.py: to_httpx_socks5 socks5h:// preservation");

  // scanLocalCorpus must be async and stream (createReadStream + readline).
  const scanIdx = serverText.indexOf("async function scanLocalCorpus");
  const scanBody = scanIdx >= 0 ? serverText.slice(scanIdx, scanIdx + 4000) : "";
  const streams =
    scanIdx >= 0 && scanBody.includes("createReadStream") && scanBody.includes("readline.createInterface");
  if (streams) present.push("local-server.mjs: scanLocalCorpus streams via createReadStream + readline");
  else missing.push("local-server.mjs: scanLocalCorpus streaming (createReadStream + readline)");

  check(
    "A5",
    "audit-fix presence (SOCKS reply framing, accuracy, collision, redaction, corpus, onion base)",
    missing.length === 0 ? "PASS" : "FAIL",
    missing.length === 0
      ? `all ${present.length} markers present:\n` + indent(present.join("\n"))
      : `missing markers:\n` + indent(missing.join("\n")) + "\n" + indent("present:\n" + present.join("\n")),
    { present, missing },
  );
}

/* A6 — UI untouched */
if (shouldRun("A6")) {
  const gitRoot = run("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 30000 });
  if (gitRoot.status !== 0) {
    check("A6", "UI untouched (git status src, src-tauri/src)", "WARN", `git unavailable or not a repo:\n${indent(firstLines(gitRoot.stderr, 5))}`, gitRoot);
  } else {
    const r = run("git", ["status", "--short", "--", "src", "src-tauri/src"], { timeout: 60000 });
    const body = r.stdout.replace(/^\uFEFF/, "").trim();
    check(
      "A6",
      "UI untouched (git status --short -- src src-tauri/src)",
      r.status !== 0 ? "FAIL" : body === "" ? "PASS" : "FAIL",
      r.status !== 0
        ? `git status failed (${fmtRun(r)})\n${indent(firstLines(r.stderr, 10))}`
        : body === ""
          ? "empty output — no working-tree changes under src/ or src-tauri/src/"
          : `unexpected changes:\n${indent(body)}`,
      r,
    );
  }
}

/* ========================================================== B. SIDECAR ==== */

let probeTools = null;

/* B7 */
if (shouldRun("B7")) {
  const EXPECTED = ["maigret", "sherlock", "socid-extractor", "holehe", "ignorant", "h8mail", "onionsearch"];
  if (!pyInfo.path) {
    check("B7", "bridge.py --probe → 7 tools", "FAIL", "no usable python interpreter found");
  } else {
    const r = run(pyInfo.path, [BRIDGE, "--probe"], { timeout: 90000 });
    let parsed = null;
    let parseErr = "";
    try {
      parsed = JSON.parse(r.stdout.trim());
    } catch (e) {
      parseErr = String(e.message);
    }

    if (r.status !== 0 || !Array.isArray(parsed)) {
      check(
        "B7",
        "bridge.py --probe → 7 tools",
        "FAIL",
        `probe did not emit a JSON array (${fmtRun(r)})${parseErr ? `\nparse error: ${parseErr}` : ""}\n${indent(
          firstLines(r.stdout || r.stderr, 15),
        )}`,
        r,
      );
    } else {
      probeTools = parsed;
      const names = parsed.map((t) => t.name);
      const missing = EXPECTED.filter((n) => !names.includes(n));
      const extra = names.filter((n) => !EXPECTED.includes(n));
      const shapeOk =
        parsed.length === 7 &&
        missing.length === 0 &&
        extra.length === 0 &&
        parsed.every((t) => typeof t.installed === "boolean" && t.category && t.mode && t.install_hint);

      const installed = parsed.filter((t) => t.installed);
      const installedDetail = `${installed.length}/7 report installed=true${installed.length ? ` (${installed.map((t) => t.name).join(", ")})` : ""}`;

      // Prove whether the modules are actually importable in the interpreter we used.
      const modMap = {
        maigret: "maigret",
        sherlock: "sherlock_project",
        "socid-extractor": "socid_extractor",
        holehe: "holehe",
        ignorant: "ignorant",
        h8mail: "h8mail",
        onionsearch: "onionsearch",
      };
      const importProbe = run(
        pyInfo.path,
        [
          "-c",
          "import importlib.util,json,sys;" +
            "mods=" +
            JSON.stringify(EXPECTED.map((n) => modMap[n])) +
            ";print(json.dumps({m:(importlib.util.find_spec(m) is not None) for m in mods}))",
        ],
        { timeout: 60000 },
      );
      let importable = null;
      try {
        importable = JSON.parse(importProbe.stdout.trim());
      } catch {
        importable = null;
      }
      const importableCount = importable ? Object.values(importable).filter(Boolean).length : null;

      let detail = `${fmtRun(r)}\nexactly 7 tools: ${names.join(", ")}\n${installedDetail}`;
      if (importable) detail += `\nmodules importable by ${pyInfo.label}: ${importableCount}/7`;

      let status;
      if (!shapeOk) {
        status = "FAIL";
        detail += `\ninventory mismatch → missing: [${missing.join(", ")}] extra: [${extra.join(", ")}] len=${parsed.length}`;
      } else if (pyInfo.venvUsable) {
        status = installed.length === 7 ? "PASS" : "FAIL";
      } else if (installed.length === 7 && importableCount === 0) {
        status = "WARN";
        detail +=
          "\nWARN (environment): sidecar/.venv python is blocked by Windows Application Control (os error 4551)." +
          "\n  Probed with the fallback interpreter. `installed=true` comes from bridge.py prepending" +
          "\n  sidecar/.venv/Scripts to PATH (CLI .exe shims exist), but the 7 modules are NOT importable" +
          "\n  by the fallback interpreter → tool execution cannot be verified in this environment." +
          "\n  Re-run with a usable venv to convert this to PASS/FAIL.";
      } else {
        status = "WARN";
        detail += "\nWARN (environment): venv blocked; probe/import results cannot be trusted.";
      }

      check("B7", "bridge.py --probe → 7 tools", status, detail, { ...r, probe: parsed, importable });
    }
  }
}

/* B8 — malformed (non-object) payload safety */
if (shouldRun("B8")) {
  const r = run(pyInfo.path, [BRIDGE, "--run", "--payload", '["x"]'], { timeout: 90000 });
  const stderr = r.stderr || "";
  const crashed = /AttributeError|Traceback \(most recent call last\)|TypeError|KeyError/.test(stderr);
  const emittedJson = r.stdout.split(/\r?\n/).some((l) => {
    try {
      const o = JSON.parse(l);
      return o && typeof o === "object" && (o.kind || o.status || o.error);
    } catch {
      return false;
    }
  });
  const ok = !crashed && (r.status === 0 || emittedJson);
  check(
    "B8",
    'malformed payload safety: --run --payload \'["x"]\'',
    ok ? "PASS" : "FAIL",
    `${fmtRun(r)}\n${crashed ? "uncaught exception (no type guard on payload):\n" : ""}${indent(firstLines(stderr || r.stdout, 12))}`,
    r,
  );
}

/* B9 — string "handles" must not be iterated character-by-character */
if (shouldRun("B9")) {
  const r = run(pyInfo.path, [BRIDGE, "--run", "--payload", '{"handles":"alice"}'], { timeout: 120000 });
  const events = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* ignore non-JSON output */
    }
  }
  const details = events.filter((e) => typeof e.detail === "string").map((e) => e.detail);
  const handleMentions = new Set();
  for (const d of details) {
    for (const m of d.matchAll(/@([A-Za-z0-9_.\-]+)/g)) handleMentions.add(m[1]);
  }
  const singleChar = [...handleMentions].filter((h) => h.length === 1);
  const observed = details.filter((d) => /handle|profile check|across \d+ sites/i.test(d)).slice(0, 6);

  const buggy = singleChar.length > 0;
  check(
    "B9",
    'string payload --payload \'{"handles":"alice"}\' must be ONE handle',
    buggy ? "FAIL" : "PASS",
    `${fmtRun(r)}\n` +
      (buggy
        ? `observed per-character handles: ${singleChar.map((c) => `@${c}`).join(", ")} (expected exactly "@alice")\n`
        : `observed handle mentions: ${[...handleMentions].map((h) => "@" + h).join(", ") || "(none)"}\n`) +
      (observed.length ? `tool details:\n${indent(observed.join("\n"))}` : "no tool detail lines"),
    { ...r, events },
  );
}

/* ======================================================== C. PACKAGING ==== */

/* C10 */
if (shouldRun("C10")) {
  const r = runNode(["scripts/verify-portable.mjs"], { timeout: 180000 });
  const plateau = (r.stdout || "").replace(/\r\n/g, "\n");
  const summaryLines = plateau
    .split("\n")
    .filter((l) => /^(REQUIRED:|OPTIONAL:|VERDICT:)/.test(l.trim()))
    .map((l) => l.trim());
  const warnLines = plateau
    .split("\n")
    .filter((l) => /\bWARN\b/.test(l) && !/^\s*-----/.test(l))
    .map((l) => l.trim().replace(/\s+/g, " "));
  check(
    "C10",
    "node scripts/verify-portable.mjs",
    r.status === 0 ? "PASS" : "FAIL",
    `${fmtRun(r)}\n${summaryLines.length ? indent(summaryLines.join("\n")) : indent(firstLines(r.stdout, 20))}` +
      (warnLines.length ? `\nWARN rows:\n${indent(warnLines.join("\n"))}` : ""),
    r,
  );
}

/* C11 */
if (shouldRun("C11")) {
  const r = runNode(["scripts/package-portable.mjs", "--help"], { timeout: 60000 });
  const hasUsage = /Usage:/i.test(r.stdout || "") && /--dry-run/.test(r.stdout || "");
  check(
    "C11",
    "node scripts/package-portable.mjs --help",
    r.status === 0 && hasUsage ? "PASS" : "FAIL",
    `${fmtRun(r)}${hasUsage ? " · usage text present, --dry-run documented" : " · usage text missing"}`,
    r,
  );
}

/* C12 */
if (shouldRun("C12")) {
  const r = runNode(["scripts/package-portable.mjs", "--dry-run"], { timeout: 180000 });
  const out = (r.stdout || "").replace(/\r\n/g, "\n");
  const total = out.split("\n").find((l) => /^\s*TOTAL\s+\d+/.test(l));
  const done = out.split("\n").find((l) => /DRY RUN complete/i.test(l));
  const planOk = Boolean(total && done);
  check(
    "C12",
    "node scripts/package-portable.mjs --dry-run",
    r.status === 0 && planOk ? "PASS" : "FAIL",
    `${fmtRun(r)}\n${planOk ? `manifest: ${total.trim().replace(/\s+/g, " ")}\n${done.trim()}` : indent(firstLines(r.stdout || r.stderr, 20))}`,
    r,
  );
}

/* C13 */
if (shouldRun("C13")) {
  const a = runNode(["--check", "scripts/verify-portable.mjs"], { timeout: 60000 });
  const b = runNode(["--check", "scripts/package-portable.mjs"], { timeout: 60000 });
  const ok = a.status === 0 && b.status === 0;
  check(
    "C13",
    "node --check scripts/{verify-portable,package-portable}.mjs",
    ok ? "PASS" : "FAIL",
    `verify-portable.mjs: ${fmtRun(a)}\npackage-portable.mjs: ${fmtRun(b)}${
      ok ? "" : "\n" + indent(firstLines(a.stderr || b.stderr, 20))
    }`,
    { a, b },
  );
}

/* ========================================================= D. BUILD ======= */

/* D14 */
if (shouldRun("D14")) {
  const r = runNode(["node_modules/typescript/bin/tsc", "--noEmit"], { timeout: 240000 });
  check(
    "D14",
    "tsc --noEmit (strict typecheck)",
    r.status === 0 ? "PASS" : "FAIL",
    `${fmtRun(r)}${r.status === 0 ? " · 0 type errors" : "\n" + indent(firstLines(r.stdout || r.stderr, 20))}`,
    r,
  );
}

/* D15 */
if (shouldRun("D15")) {
  const r = runNode(["node_modules/vite/bin/vite.js", "build"], { timeout: 300000 });
  const out = (r.stdout || "").replace(/\r\n/g, "\n");
  const built = out.split("\n").find((l) => /built in [\d.]+s/.test(l));
  const modules = out.split("\n").find((l) => /modules transformed/.test(l));
  const distIdx = (() => {
    try {
      return fs.statSync(path.join(ROOT, "dist", "index.html")).mtime.toISOString();
    } catch {
      return "missing";
    }
  })();
  check(
    "D15",
    "vite build (production)",
    r.status === 0 ? "PASS" : "FAIL",
    `${fmtRun(r)}\n${r.status === 0 ? `${(modules || "").trim()}\n${(built || "").trim()}\ndist/index.html mtime: ${distIdx}` : indent(firstLines(r.stdout || r.stderr, 20))}`,
    r,
  );
}

/* D16 — rustfmt */
if (shouldRun("D16")) {
  const version = run("rustfmt", ["--version"], { timeout: 30000 });
  if (version.status !== 0 || looksBlocked(version)) {
    const cargoVersion = run("cargo", ["--version"], { timeout: 30000 });
    check(
      "D16",
      "rustfmt --edition 2021 --check (6 files)",
      "WARN",
      `rustfmt unavailable — skipped (environment):\n${indent(firstLines(version.stderr || version.error || "not found", 5))}` +
        `\ncargo: ${cargoVersion.status === 0 ? cargoVersion.stdout.trim() : "unavailable"}` +
        `\nRust formatting is NOT verified by this run.`,
      version,
    );
  } else {
    const r = run("rustfmt", ["--edition", "2021", "--check", ...RUST_FILES], { timeout: 120000 });
    check(
      "D16",
      `rustfmt --edition 2021 --check (${RUST_FILES.length} files)`,
      r.status === 0 ? "PASS" : "FAIL",
      `${fmtRun(r)}\n${r.status === 0 ? RUST_FILES.join(", ") : indent(firstLines(r.stdout || r.stderr, 30))}`,
      r,
    );
  }
}

/* ============================================================== SUMMARY == */

const counts = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

console.log("");
console.log("=".repeat(78));
console.log(
  `SUMMARY  PASS=${counts.PASS}  FAIL=${counts.FAIL}  WARN=${counts.WARN}  SKIP=${counts.SKIP}  (total ${results.length})`,
);
if (counts.FAIL) {
  console.log("FAILED CHECKS:");
  for (const r of results.filter((x) => x.status === "FAIL")) console.log(`  ${r.id}  ${r.title}`);
}
if (counts.WARN) {
  console.log("WARNINGS (environment / unverified, not hard failures):");
  for (const r of results.filter((x) => x.status === "WARN")) console.log(`  ${r.id}  ${r.title}`);
}
console.log(counts.FAIL ? "VERDICT: INTEGRATION GATES FAILED" : "VERDICT: ALL EXECUTED GATES PASSED");
console.log("=".repeat(78));

/* Machine-readable sidecar output for the report (kept beside the test). */
try {
  const jsonPath = path.join(HERE, "last-run.json");
  const payload = {
    generated_at: new Date().toISOString(),
    root: ROOT,
    node: { version: process.version, exe: NODE_BIN },
    platform: `${process.platform}/${process.arch}`,
    python: { used: pyInfo.path, label: pyInfo.label, venv_usable: pyInfo.venvUsable, venv_error: pyInfo.venvError, fallback: pyInfo.fallbackUsed },
    counts,
    checks: results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      detail: r.detail,
      ms: r.extra?.ms ?? null,
      exit: r.extra && "status" in r.extra ? r.extra.status : null,
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`machine-readable summary: ${path.relative(ROOT, jsonPath)}`);
} catch (e) {
  console.log(`(could not write last-run.json: ${e.message})`);
}

process.exit(counts.FAIL > 0 ? 1 : 0);
