#!/usr/bin/env node
/**
 * TAUF Portable Folder Verifier
 * -----------------------------
 * Read-only, dependency-free check that everything required to RUN TAUF is
 * contained inside this single folder.
 *
 *   node scripts/verify-portable.mjs            (human-readable table)
 *   node scripts/verify-portable.mjs --json     (machine-readable summary)
 *   node scripts/verify-portable.mjs --help
 *
 * Exit codes:
 *   0  all REQUIRED checks passed (OPTIONAL warnings allowed)
 *   1  at least one REQUIRED check failed
 *   2  bad usage
 *
 * Nothing is installed, downloaded, started or modified. Tor / sidecar probes
 * are bounded so the script finishes quickly even on a cold machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const ARGV = process.argv.slice(2);
const JSON_MODE = ARGV.includes("--json");
const HELP = ARGV.includes("--help") || ARGV.includes("-h");

const PROBE_TIMEOUT_MS = 30_000;
const EXPECTED_TOOLS = [
  "maigret",
  "sherlock",
  "socid-extractor",
  "holehe",
  "ignorant",
  "h8mail",
  "onionsearch",
];

if (HELP) {
  console.log(`TAUF portable folder verifier

Usage:
  node scripts/verify-portable.mjs [--json] [--help]

Checks Node >= 18, app entry points, dist/ build, node_modules, the Python
sidecar venv + 7 wired tools, the WMN curated catalog, launchers, static
assets and Tor discovery.

REQUIRED failures exit 1. OPTIONAL findings (dist/, node_modules, venv tools,
Tor) only warn.
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ utils */

const rows = [];

/** kind: "REQUIRED" | "OPTIONAL" */
function add(kind, status, item, detail) {
  rows.push({ kind, status, item, detail: detail ?? "" });
}

const pass = (kind, item, detail) => add(kind, "PASS", item, detail);
const fail = (kind, item, detail) => add(kind, "FAIL", item, detail);
const warn = (kind, item, detail) => add(kind, "WARN", item, detail);

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function statOf(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel));
  } catch {
    return null;
  }
}

function rel(p) {
  return path.relative(ROOT, p) || ".";
}

function isInside(parent, child) {
  const r = path.relative(parent, child);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function dirSize(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) {
        files += 1;
        bytes += st.size;
      }
    }
  }
  return { files, bytes };
}

function runQuiet(cmd, args, timeoutMs) {
  try {
    return spawnSync(cmd, args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    return { error: err, status: null, stdout: "", stderr: "" };
  }
}

/* ------------------------------------------------------- required checks */

// 1. Node runtime
{
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= 18) {
    pass("REQUIRED", "Node.js >= 18", `v${process.versions.node} (${process.execPath})`);
  } else {
    fail("REQUIRED", "Node.js >= 18", `found v${process.versions.node} — upgrade Node.js`);
  }
}

// 2. Entry points
for (const file of ["package.json", "index.html", "local-server.mjs", "package-lock.json"]) {
  const st = statOf(file);
  if (st && st.isFile()) pass("REQUIRED", file, humanSize(st.size));
  else fail("REQUIRED", file, "missing");
}

// package.json sanity (name + type: module)
{
  const st = statOf("package.json");
  if (st) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
      if (pkg.name === "tauf" && pkg.type === "module") {
        pass("REQUIRED", "package.json identity", `name=${pkg.name} type=${pkg.type} v${pkg.version ?? "?"}`);
      } else {
        warn("REQUIRED", "package.json identity", `unexpected name/type (${pkg.name}/${pkg.type})`);
      }
    } catch (err) {
      fail("REQUIRED", "package.json identity", `invalid JSON: ${err.message}`);
    }
  }
}

// 3. Production build (dist/) — prebuilt UI served by local-server.mjs
{
  const distIndex = statOf(path.join("dist", "index.html"));
  if (distIndex) {
    const { files, bytes } = dirSize(path.join(ROOT, "dist"));
    pass("REQUIRED", "dist/index.html", `${files} files, ${humanSize(bytes)} (prebuilt UI served by local-server.mjs)`);
  } else {
    warn("REQUIRED", "dist/index.html", "missing — run `npm run build` (or ship dist/)");
  }
}

