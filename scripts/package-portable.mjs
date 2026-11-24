#!/usr/bin/env node
/**
 * TAUF Portable Folder Assembler
 * ------------------------------
 * Builds ONE self-contained folder that can run TAUF on another machine with the
 * same OS/arch (Node + Python runtime aside). Nothing outside the target folder
 * is modified, and %LOCALAPPDATA%\TAUF (vault / config / Tor data) is never touched.
 *
 *   node scripts/package-portable.mjs                      -> <parent>/TAUF-portable
 *   node scripts/package-portable.mjs --out D:\TAUF        -> D:\TAUF
 *   node scripts/package-portable.mjs --out D:\TAUF --force
 *   node scripts/package-portable.mjs --dry-run            -> plan only, writes nothing
 *
 * Flags:
 *   --out <path>           destination folder (default: <repo parent>/TAUF-portable)
 *   --with-node-modules    also bundle node_modules/ (needed to rebuild dist/, not to run)
 *   --with-reports         also bundle reports/ (audit + packaging docs)
 *   --force                replace a target previously created by this script
 *   --dry-run              count + print the manifest without copying anything
 *   --no-verify            skip the post-copy `node --check` pass
 *   --help
 *
 * Exit codes: 0 success (or dry-run plan) · 1 copy/verify error · 2 usage/safety refusal
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const MANIFEST_NAME = "PORTABLE-MANIFEST.txt";

/* ------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const opts = {
    out: path.join(path.dirname(ROOT), "TAUF-portable"),
    withNodeModules: false,
    withReports: false,
    force: false,
    dryRun: false,
    verify: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--with-node-modules") opts.withNodeModules = true;
    else if (a === "--with-reports") opts.withReports = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-verify") opts.verify = false;
    else if (a === "--out") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) {
        console.error("error: --out requires a path");
        process.exit(2);
      }
      opts.out = path.resolve(ROOT, v);
      i += 1;
    } else if (a.startsWith("--out=")) {
      opts.out = path.resolve(ROOT, a.slice("--out=".length));
    } else {
      console.error(`error: unknown argument '${a}' (use --help)`);
      process.exit(2);
    }
  }
  return opts;
}

const OPT = parseArgs(process.argv.slice(2));

if (OPT.help) {
  console.log(`TAUF portable packager

Usage:
  node scripts/package-portable.mjs [--out <path>] [options]

Options:
  --out <path>          destination folder (default: ${path.join(path.dirname(ROOT), "TAUF-portable")})
  --with-node-modules   bundle node_modules/ (~93 MB) - only needed to rebuild dist/
  --with-reports        bundle reports/ (docs only, never needed at runtime)
  --force               replace an existing target created by this packager
  --dry-run             print the plan + manifest, copy nothing
  --no-verify           skip the post-copy 'node --check' pass
  --help                show this help

What is bundled:
  index.html, package.json, package-lock.json, vite.config.ts, tsconfig.json,
  local-server.mjs, launch-tauf.cmd/.vbs/.sh, dist/, public/, src/, scripts/,
  sidecar/ (bridge.py + requirements.txt + .venv), src-tauri/resources/,
  src-tauri/icons/, PROJECT_HANDOFF.md

Always excluded:
  .git, __pycache__, *.pyc/*.pyo, *.log, .tmp, .cache, coverage, .env*,
  Thumbs.db/.DS_Store, src-tauri/target, test output - plus node_modules/ and
  reports/ unless their flag is passed.

Never touched:
  %LOCALAPPDATA%\\TAUF (cases.json vault, config.json, runtime.log, corpus/,
  tor/, tor-data/, browser profile) - that is per-machine runtime data.

Exit codes: 0 ok/dry-run, 1 copy or verification error, 2 bad usage/safety refusal.
`);
  process.exit(0);
}

/* ----------------------------------------------------------------- utils */

const log = (msg = "") => console.log(msg);
const humanSize = (bytes) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const isInside = (parent, child) => {
  const r = path.relative(parent, child);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

/* ------------------------------------------------------------- copy plan */

const FILES = [
  "index.html",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "local-server.mjs",
  "launch-tauf.cmd",
  "launch-tauf.vbs",
  "launch-tauf.sh",
  "PROJECT_HANDOFF.md",
];

const DIRS = [
  "dist",
  "public",
  "src",
  "scripts",
  "sidecar",
  path.join("src-tauri", "resources"),
  path.join("src-tauri", "icons"),
];

const OPTIONAL_DIRS = [];
if (OPT.withNodeModules) OPTIONAL_DIRS.push("node_modules");
if (OPT.withReports) OPTIONAL_DIRS.push("reports");

const REQUIRED_SOURCES = [
  "index.html",
  "package.json",
  "local-server.mjs",
  "dist/index.html",
  "sidecar/bridge.py",
];

/* Exclusion rules (applied to every nested entry) */
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".vite",
  ".turbo",
  "coverage",
  "test-results",
  "playwright-report",
  "target", // src-tauri/target (Rust build cache) is never shipped
]);
const EXCLUDED_FILE_RE = [
  /\.pyc$/i,
  /\.pyo$/i,
  /\.log$/i,
  /\.tmp$/i,
  /\.tsbuildinfo$/i,
  /^\.env(\.|$)/i,
  /^Thumbs\.db$/i,
  /^\.DS_Store$/i,
  /^output_.*\.txt$/i,
  /^\.gitignore$/i,
];

