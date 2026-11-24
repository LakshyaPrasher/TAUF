#!/usr/bin/env node
/**
 * TAUF — one-command verification runner
 * --------------------------------------
 * Runs the unit, transport, onion, server/API, and integration suites sequentially
 * and prints a consolidated summary. Each suite is a standalone Node script that
 * exits non-zero on failure.
 *
 *   node tests/run-all.mjs
 *   node tests/run-all.mjs --only=unit,server
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SUITES = [
  { id: "unit", label: "Unit / pure functions", file: "tests/unit/functions.test.mjs", timeout: 120_000 },
  { id: "transport", label: "Unit / SOCKS5h transport", file: "tests/unit/transport.test.mjs", timeout: 120_000 },
  { id: "onion", label: "Unit / .onion reliability", file: "tests/unit/onion.test.mjs", timeout: 120_000 },
  { id: "eta", label: "Unit / ETA & budget engine", file: "tests/unit/eta.test.mjs", timeout: 120_000 },
  { id: "search", label: "Unit / search cascade reliability", file: "tests/unit/search.test.mjs", timeout: 120_000 },
  { id: "noise", label: "Unit / noise filtering", file: "tests/unit/noise.test.mjs", timeout: 120_000 },
  { id: "search_pool", label: "Unit / search pool", file: "tests/unit/search_pool.test.mjs", timeout: 120_000 },
  { id: "scheduler", label: "Unit / task scheduler", file: "tests/unit/scheduler.test.mjs", timeout: 120_000 },
  { id: "server", label: "Server / API integration", file: "tests/server/api.test.mjs", timeout: 180_000 },
  {
    id: "integration",
    label: "Sidecar / packaging / build / static",
    file: "tests/integration/integration.test.mjs",
    timeout: 420_000,
  },
];

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg
  ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const selected = SUITES.filter((s) => !only || only.has(s.id));
if (!selected.length) {
  console.error(`No suites matched --only=${onlyArg?.slice(7) || ""}`);
  process.exit(2);
}

console.log("=".repeat(78));
console.log("TAUF verification suite");
console.log(`root: ${ROOT}`);
console.log(`node: ${process.execPath} (${process.version})`);
console.log("=".repeat(78));

const results = [];
for (const suite of selected) {
  const abs = path.join(ROOT, suite.file);
  console.log(`\n--- ${suite.label} (${suite.file}) ---`);
  if (!fs.existsSync(abs)) {
    console.log(`MISSING ${suite.file}`);
    results.push({ ...suite, status: "MISSING", code: 127, ms: 0 });
    continue;
  }
  const started = Date.now();
  const r = spawnSync(process.execPath, [abs], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: suite.timeout,
    windowsHide: true,
    env: { ...process.env, TAUF_VERIFY: "1" },
  });
  const ms = Date.now() - started;
  const code = typeof r.status === "number" ? r.status : r.signal ? 124 : 1;
  const status = code === 0 ? "PASS" : "FAIL";
  results.push({ ...suite, status, code, ms });
}

console.log("\n" + "=".repeat(78));
console.log("CONSOLIDATED SUMMARY");
console.log("-".repeat(78));
let failed = 0;
for (const r of results) {
  if (r.status !== "PASS") failed++;
  console.log(
    `${r.status.padEnd(7)} ${r.id.padEnd(12)} exit=${String(r.code).padEnd(4)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.label}`
  );
}
console.log("-".repeat(78));
console.log(`${results.length - failed}/${results.length} suites passed`);
console.log("=".repeat(78));
process.exit(failed ? 1 : 0);