// 4. Launchers
for (const launcher of ["launch-tauf.cmd", "launch-tauf.vbs", "launch-tauf.sh"]) {
  const st = statOf(launcher);
  if (st && st.isFile()) pass("REQUIRED", launcher, humanSize(st.size));
  else fail("REQUIRED", launcher, "missing");
}

// 5. Static assets + icon helper
{
  const pubDir = path.join(ROOT, "public");
  if (fs.existsSync(pubDir) && fs.statSync(pubDir).isDirectory()) {
    const entries = fs.readdirSync(pubDir);
    const required = ["favicon.ico", "logo.svg", "manifest.webmanifest"];
    const missing = required.filter((f) => !entries.includes(f));
    if (missing.length === 0) pass("REQUIRED", "public/", `${entries.length} assets`);
    else warn("REQUIRED", "public/", `present but missing ${missing.join(", ")}`);
  } else {
    fail("REQUIRED", "public/", "missing (favicon/logo/manifest)");
  }

  const icon = statOf(path.join("scripts", "apply-taskbar-icon.ps1"));
  if (icon) pass("REQUIRED", "scripts/apply-taskbar-icon.ps1", humanSize(icon.size));
  else fail("REQUIRED", "scripts/apply-taskbar-icon.ps1", "missing (taskbar icon stamp is skipped, not fatal at runtime)");
}

// 6. WMN curated catalog
{
  const wmnPath = path.join(ROOT, "src-tauri", "resources", "wmn_curated.json");
  if (!fs.existsSync(wmnPath)) {
    fail("REQUIRED", "src-tauri/resources/wmn_curated.json", "missing (wmn-native engine disabled)");
  } else {
    try {
      const raw = fs.readFileSync(wmnPath, "utf8");
      const parsed = JSON.parse(raw);
      const sites = Array.isArray(parsed?.sites)
        ? parsed.sites.length
        : Array.isArray(parsed)
        ? parsed.length
        : Array.isArray(parsed?.definitions)
        ? parsed.definitions.length
        : null;
      pass(
        "REQUIRED",
        "src-tauri/resources/wmn_curated.json",
        `valid JSON, ${humanSize(raw.length)}${sites !== null ? `, ${sites} sites` : ""}`
      );
    } catch (err) {
      fail("REQUIRED", "src-tauri/resources/wmn_curated.json", `invalid JSON: ${err.message}`);
    }
  }
}

// 7. Python sidecar bridge source
{
  const bridge = statOf(path.join("sidecar", "bridge.py"));
  const reqs = statOf(path.join("sidecar", "requirements.txt"));
  if (bridge) pass("REQUIRED", "sidecar/bridge.py", humanSize(bridge.size));
  else fail("REQUIRED", "sidecar/bridge.py", "missing (all 7 Python sidecar tools unavailable)");
  if (reqs) pass("REQUIRED", "sidecar/requirements.txt", humanSize(reqs.size));
  else warn("REQUIRED", "sidecar/requirements.txt", "missing — cannot rebuild sidecar/.venv");
}

/* ------------------------------------------------------- optional checks */

// 8. node_modules + key dependencies (needed to rebuild dist/, not to launch)
{
  const nm = path.join(ROOT, "node_modules");
  if (!fs.existsSync(nm)) {
    warn("OPTIONAL", "node_modules/", "missing — app still launches from dist/, but `npm run build`/`vite` will fail");
  } else {
    const { files, bytes } = dirSize(nm);
    pass("OPTIONAL", "node_modules/", `${files} files, ${humanSize(bytes)}`);
    const keyDeps = ["react", "react-dom", "cytoscape", "@tauri-apps/api"];
    const devDeps = ["vite", "typescript", "@vitejs/plugin-react"];
    const missingKey = keyDeps.filter((d) => !fs.existsSync(path.join(nm, d)));
    const missingDev = devDeps.filter((d) => !fs.existsSync(path.join(nm, d)));
    if (missingKey.length === 0) pass("OPTIONAL", "runtime deps", keyDeps.join(", "));
    else warn("OPTIONAL", "runtime deps", `missing: ${missingKey.join(", ")} (irrelevant if dist/ is shipped)`);
    if (missingDev.length === 0) pass("OPTIONAL", "dev deps", devDeps.join(", "));
    else warn("OPTIONAL", "dev deps", `missing: ${missingDev.join(", ")} (build-only)`);
  }
}