function excludedName(name, isDir) {
  if (isDir) return EXCLUDED_DIR_NAMES.has(name);
  return EXCLUDED_FILE_RE.some((re) => re.test(name));
}

/* ---------------------------------------------------------------- safety */

const OUT = OPT.out;
let cleanupTarget = false;
let existingEntries = [];

const absRoot = path.resolve(ROOT);

if (path.resolve(OUT) === absRoot) {
  console.error("error: refusing to package into the repo root itself — choose another folder with --out");
  process.exit(2);
}
if (isInside(absRoot, OUT)) {
  console.error(
    `error: refusing to package into '${OUT}' because it is inside the repo (recursive copy risk).\n` +
      `       Choose a path outside '${absRoot}', e.g. --out ${path.join(path.dirname(absRoot), "TAUF-portable")}`
  );
  process.exit(2);
}

let outExists = false;
try {
  outExists = fs.statSync(OUT).isDirectory();
} catch {
  outExists = false;
}
if (fs.existsSync(OUT) && !outExists) {
  console.error(`error: '${OUT}' exists and is not a directory`);
  process.exit(2);
}
if (outExists) {
  existingEntries = fs.readdirSync(OUT);
  if (existingEntries.length > 0) {
    const priorManifest = path.join(OUT, MANIFEST_NAME);
    if (!OPT.force) {
      console.error(
        `error: target '${OUT}' is not empty (${existingEntries.length} entries).\n` +
          `       Re-run with --force to replace it, or pick a fresh --out path.`
      );
      process.exit(2);
    }
    if (!fs.existsSync(priorManifest)) {
      console.error(
        `error: --force only replaces folders previously produced by this packager\n` +
          `       (missing ${path.join(OUT, MANIFEST_NAME)}). Move/rename '${OUT}' manually instead.`
      );
      process.exit(2);
    }
    cleanupTarget = true;
  }
}

/* --------------------------------------------------------------- copying */

const stats = new Map(); // top-level item -> { files, bytes }
const notes = [];
const symlinks = [];

const rootReal = fs.realpathSync(absRoot);
const visited = new Set([rootReal]);

function bump(item, bytes) {
  const s = stats.get(item) || { files: 0, bytes: 0 };
  s.files += 1;
  s.bytes += bytes;
  stats.set(item, s);
}

function topItem(relPath) {
  const first = relPath.split(path.sep)[0];
  return first || relPath;
}

function ensureDir(dir) {
  if (!OPT.dryRun) fs.mkdirSync(dir, { recursive: true });
}

