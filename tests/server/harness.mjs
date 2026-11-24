// Server/API integration harness for TAUF.
//
// Boots a throwaway `local-server.mjs` on a free loopback port with an isolated
// LOCALAPPDATA (vault + config under a temp dir) and a locked-down PATH so the
// server can never find a real `tor`, Python, or other system tool. Exposes raw
// HTTP helpers (node:http, so we control Host/Origin/Sec-Fetch-Site) plus
// process lifecycle helpers.

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const SERVER_ENTRY = path.join(REPO_ROOT, "local-server.mjs");
const NODE_BIN = process.execPath;
const HEALTH_TIMEOUT_MS = 15_000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function makeTempDir() {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const parent = path.join(base, "opencode");
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "tauf-test-"));
}

function requestOnce(port, pathname, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 10_000,
  } = opts;

  return new Promise((resolve, reject) => {
    const hdrs = { ...headers };
    const hasHost = Object.keys(hdrs).some((k) => k.toLowerCase() === "host");
    if (!hasHost) hdrs.Host = `127.0.0.1:${port}`;

    // setHost:false keeps Node from injecting/overriding Host, which is the
    // whole point of the DNS-rebinding tests.
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: hdrs,
        setHost: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: text, json });
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms: ${method} ${pathname}`));
    });
    req.on("error", reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function requestFirstChunkOnce(port, pathname, opts = {}) {
  const { headers = {}, timeoutMs = 5_000 } = opts;
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers };
    if (!Object.keys(hdrs).some((k) => k.toLowerCase() === "host")) {
      hdrs.Host = `127.0.0.1:${port}`;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: hdrs,
        setHost: false,
      },
      (res) => {
        const out = {
          status: res.statusCode,
          headers: res.headers,
          chunk: "",
        };
        res.once("data", (c) => {
          out.chunk = c.toString("utf8");
          finish(resolve, out);
          res.destroy();
          req.destroy();
        });
        res.once("end", () => {
          finish(resolve, out);
        });
        res.on("error", (err) => {
          // Errors caused by our own teardown are expected.
          if (!settled) finish(reject, err);
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms reading ${pathname}`));
    });
    req.on("error", (err) => {
      if (!settled) finish(reject, err);
    });
    req.end();
  });
}

async function getHealth(port, timeoutMs) {
  return await requestOnce(port, "/__tauf_health__", {
    method: "GET",
    timeoutMs,
  });
}

/**
 * Start an isolated TAUF server and return an API object for driving it.
 */
export async function startServer() {
  const port = await findFreePort();
  const tempDir = makeTempDir();
  const dataDir = path.join(tempDir, "TAUF");
  const configPath = path.join(dataDir, "config.json");
  const casesPath = path.join(dataDir, "cases.json");

  const env = {
    LOCALAPPDATA: tempDir,
    TAUF_PORT: String(port),
    TAUF_TOR_BIN: path.join(tempDir, "no-tor.exe"),
    TAUF_PYTHON: path.join(tempDir, "no-python.exe"),
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    TEMP: tempDir,
    TMP: tempDir,
    USERPROFILE: tempDir,
  };

  const child = spawn(NODE_BIN, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const capture = (which) => (chunk) => {
    const text = chunk.toString("utf8");
    if (which === "out") {
      stdout = (stdout + text).slice(-200_000);
    } else {
      stderr = (stderr + text).slice(-200_000);
    }
  };
  child.stdout?.on("data", capture("out"));
  child.stderr?.on("data", capture("err"));

  let exitInfo = null;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once("error", (err) => {
      exitInfo = { code: null, signal: null, error: err.message };
      resolve(exitInfo);
    });
  });

  const api = {
    port,
    tempDir,
    dataDir,
    configPath,
    casesPath,
    child,
    logs: () => ({ stdout, stderr }),
    isAlive: () => child.exitCode === null && child.signalCode === null,
    async rawRequest(pathname, opts = {}) {
      return await requestOnce(port, pathname, opts);
    },
    async readFirstChunk(pathname, opts = {}) {
      return await requestFirstChunkOnce(port, pathname, opts);
    },
    async rpc(cmd, args = {}, opts = {}) {
      const headers = {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      };
      return await requestOnce(port, "/rpc", {
        method: "POST",
        headers,
        body: JSON.stringify({ cmd, args }),
        timeoutMs: opts.timeoutMs ?? 15_000,
      });
    },
    async waitForExit(ms = 5_000) {
      if (exitInfo) {
        return { exited: true, timedOut: false, ...exitInfo };
      }
      const timedOut = await Promise.race([
        exitPromise.then((info) => ({ exited: true, timedOut: false, ...info })),
        sleep(ms).then(() => ({ exited: false, timedOut: true })),
      ]);
      return timedOut;
    },
    async cleanup() {
      const errors = [];
      try {
        if (api.isAlive()) {
          child.kill("SIGTERM");
          const first = await api.waitForExit(3_000);
          if (!first.exited) {
            child.kill("SIGKILL");
            const second = await api.waitForExit(2_000);
            if (!second.exited) errors.push("child did not exit after SIGKILL");
          }
        }
      } catch (err) {
        errors.push(`kill failed: ${err.message}`);
      }
      try {
        fs.rmSync(tempDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200,
        });
      } catch (err) {
        errors.push(`temp dir cleanup failed: ${err.message}`);
      }
      return errors;
    },
  };

  // Wait for the health endpoint (harness boot, not service polling).
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!api.isAlive()) {
      const info = await api.waitForExit(100);
      await api.cleanup();
      throw new Error(
        `server exited before health check (code=${info.code}, signal=${info.signal})\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }
    try {
      const res = await getHealth(port, 800);
      if (res.status === 200) {
        return api;
      }
      lastError = new Error(`health returned ${res.status}: ${res.body.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }

  await api.cleanup();
  throw new Error(
    `health endpoint did not become ready within ${HEALTH_TIMEOUT_MS}ms: ` +
      `${lastError?.message || "unknown error"}\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
}