// 9. sidecar/.venv
const venvPython = IS_WIN
  ? path.join(ROOT, "sidecar", ".venv", "Scripts", "python.exe")
  : path.join(ROOT, "sidecar", ".venv", "bin", "python3");
{
  if (fs.existsSync(venvPython)) {
    const v = runQuiet(venvPython, ["-c", "import sys; print(sys.version.split()[0])"], 10_000);
    const ver = (v.stdout || "").trim();
    pass("OPTIONAL", "sidecar/.venv python", `${rel(venvPython)}${ver ? ` (Python ${ver})` : ""}`);
  } else {
    warn(
      "OPTIONAL",
      "sidecar/.venv python",
      `missing (${rel(venvPython)}) — run \`node scripts/setup.mjs\`; 7 Python tools unavailable`
    );
  }
}

// 10. sidecar probe (7 wired tools)
{
  const bridge = path.join(ROOT, "sidecar", "bridge.py");
  if (!fs.existsSync(venvPython) || !fs.existsSync(bridge)) {
    warn("OPTIONAL", "sidecar --probe", "skipped (venv or bridge.py missing)");
  } else {
    const r = runQuiet(venvPython, [bridge, "--probe"], PROBE_TIMEOUT_MS);
    const timedOut = r.error && (r.error.code === "ETIMEDOUT" || r.signal === "SIGTERM");
    if (timedOut) {
      warn("OPTIONAL", "sidecar --probe", `timed out after ${PROBE_TIMEOUT_MS / 1000}s (cold start or bridge.py being edited) — re-run later`);
    } else if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || r.error?.message || "unknown error").trim().split(/\r?\n/)[0];
      warn("OPTIONAL", "sidecar --probe", `exit ${r.status}: ${msg.slice(0, 120)}`);
    } else {
      let tools = null;
      try {
        tools = JSON.parse((r.stdout || "").trim());
      } catch {
        tools = null;
      }
      if (!Array.isArray(tools)) {
        warn("OPTIONAL", "sidecar --probe", "output was not a JSON array");
      } else {
        const installed = tools.filter((t) => t && t.installed).map((t) => t.name);
        const missing = tools.filter((t) => !t || !t.installed).map((t) => (t && t.name) || "?");
        const unknown = EXPECTED_TOOLS.filter((n) => !tools.some((t) => t && t.name === n));
        if (tools.length === EXPECTED_TOOLS.length && missing.length === 0 && unknown.length === 0) {
          pass("OPTIONAL", "sidecar --probe", `${installed.length}/${EXPECTED_TOOLS.length} wired tools installed`);
        } else {
          warn(
            "OPTIONAL",
            "sidecar --probe",
            `${installed.length}/${tools.length} installed${missing.length ? `; not installed: ${missing.join(", ")}` : ""}${
              unknown.length ? `; not reported: ${unknown.join(", ")}` : ""
            }`
          );
        }
      }
    }
  }
}

// 11. Tor binary discovery (mirrors detectTorBinary() in local-server.mjs)
function runtimeDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), IS_WIN ? path.join("AppData", "Local") : ".tauf");
  // local-server.mjs: LOCALAPPDATA/TAUF when LOCALAPPDATA exists, else ~/.tauf
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "TAUF") : path.join(os.homedir(), ".tauf");
}

function detectTor() {
  const bin = IS_WIN ? "tor.exe" : "tor";
  const dataDir = runtimeDataDir();
  const candidates = [];
  if (process.env.TAUF_TOR_BIN && process.env.TAUF_TOR_BIN.trim()) {
    candidates.push({ p: process.env.TAUF_TOR_BIN.trim(), origin: "TAUF_TOR_BIN" });
  }
  candidates.push(
    { p: path.join(ROOT, "tor", bin), origin: "repo" },
    { p: path.join(ROOT, "tor", "tor", bin), origin: "repo" },
    { p: path.join(dataDir, "tor", "tor", bin), origin: "runtime" },
    { p: path.join(dataDir, "tor", bin), origin: "runtime" },
    { p: path.join(os.homedir(), ".tauf", "tor", "tor", bin), origin: "runtime" },
    { p: path.join(os.homedir(), ".tauf", "tor", bin), origin: "runtime" }
  );
  for (const c of candidates) {
    try {
      if (c.p && fs.existsSync(c.p) && fs.statSync(c.p).isFile()) {
        return { path: c.p, origin: c.origin, bundled: isInside(ROOT, c.p) };
      }
    } catch {
      /* ignore unreadable candidate */
    }
  }
  // system PATH
  const locator = IS_WIN ? "where.exe" : "which";
  const r = runQuiet(locator, [bin], 2500);
  if (r.status === 0 && r.stdout) {
    const first = r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && fs.existsSync(first)) return { path: first, origin: "path", bundled: false };
  }
  return null;
}

