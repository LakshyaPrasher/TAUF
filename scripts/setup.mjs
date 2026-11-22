#!/usr/bin/env node
/**
 * TAUF Cross-Platform Sovereign Setup Script
 * ------------------------------------------
 * Checks Node >=18, installs npm dependencies if missing, creates sidecar/.venv
 * if missing and installs sidecar/requirements.txt, builds dist/ if missing,
 * and reports local Tor SOCKS5h availability.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SIDECAR_DIR = path.join(ROOT_DIR, "sidecar");
const VENV_DIR = path.join(SIDECAR_DIR, ".venv");
const REQUIREMENTS_TXT = path.join(SIDECAR_DIR, "requirements.txt");
const BRIDGE_PY = path.join(SIDECAR_DIR, "bridge.py");
const DIST_INDEX = path.join(ROOT_DIR, "dist", "index.html");
const IS_WIN = process.platform === "win32";
const CHECK_ONLY = process.argv.includes("--check");
const FORCE_REBUILD = process.argv.includes("--build");

function step(label) {
  console.log(`\n[TAUF Setup] ${label}`);
}

function ok(msg) {
  console.log(`  [OK] ${msg}`);
}

function warn(msg) {
  console.warn(`  [WARN] ${msg}`);
}

function fail(msg) {
  console.error(`  [ERROR] ${msg}`);
  process.exit(1);
}

function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    windowsHide: true,
    ...opts,
  });
  return res.status === 0;
}

function captureCmd(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    windowsHide: true,
  });
}

function resolveNpmCommand() {
  const nodeDir = path.dirname(process.execPath);
  const bundledNpmCli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(bundledNpmCli)) {
    return { cmd: process.execPath, baseArgs: [bundledNpmCli], shell: false };
  }
  const corepackJs = path.join(nodeDir, "node_modules", "corepack", "dist", "corepack.js");
  if (fs.existsSync(corepackJs)) {
    return { cmd: process.execPath, baseArgs: [corepackJs, "npm"], shell: false };
  }
  return { cmd: IS_WIN ? "npm.cmd" : "npm", baseArgs: [], shell: IS_WIN };
}

function checkNodeVersion() {
  step("Checking Node.js runtime");
  const ver = process.versions.node;
  const major = Number(ver.split(".")[0] || 0);
  if (!Number.isFinite(major) || major < 18) {
    fail(`Node.js >=18 is required (found v${ver}). Please upgrade Node.js.`);
  }
  ok(`Node.js v${ver} (${process.execPath})`);
}

function ensureNpmDependencies() {
  step("Checking npm dependencies");
  const requiredPkgs = ["vite", "typescript", "cytoscape", "react"];
  const missing = requiredPkgs.filter(
    (pkg) => !fs.existsSync(path.join(ROOT_DIR, "node_modules", pkg))
  );
  if (missing.length === 0) {
    ok("node_modules present");
    return;
  }
  if (CHECK_ONLY) {
    warn(`Missing npm packages: ${missing.join(", ")} (run 'npm run setup' to install)`);
    return;
  }
  const npm = resolveNpmCommand();
  console.log(`  Installing npm packages (missing: ${missing.join(", ")})...`);
  const installed = runCmd(npm.cmd, [...npm.baseArgs, "install"], { shell: npm.shell });
  if (!installed) {
    fail("npm install failed. Check network access or npm configuration.");
  }
  ok("npm dependencies installed");
}

function getVenvPythonPath() {
  return IS_WIN
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python");
}

function findSystemPython() {
  const candidates = IS_WIN
    ? [
        { cmd: "py", args: ["-3.12"] },
        { cmd: "py", args: ["-3"] },
        { cmd: "python", args: [] },
        { cmd: "python3", args: [] },
      ]
    : [
        { cmd: "python3.12", args: [] },
        { cmd: "python3", args: [] },
        { cmd: "python", args: [] },
      ];
  for (const c of candidates) {
    const r = captureCmd(c.cmd, [
      ...c.args,
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
    ]);
    if (r.status === 0 && r.stdout) {
      const [maj, min] = r.stdout.trim().split(".").map(Number);
      if (maj > 3 || (maj === 3 && min >= 10)) {
        return { ...c, version: `${maj}.${min}` };
      }
    }
  }
  return null;
}

function probeSidecar(venvPy) {
  if (!fs.existsSync(venvPy) || !fs.existsSync(BRIDGE_PY)) return [];
  const r = captureCmd(venvPy, [BRIDGE_PY, "--probe"]);
  if (r.status === 0 && r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  return [];
}

function ensurePythonSidecar() {
  step("Checking Python sidecar (sidecar/.venv)");
  let venvPy = getVenvPythonPath();
  let createdVenv = false;

  if (!fs.existsSync(venvPy)) {
    const sysPy = findSystemPython();
    if (!sysPy) {
      warn("Python >=3.10 not found; skipping sidecar/.venv creation. Native OSINT engines still run without Python.");
      return;
    }
    if (CHECK_ONLY) {
      warn(`sidecar/.venv missing (system Python ${sysPy.version} found; run 'npm run setup' to create)`);
      return;
    }
    console.log(`  Creating virtual environment with Python ${sysPy.version}...`);
    const created = runCmd(sysPy.cmd, [...sysPy.args, "-m", "venv", VENV_DIR]);
    if (!created || !fs.existsSync(venvPy)) {
      warn("Failed to create sidecar/.venv. Ensure python3-venv is available.");
      return;
    }
    createdVenv = true;
    ok(`Created ${path.relative(ROOT_DIR, VENV_DIR)}`);
  } else {
    ok(`Found ${path.relative(ROOT_DIR, venvPy)}`);
  }

  let tools = probeSidecar(venvPy);
  const missingTools = tools.filter((t) => !t.installed).map((t) => t.name);

  if ((createdVenv || missingTools.length > 0 || tools.length === 0) && fs.existsSync(REQUIREMENTS_TXT)) {
    if (CHECK_ONLY) {
      warn(`Sidecar tools incomplete (${missingTools.join(", ") || "probe failed"}); run 'npm run setup'`);
    } else {
      console.log("  Installing sidecar dependencies from sidecar/requirements.txt...");
      runCmd(venvPy, ["-m", "pip", "install", "--upgrade", "pip"]);
      const pipOk = runCmd(venvPy, ["-m", "pip", "install", "-r", REQUIREMENTS_TXT]);
      if (!pipOk) {
        warn("pip install encountered an error; some sidecar tools may be unavailable.");
      }
      tools = probeSidecar(venvPy);
    }
  }

  const ready = tools.filter((t) => t.installed).length;
  if (tools.length > 0) {
    ok(`Sidecar probe: ${ready}/${tools.length} tools installed (${tools.map((t) => `${t.name}:${t.installed ? "ok" : "missing"}`).join(", ")})`);
  } else {
    warn("Sidecar probe returned no tools.");
  }
}

function ensureDistBuild() {
  step("Checking frontend production bundle (dist/)");
  if (fs.existsSync(DIST_INDEX) && !FORCE_REBUILD) {
    ok("dist/index.html present");
    return;
  }
  if (CHECK_ONLY) {
    warn("dist/index.html missing (run 'npm run build' or 'npm run setup')");
    return;
  }
  const npm = resolveNpmCommand();
  console.log("  Building frontend bundle via npm run build...");
  const built = runCmd(npm.cmd, [...npm.baseArgs, "run", "build"], { shell: npm.shell });
  if (!built || !fs.existsSync(DIST_INDEX)) {
    fail("Frontend build failed.");
  }
  ok("Built dist/index.html");
}

function checkTcpPort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(val);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

function findTorBinary() {
  const candidates = [];
  if (process.env.TAUF_TOR_BIN) candidates.push(process.env.TAUF_TOR_BIN);

  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      path.join(localAppData, "TAUF", "tor", "tor", "tor.exe"),
      path.join(localAppData, "TAUF", "tor", "tor.exe"),
      path.join(ROOT_DIR, "tor", "tor", "tor.exe"),
      path.join(ROOT_DIR, "tor", "tor.exe")
    );
  } else {
    const home = os.homedir();
    candidates.push(
      path.join(home, ".tauf", "tor", "tor"),
      path.join(ROOT_DIR, "tor", "tor"),
      "/opt/homebrew/bin/tor",
      "/usr/local/bin/tor",
      "/usr/bin/tor"
    );
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  const whichCmd = IS_WIN ? "where" : "which";
  const r = captureCmd(whichCmd, [IS_WIN ? "tor.exe" : "tor"]);
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

async function checkTorAvailability() {
  step("Checking Tor SOCKS5h anonymity transport");
  const p9050 = await checkTcpPort("127.0.0.1", 9050);
  const p9150 = await checkTcpPort("127.0.0.1", 9150);
  const torBin = findTorBinary();

  if (p9050 || p9150) {
    ok(`Live Tor SOCKS5h proxy listening on 127.0.0.1:${p9050 ? 9050 : 9150}`);
  } else if (torBin) {
    ok(`Tor binary found for supervised auto-start: ${torBin}`);
  } else {
    warn(
      "Tor proxy/binary not detected. Install Tor Expert Bundle or system Tor " +
        (IS_WIN
          ? "(e.g. 'winget install TorProject.TorBrowser' or extract Tor Expert Bundle into %LOCALAPPDATA%\\TAUF\\tor)"
          : process.platform === "darwin"
          ? "(e.g. 'brew install tor')"
          : "(e.g. 'sudo apt install tor' / 'sudo pacman -S tor')") +
        " to enable strict socks5h:// anonymity and .onion dark-web crawling."
    );
  }
}

async function main() {
  console.log(`TAUF Setup (${process.platform}/${process.arch})`);
  checkNodeVersion();
  ensureNpmDependencies();
  ensurePythonSidecar();
  ensureDistBuild();
  await checkTorAvailability();
  console.log("\n[TAUF Setup] Complete. Launch with 'npm start'" + (IS_WIN ? " or launch-tauf.vbs" : " or ./launch-tauf.sh") + ".\n");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
