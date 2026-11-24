// Standalone server/API integration suite for TAUF.
//
// Run with:
//   node tests/server/api.test.mjs
//
// Exits non-zero if any check fails. Boots a real local-server.mjs on a random
// loopback port with an isolated vault; no external network, no Tor.

import fs from "node:fs";
import path from "node:path";
import { startServer, sleep } from "./harness.mjs";

const SYNTHETIC_NAME = "Zqxjkv Plmnqrst";
const SECRET = "s3cret";
const PROXY_URL = `socks5h://alice:${SECRET}@127.0.0.1:1080`;

let checks = 0;
let failures = 0;
let currentStep = "";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`${currentStep}: ${message}`);
  }
}

function note(message) {
  console.log(`  · ${message}`);
}

async function step(number, title, fn) {
  currentStep = `step ${number} (${title})`;
  try {
    await fn();
    checks += 1;
    console.log(`PASS ${number}. ${title}`);
  } catch (err) {
    checks += 1;
    failures += 1;
    console.log(`FAIL ${number}. ${title}`);
    console.log(`      ${err.message}`);
  }
}

function readConfig(t) {
  return fs.readFileSync(t.configPath, "utf8");
}

let server;
try {
  server = await startServer();
  console.log(
    `Server ready: http://127.0.0.1:${server.port} (temp: ${server.tempDir})`
  );
  console.log("");

  await step(1, "health endpoint reports ok + build_id", async () => {
    const res = await server.rawRequest("/__tauf_health__");
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.body.slice(0, 200)}`);
    assert(res.json?.ok === true, `expected ok:true, got ${JSON.stringify(res.json)}`);
    assert(
      typeof res.json?.build_id === "string" && res.json.build_id.length > 0,
      `expected non-empty build_id, got ${JSON.stringify(res.json?.build_id)}`
    );
    note(`build_id=${res.json.build_id}`);
  });

  await step(2, "POST /rpc with foreign Host is rejected (DNS rebinding)", async () => {
    const res = await server.rawRequest("/rpc", {
      method: "POST",
      headers: { Host: "evil.tld", "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "list_cases", args: {} }),
    });
    assert(res.status === 403, `expected 403, got ${res.status}: ${res.body.slice(0, 200)}`);
    assert(res.json?.ok === false, `expected ok:false, got ${JSON.stringify(res.json)}`);
    note(`status=${res.status} error=${JSON.stringify(res.json?.error)}`);
  });

  await step(3, "POST /rpc with cross-origin Origin is rejected", async () => {
    const res = await server.rawRequest("/rpc", {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Origin: "https://evil.tld",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cmd: "list_cases", args: {} }),
    });
    assert(res.status === 403, `expected 403, got ${res.status}: ${res.body.slice(0, 200)}`);
    note(`status=${res.status} error=${JSON.stringify(res.json?.error)}`);
  });

  await step(4, "POST /rpc with Sec-Fetch-Site: cross-site is rejected", async () => {
    const res = await server.rawRequest("/rpc", {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cmd: "list_cases", args: {} }),
    });
    assert(res.status === 403, `expected 403, got ${res.status}: ${res.body.slice(0, 200)}`);
    note(`status=${res.status} error=${JSON.stringify(res.json?.error)}`);
  });

  await step(5, "POST /rpc without JSON Content-Type is rejected", async () => {
    const missing = await server.rawRequest("/rpc", {
      method: "POST",
      headers: { Host: `127.0.0.1:${server.port}` },
      body: JSON.stringify({ cmd: "list_cases", args: {} }),
    });
    assert(
      missing.status === 403,
      `missing Content-Type: expected 403, got ${missing.status}: ${missing.body.slice(0, 200)}`
    );

    const textPlain = await server.rawRequest("/rpc", {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ cmd: "list_cases", args: {} }),
    });
    assert(
      textPlain.status === 403,
      `text/plain: expected 403, got ${textPlain.status}: ${textPlain.body.slice(0, 200)}`
    );
    note(`missing=${missing.status} text/plain=${textPlain.status}`);
  });

  await step(6, "valid POST /rpc list_cases succeeds", async () => {
    const res = await server.rpc("list_cases");
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.body.slice(0, 200)}`);
    assert(res.json?.ok === true, `expected ok:true, got ${JSON.stringify(res.json)}`);
    assert(Array.isArray(res.json?.data), `expected data array, got ${typeof res.json?.data}`);
    note(`cases=${res.json.data.length}`);
  });

  await step(7, "start_investigation rejects non-string org and server survives", async () => {
    const bad = await server.rpc("start_investigation", {
      input: { full_name: SYNTHETIC_NAME, org: 1 },
    });
    assert(bad.status === 400, `expected 400, got ${bad.status}: ${bad.body.slice(0, 200)}`);
    assert(
      /org must be a string/i.test(bad.json?.error || ""),
      `expected 'org must be a string', got ${JSON.stringify(bad.json?.error)}`
    );
    note(`error=${JSON.stringify(bad.json.error)}`);

    const after = await server.rpc("list_cases");
    assert(
      after.status === 200 && after.json?.ok === true,
      `server unhealthy after rejection: status=${after.status} body=${after.body.slice(0, 200)}`
    );
    assert(server.isAlive(), "server process is not alive after validation error");
  });

  await step(8, "save_auth_config enforces corpus containment", async () => {
    const blocked = await server.rpc("save_auth_config", {
      config: { local_corpus_dir: "C:\\Windows" },
    });
    assert(
      blocked.status === 400,
      `C:\\Windows: expected 400, got ${blocked.status}: ${blocked.body.slice(0, 200)}`
    );
    assert(
      /dedicated subfolder/i.test(blocked.json?.error || ""),
      `expected corpus containment error, got ${JSON.stringify(blocked.json?.error)}`
    );
    note(`C:\\Windows -> 400 (${JSON.stringify(blocked.json.error)})`);

    const corpusDir = path.join(server.tempDir, "corpus");
    fs.mkdirSync(corpusDir, { recursive: true });
    const allowed = await server.rpc("save_auth_config", {
      config: { local_corpus_dir: corpusDir },
    });
    assert(
      allowed.status === 200 && allowed.json?.ok === true,
      `temp corpus: expected 200, got ${allowed.status}: ${allowed.body.slice(0, 200)}`
    );
    const persisted = JSON.parse(readConfig(server));
    assert(
      persisted.local_corpus_dir === corpusDir,
      `config.json local_corpus_dir=${JSON.stringify(persisted.local_corpus_dir)}`
    );
    note(`temp corpus -> 200 and persisted`);
  });

  await step(9, "proxy secret is redacted on read but preserved server-side (round-trip guard)", async () => {
    const saved = await server.rpc("save_auth_config", {
      config: { proxy_url: PROXY_URL },
    });
    assert(
      saved.status === 200 && saved.json?.ok === true,
      `save real proxy: expected 200, got ${saved.status}: ${saved.body.slice(0, 200)}`
    );

    const read = await server.rpc("get_auth_config");
    assert(read.status === 200, `get_auth_config: expected 200, got ${read.status}`);
    const masked = read.json?.data?.proxy_url;
    assert(typeof masked === "string", `expected proxy_url string, got ${JSON.stringify(masked)}`);
    assert(masked.includes("***"), `expected masked proxy, got ${JSON.stringify(masked)}`);
    assert(!masked.includes(SECRET), `secret leaked in get_auth_config: ${masked}`);
    note(`get_auth_config proxy_url=${masked}`);

    const onDisk = readConfig(server);
    assert(
      onDisk.includes(SECRET),
      `config.json lost the real secret after save: ${onDisk.slice(0, 300)}`
    );
    note("config.json retains real secret (server-side)");

    const roundTrip = await server.rpc("save_auth_config", {
      config: { proxy_url: masked },
    });
    assert(
      roundTrip.status === 200 && roundTrip.json?.ok === true,
      `save masked proxy: expected 200, got ${roundTrip.status}: ${roundTrip.body.slice(0, 200)}`
    );

    const after = readConfig(server);
    assert(
      after.includes(SECRET),
      `round-trip overwrote the real secret with the mask: ${after.slice(0, 300)}`
    );
    note("masked round-trip preserved real secret");
  });

  let caseId = null;
  let snapshot = null;

  await step(10, "strict-anonymity offline investigation fails closed and completes", async () => {
    // A configured SOCKS proxy counts as an anonymity route, so clear both the
    // proxy and any Tor endpoint before exercising the strict fail-closed path.
    const reset = await server.rpc("save_auth_config", {
      config: { proxy_url: "", tor_socks_url: "socks5h://127.0.0.1:1" },
    });
    assert(
      reset.status === 200,
      `offline setup: expected 200, got ${reset.status}: ${reset.body.slice(0, 200)}`
    );

    const started = await server.rpc(
      "start_investigation",
      {
        input: {
          full_name: SYNTHETIC_NAME,
          strict_anonymity: true,
          enable_tor: false,
          passive_only: true,
          depth_level: 1,
          email: "",
          org: "",
          handle: "",
          phone: "",
          domain: "",
        },
      },
      { timeoutMs: 20_000 }
    );
    assert(
      started.status === 200 && started.json?.ok === true,
      `start_investigation: expected 200, got ${started.status}: ${started.body.slice(0, 300)}`
    );
    caseId = started.json?.data;
    assert(
      typeof caseId === "string" && caseId.length > 0,
      `expected case_id string, got ${JSON.stringify(caseId)}`
    );
    note(`case_id=${caseId}`);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await server.rpc("get_case_snapshot", { caseId }, { timeoutMs: 5_000 });
      assert(
        res.status === 200 && res.json?.ok === true,
        `snapshot poll failed: status=${res.status} body=${res.body.slice(0, 200)}`
      );
      snapshot = res.json.data;
      if (
        (snapshot?.stats?.tools_completed ?? 0) >= 1 &&
        (snapshot?.stats?.total_nodes ?? 0) >= 1
      ) {
        break;
      }
      await sleep(250);
    }

    assert(snapshot, "no snapshot was returned");
    assert(
      (snapshot.stats?.tools_completed ?? 0) >= 1,
      `tools_completed=${snapshot.stats?.tools_completed} after 20s (tools_total=${snapshot.stats?.tools_total})`
    );
    assert(
      (snapshot.stats?.total_nodes ?? 0) >= 1,
      `total_nodes=${snapshot.stats?.total_nodes} after 20s`
    );
    note(
      `tools_completed=${snapshot.stats.tools_completed} tools_total=${snapshot.stats.tools_total} total_nodes=${snapshot.stats.total_nodes}`
    );

    const torRun = (snapshot.tool_runs || []).find((r) => r.tool === "tor-socks5h");
    if (torRun) {
      note(`tor run state=${torRun.state} detail=${JSON.stringify(torRun.detail)}`);
    }

    assert(server.isAlive(), "server process died during offline investigation");
    const after = await server.rpc("list_cases");
    assert(
      after.status === 200 && Array.isArray(after.json?.data),
      `list_cases after investigation failed: status=${after.status}`
    );
  });

  await step(11, "dossier export returns HTML with identity; redaction path runs", async () => {
    assert(caseId, "no case_id from step 10");
    const plain = await server.rpc("export_dossier_html", { caseId, redact: false });
    assert(plain.status === 200, `expected 200, got ${plain.status}: ${plain.body.slice(0, 200)}`);
    assert(typeof plain.json?.data === "string", `expected HTML string, got ${typeof plain.json?.data}`);
    assert(
      plain.json.data.includes("<!doctype html>"),
      "dossier missing <!doctype html>"
    );
    assert(
      plain.json.data.includes(SYNTHETIC_NAME),
      `dossier missing synthetic name ${SYNTHETIC_NAME}`
    );

    const redacted = await server.rpc("export_dossier_html", { caseId, redact: true });
    assert(
      redacted.status === 200 && typeof redacted.json?.data === "string",
      `redacted dossier failed: status=${redacted.status}`
    );
    const email = snapshot?.input?.email || "";
    if (email) {
      assert(
        !redacted.json.data.includes(email),
        `redacted dossier still contains ${email}`
      );
      note("redacted dossier does not contain the synthetic email");
    } else {
      note("case input email is empty, so the email-redaction sub-check is not applicable");
    }
    assert(
      redacted.json.data.includes("REDACTED BRIEF"),
      "redacted dossier missing REDACTED BRIEF marker"
    );
    note(`dossier bytes plain=${plain.json.data.length} redacted=${redacted.json.data.length}`);
  });

  await step(12, "/events streams an initial ': connected' frame then aborts cleanly", async () => {
    const res = await server.readFirstChunk("/events", {
      headers: { Host: `127.0.0.1:${server.port}` },
      timeoutMs: 5_000,
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      String(res.headers["content-type"] || "").includes("text/event-stream"),
      `unexpected content-type: ${res.headers["content-type"]}`
    );
    assert(
      res.chunk.includes(": connected"),
      `first chunk missing ': connected': ${JSON.stringify(res.chunk.slice(0, 120))}`
    );
    note(`chunk=${JSON.stringify(res.chunk.slice(0, 40))}`);
  });

  await step(13, "shutdown requires launcher header, then exits", async () => {
    const denied = await server.rawRequest("/__tauf_shutdown__", {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert(
      denied.status === 403,
      `without X-TAUF-Launcher: expected 403, got ${denied.status}: ${denied.body.slice(0, 200)}`
    );

    const allowed = await server.rawRequest("/__tauf_shutdown__", {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        "Content-Type": "application/json",
        "X-TAUF-Launcher": "1",
      },
      body: "{}",
    });
    assert(
      allowed.status === 200,
      `with X-TAUF-Launcher: expected 200, got ${allowed.status}: ${allowed.body.slice(0, 200)}`
    );
    assert(allowed.json?.ok === true, `expected ok:true, got ${JSON.stringify(allowed.json)}`);
    note(`denied=${denied.status} allowed=${allowed.status}`);

    const exit = await server.waitForExit(5_000);
    assert(exit.exited, "child process did not exit within 5s of shutdown");
    note(`exit code=${exit.code} signal=${exit.signal}`);
  });

  await step(14, "health endpoint is unreachable after shutdown", async () => {
    let reachable = null;
    let lastError = null;
    for (let i = 0; i < 6; i += 1) {
      try {
        const res = await server.rawRequest("/__tauf_health__", { timeoutMs: 800 });
        if (res.status === 200) reachable = res;
      } catch (err) {
        lastError = err;
      }
      await sleep(200);
    }
    assert(!reachable, "health endpoint still returned 200 after shutdown");
    assert(server.child.exitCode !== null || server.child.signalCode !== null, "child still running");
    note(`last error=${lastError?.code || lastError?.message}`);
  });
} catch (err) {
  failures += 1;
  checks += 1;
  console.error(`HARNESS ERROR: ${err.stack || err.message}`);
} finally {
  if (server) {
    const errors = await server.cleanup();
    if (errors.length) {
      console.error(`CLEANUP WARNINGS: ${errors.join("; ")}`);
    }
    const { stdout, stderr } = server.logs();
    if (failures > 0) {
      console.error("\n--- server stdout (tail) ---");
      console.error(stdout.split("\n").slice(-40).join("\n"));
      console.error("--- server stderr (tail) ---");
      console.error(stderr.split("\n").slice(-40).join("\n"));
    }
  }
  console.log("");
  console.log(`SUMMARY: ${checks - failures}/${checks} checks passed, ${failures} failed`);
  process.exitCode = failures > 0 ? 1 : 0;
}