function copyFileEntry(src, dest, relPath) {
  const st = fs.lstatSync(src);
  if (excludedName(path.basename(src), false)) return;
  bump(topItem(relPath), st.size);
  if (!OPT.dryRun) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

/**
 * Recursive copy that never follows a symlink out of the repo and never loops.
 * Symlinks whose real target is inside the repo are materialised as copies;
 * everything else is skipped and reported.
 */
function walk(src, dest, relPath) {
  let st;
  try {
    st = fs.lstatSync(src);
  } catch (err) {
    notes.push(`skipped unreadable ${relPath}: ${err.message}`);
    return;
  }

  if (st.isSymbolicLink()) {
    symlinks.push(relPath);
    let real = null;
    try {
      real = fs.realpathSync(src);
    } catch {
      notes.push(`skipped broken symlink ${relPath}`);
      return;
    }
    if (!isInside(rootReal, real) && real !== rootReal) {
      notes.push(`skipped symlink outside repo ${relPath} -> ${real}`);
      return;
    }
    let rst;
    try {
      rst = fs.statSync(real);
    } catch {
      notes.push(`skipped dangling symlink ${relPath}`);
      return;
    }
    if (rst.isDirectory()) {
      if (visited.has(real)) {
        notes.push(`skipped cyclic symlink ${relPath} -> ${real}`);
        return;
      }
      visited.add(real);
      walkDirectory(real, dest, relPath);
      visited.delete(real);
    } else if (rst.isFile()) {
      bump(topItem(relPath), rst.size);
      if (!OPT.dryRun) {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(real, dest);
      }
    }
    return;
  }

  if (st.isDirectory()) {
    walkDirectory(src, dest, relPath);
    return;
  }

  if (st.isFile()) copyFileEntry(src, dest, relPath);
}

function walkDirectory(src, dest, relPath) {
  ensureDir(dest);
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (err) {
    notes.push(`skipped unreadable dir ${relPath}: ${err.message}`);
    return;
  }
  for (const e of entries) {
    if (excludedName(e.name, e.isDirectory())) continue;
    walk(path.join(src, e.name), path.join(dest, e.name), path.join(relPath, e.name));
  }
}

/* ---------------------------------------------------------- preflight */

log("=".repeat(78));
log("TAUF Portable Packager");
log("=".repeat(78));
log(`  source : ${absRoot}`);
log(`  target : ${OUT}${OPT.dryRun ? "   [DRY RUN - nothing will be written]" : ""}`);
log(`  node   : v${process.versions.node} (${process.execPath})`);
log(`  platform: ${process.platform}/${process.arch}`);
log("");

const missingCore = [];
for (const relSrc of REQUIRED_SOURCES) {
  if (!fs.existsSync(path.join(absRoot, relSrc))) missingCore.push(relSrc);
}
if (missingCore.length) {
  console.error(`error: missing required source item(s): ${missingCore.join(", ")}`);
  process.exit(1);
}

if (cleanupTarget && !OPT.dryRun) {
  log(`Removing previous packager output at ${OUT} (--force, manifest found)...`);
  fs.rmSync(OUT, { recursive: true, force: true });
}

/* -------------------------------------------------------------- execute */

const plan = [];
for (const f of FILES) {
  if (fs.existsSync(path.join(absRoot, f))) plan.push({ type: "file", rel: f });
  else notes.push(`skipped missing file ${f}`);
}
for (const d of [...DIRS, ...OPTIONAL_DIRS]) {
  if (fs.existsSync(path.join(absRoot, d))) plan.push({ type: "dir", rel: d });
  else notes.push(`skipped missing dir ${d}/`);
}

const startedAt = Date.now();
for (const item of plan) {
  const src = path.join(absRoot, item.rel);
  const dest = path.join(OUT, item.rel);
  if (item.type === "file") copyFileEntry(src, dest, item.rel);
  else walk(src, dest, item.rel);
}

/* ------------------------------------------------------------- manifest */

const ordered = [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
const totalFiles = ordered.reduce((n, [, s]) => n + s.files, 0);
const totalBytes = ordered.reduce((n, [, s]) => n + s.bytes, 0);
const topBytes = Math.max(...ordered.map(([, s]) => s.bytes), 1);

const nameW = Math.max(4, ...ordered.map(([n]) => n.length));
const countW = String(totalFiles).length + 1;
const sizeW = 9;
const barW = 18;

log("");
log("  Top-level item".padEnd(nameW + 4) + "Files".padStart(countW + 2) + "Size".padStart(sizeW + 2) + "  " + "Share");
log("  " + "-".repeat(nameW) + "  " + "-".repeat(countW) + "  " + "-".repeat(sizeW) + "  " + "-".repeat(barW));
for (const [name, s] of ordered) {
  const filled = Math.max(1, Math.round((s.bytes / topBytes) * barW));
  log(
    "  " +
      name.padEnd(nameW) +
      String(s.files).padStart(countW + 2) +
      humanSize(s.bytes).padStart(sizeW + 2) +
      "  " +
      "#".repeat(filled) + ".".repeat(barW - filled)
  );
}
log("  " + "-".repeat(nameW) + "  " + "-".repeat(countW) + "  " + "-".repeat(sizeW) + "  " + "-".repeat(barW));
log(
  "  " +
    "TOTAL".padEnd(nameW) +
    String(totalFiles).padStart(countW + 2) +
    humanSize(totalBytes).padStart(sizeW + 2) +
    `  ${ordered.length} top-level item(s), ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
);
log("");
log(`  excluded: .git, __pycache__, *.pyc/*.pyo, *.log, .tmp, .cache, coverage, .env*,` +
    ` src-tauri/target, test output`);
log(`            node_modules/ ${OPT.withNodeModules ? "(INCLUDED)" : "(not bundled - pass --with-node-modules)"}`);
log(`            reports/      ${OPT.withReports ? "(INCLUDED)" : "(not bundled - pass --with-reports)"}`);
if (existingEntries.length && cleanupTarget) log(`  replaced ${existingEntries.length} existing entries in target`);

if (symlinks.length) {
  log("");
  log(`  symlinks materialised as real copies: ${symlinks.length}`);
  for (const s of symlinks.slice(0, 12)) log(`    - ${s}`);
  if (symlinks.length > 12) log(`    ... and ${symlinks.length - 12} more`);
}
if (notes.length) {
  log("");
  log(`  notes (${notes.length}):`);
  for (const n of notes.slice(0, 20)) log(`    - ${n}`);
  if (notes.length > 20) log(`    ... and ${notes.length - 20} more`);
}

/* ------------------------------------------------------- post-copy check */

let verifyFailed = 0;

if (!OPT.dryRun) {
  const manifest = [
    "TAUF PORTABLE FOLDER MANIFEST",
    "=============================",
    `created        : ${new Date().toISOString()}`,
    `source folder  : ${absRoot}`,
    `packager       : scripts/package-portable.mjs (node v${process.versions.node})`,
    `platform       : ${process.platform}/${process.arch}`,
    `node_modules   : ${OPT.withNodeModules ? "bundled" : "NOT bundled (required only to rebuild dist/)"}`,
    `reports        : ${OPT.withReports ? "bundled" : "NOT bundled"}`,
    "",
    "Top-level contents (files / size):",
    ...ordered.map(([n, s]) => `  ${n.padEnd(nameW)}  ${String(s.files).padStart(6)}  ${humanSize(s.bytes).padStart(9)}`),
    "",
    `TOTAL: ${totalFiles} files, ${humanSize(totalBytes)} (+ this manifest)`,
    "",
    "Run it:",
    "  Windows      : launch-tauf.vbs   (silent)  |  launch-tauf.cmd   (console log)",
    "  macOS/Linux  : ./launch-tauf.sh",
    "  Generic      : node local-server.mjs --open",
    "",
    "Verify it:  node scripts/verify-portable.mjs",
    "",
    "Intentionally NOT inside this folder (per-machine runtime data):",
    "  %LOCALAPPDATA%\\TAUF\\cases.json, config.json, runtime.log, corpus/,",
    "  tor/, tor-data/, edge-app-profile|chrome-app-profile|brave-app-profile/",
    "  (~/.tauf/ on macOS/Linux)",
    "",
    "Bundled Tor (optional): copy the Tor Expert Bundle so that",
    "  <this folder>/tor/tor/tor.exe  (or <this folder>/tor/tor.exe) exists.",
    "",
    "Requires on the target machine: Node.js >= 18 (found via PATH, TAUF_NODE_EXE,",
    "NVM/Volta/Scoop/fnm, Program Files), Python is only needed if sidecar/.venv is",
    "not bundled or does not match the target OS/arch.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT, MANIFEST_NAME), manifest, "utf8");
}

if (OPT.verify && !OPT.dryRun) {
  log("");
  log("  post-copy checks");
  const nodeChecks = ["local-server.mjs"];
  const scriptsDir = path.join(OUT, "scripts");
  if (fs.existsSync(scriptsDir)) {
    for (const f of fs.readdirSync(scriptsDir)) {
      if (f.endsWith(".mjs") || f.endsWith(".js")) nodeChecks.push(path.join("scripts", f));
    }
  }
  for (const rel of nodeChecks) {
    const abs = path.join(OUT, rel);
    if (!fs.existsSync(abs)) continue;
    const r = spawnSync(process.execPath, ["--check", abs], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    if (r.status === 0) log(`    PASS node --check ${rel}`);
    else {
      verifyFailed += 1;
      log(`    FAIL node --check ${rel}: ${(r.stderr || "").trim().split(/\r?\n/)[0]}`);
    }
  }
  const expectations = [
    "index.html",
    "dist/index.html",
    "local-server.mjs",
    "package.json",
    "sidecar/bridge.py",
    "src-tauri/resources/wmn_curated.json",
    "launch-tauf.cmd",
    "launch-tauf.vbs",
    "launch-tauf.sh",
  ];
  for (const rel of expectations) {
    if (fs.existsSync(path.join(OUT, rel))) log(`    PASS present ${rel}`);
    else {
      verifyFailed += 1;
      log(`    FAIL missing ${rel}`);
    }
  }
}

log("");
if (OPT.dryRun) {
  log(`DRY RUN complete - ${totalFiles} files, ${humanSize(totalBytes)} would be written to ${OUT}`);
  log("Re-run without --dry-run to build it.");
} else if (verifyFailed) {
  log(`PORTABLE FOLDER BUILT WITH ${verifyFailed} VERIFICATION FAILURE(S): ${OUT}`);
} else {
  log(`PORTABLE FOLDER READY: ${OUT}`);
  log(`Next: node "${path.join(OUT, "scripts", "verify-portable.mjs")}"`);
}
log("=".repeat(78));

process.exit(verifyFailed ? 1 : 0);