{
  const tor = detectTor();
  if (!tor) {
    warn(
      "OPTIONAL",
      "Tor binary",
      "NOT FOUND — strict_anonymity blocks clearnet egress; vendor Tor into <repo>/tor (see reports/PACKAGING.md)"
    );
  } else if (tor.bundled) {
    pass("OPTIONAL", "Tor binary", `BUNDLED ${rel(tor.path)}`);
  } else if (tor.origin === "runtime") {
    warn("OPTIONAL", "Tor binary", `EXTERNAL-RUNTIME PATH-NOT-BUNDLED ${tor.path}`);
  } else if (tor.origin === "path") {
    warn("OPTIONAL", "Tor binary", `PATH-NOT-BUNDLED ${tor.path}`);
  } else {
    warn("OPTIONAL", "Tor binary", `EXTERNAL-OVERRIDE ${tor.path}`);
  }
}

// 12. Runtime data dir (intentionally outside the folder)
{
  const dataDir = runtimeDataDir();
  let note = "not initialized yet (created on first launch)";
  try {
    if (fs.existsSync(dataDir)) {
      const entries = fs.readdirSync(dataDir);
      note = `${dataDir} — ${entries.length} entries (runtime data, intentionally outside the folder)`;
    }
  } catch {
    /* ignore */
  }
  pass("OPTIONAL", "runtime vault (outside folder)", note);
}

/* --------------------------------------------------------------- output */

const required = rows.filter((r) => r.kind === "REQUIRED");
const optional = rows.filter((r) => r.kind === "OPTIONAL");
const reqFailed = required.filter((r) => r.status === "FAIL");
const optWarn = optional.filter((r) => r.status !== "PASS");

function renderTable(list, headers) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...list.map((r) => String(r[i]).length))
  );
  const line = (cells) =>
    "  " + cells.map((c, i) => String(c).padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  const out = [line(headers), "  " + widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of list) out.push(line(r));
  return out.join("\n");
}

const summary = {
  repoRoot: ROOT,
  platform: `${process.platform}/${process.arch}`,
  node: process.versions.node,
  requiredFailed: reqFailed.length,
  optionalWarnings: optWarn.length,
  checks: rows,
};

if (JSON_MODE) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const bar = "=".repeat(78);
  console.log(bar);
  console.log("TAUF Portable Folder Verifier");
  console.log(bar);
  console.log(`  repo root : ${ROOT}`);
  console.log(`  platform  : ${process.platform}/${process.arch}   node v${process.versions.node}`);
  console.log("");

  console.log("REQUIRED — without these TAUF cannot run as a self-contained folder");
  console.log(
    renderTable(
      required.map((r) => [r.status, r.item, r.detail]),
      ["STATUS", "ITEM", "DETAIL"]
    )
  );
  console.log("");
  console.log("OPTIONAL — richer/faster, but not needed to launch (dist is rebuildable,");
  console.log("           Tor is a separate binary, Python tools degrade the 7 engines)");
  console.log(
    renderTable(
      optional.map((r) => [r.status, r.item, r.detail]),
      ["STATUS", "ITEM", "DETAIL"]
    )
  );
  console.log("");
  console.log(bar);
  const reqPass = required.filter((r) => r.status === "PASS").length;
  const reqWarn = required.filter((r) => r.status === "WARN").length;
  console.log(
    `REQUIRED: ${reqPass}/${required.length} passed, ${reqFailed.length} failed${
      reqWarn ? `, ${reqWarn} warning(s)` : ""
    }`
  );
  console.log(`OPTIONAL: ${optional.length - optWarn.length}/${optional.length} clean, ${optWarn.length} warning(s)`);
  if (reqFailed.length === 0) {
    console.log("VERDICT: PORTABLE FOLDER OK — TAUF can launch from this folder.");
  } else {
    console.log("VERDICT: NOT PORTABLE — fix the REQUIRED failures above.");
  }
  console.log(bar);
}

process.exit(reqFailed.length === 0 ? 0 : 1);
