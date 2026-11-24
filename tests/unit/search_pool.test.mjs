// Standalone unit suite for the TAUF V6 sticky-circuit search pool.
//
// Run:
//   "C:\Users\laksh\AppData\Local\OpenAI\Codex\runtimes\cua_node\76f5b5935a63c7ba\bin\node.exe" tests/unit/search_pool.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails.
// No network, no Tor, no real-person data: fetch/parse/challenge are fakes.

import {
  StickyCircuitPool,
  dedupeByUrl,
  isEmptyParserResult,
  runEngineWithRetry,
  runStreamingSearchUnion,
} from "../../scripts/engine/search_pool.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, got) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`FAIL  ${label}  got=${JSON.stringify(got)}`);
  }
}

function section(title) {
  console.log(`\n# ${title}`);
}

function page(html, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => html,
  };
}

const bigPage = (extra = "") => `<html><body>${"x".repeat(20050)}${extra}</body></html>`;
const tokenFactory = () => {
  let n = 0;
  return () => `tauf-test-${++n}`;
};
const keysOf = (items) => items.map((item) => String(item.url || "").trim().toLowerCase().replace(/\/+$/, ""));

async function main() {
  // -------------------------------------------------------------------------
  // 1. StickyCircuitPool: reuse, rotation, slot bound
  // -------------------------------------------------------------------------
  section("1. StickyCircuitPool");
  {
    const pool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const first = pool.acquire();
    const initial = pool.stats();
    check("[1] first acquire creates one token", initial.size === 1 && initial.healthy === 1, initial);

    pool.markSuccess(first);
    const reused = pool.acquire();
    check("[1] healthy token is reused across calls", reused === first, { first, reused });
    check(
      "[1] reused token is sticky in stats",
      pool.stats().tokens[0]?.sticky === true && pool.stats().tokens[0]?.token === first,
      pool.stats()
    );

    pool.markFailure(first, "challenge");
    const rotated = pool.acquire();
    check("[1] markFailure rotates to a fresh token", rotated !== first, { first, rotated });
    check(
      "[1] failed token is gone and never reissued",
      !pool.stats().tokens.some((entry) => entry.token === first) && pool.stats().size === 1,
      pool.stats()
    );

    // Even a factory that tries to replay the removed value must not leak it.
    const replayPool = new StickyCircuitPool({ maxSlots: 1, makeToken: () => "constant-token" });
    const doomed = replayPool.acquire();
    replayPool.markFailure(doomed, "timeout");
    const replacement = replayPool.acquire();
    check("[1] removed token is never returned again", replacement !== doomed, { doomed, replacement });
  }

  {
    const pool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const a = pool.acquire();
    const b = pool.acquire();
    check("[1] creates up to maxSlots tokens", a !== b && pool.stats().size === 2, { a, b, stats: pool.stats() });

    const c = pool.acquire();
    check(
      "[1] acquire at maxSlots recycles instead of growing",
      pool.stats().size === 2 && (c === a || c === b),
      { c, stats: pool.stats() }
    );

    pool.markSuccess(b);
    check("[1] proven token wins after the pool is full", pool.acquire() === b, { b, stats: pool.stats() });

    pool.markFailure(a, "circuit_error");
    const afterEvict = pool.acquire();
    check(
      "[1] evicted token is never returned; sticky token is reused",
      afterEvict === b && pool.stats().size === 1,
      { a, b, afterEvict, stats: pool.stats() }
    );

    // With no proven token, eviction frees a slot for a fresh circuit.
    const evictionPool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const x = evictionPool.acquire();
    const y = evictionPool.acquire();
    evictionPool.markFailure(x, "circuit_error");
    const z = evictionPool.acquire();
    check(
      "[1] eviction frees a slot for a new token",
      z !== x && z !== y && evictionPool.stats().size === 2,
      { x, y, z, stats: evictionPool.stats() }
    );
  }

  // -------------------------------------------------------------------------
  // 2. isEmptyParserResult
  // -------------------------------------------------------------------------
  section("2. isEmptyParserResult");
  {
    check("[2] 0 items + large page -> true", isEmptyParserResult([], bigPage()) === true, bigPage().length);
    check("[2] 0 items + small page -> false", isEmptyParserResult([], "<html>ok</html>") === false, 15);
    check(
      "[2] 1 item + large page -> false",
      isEmptyParserResult([{ url: "https://example.org/a" }], bigPage()) === false,
      "1 item"
    );
    check("[2] non-array -> false", isEmptyParserResult(null, bigPage()) === false, null);
  }

  // -------------------------------------------------------------------------
  // 3. runEngineWithRetry: parser_empty on attempt 0 retries on a new token
  // -------------------------------------------------------------------------
  section("3. runEngineWithRetry");
  {
    const pool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const tokens = [];
    let calls = 0;

    const fetchPage = async ({ socksUser }) => {
      calls += 1;
      tokens.push(socksUser);
      return page(calls === 1 ? bigPage() : "<html>clean page</html>");
    };
    const parseResults = () =>
      calls === 1 ? [] : [{ url: "https://example.org/alice", title: "Alice", snippet: "ok" }];

    const result = await runEngineWithRetry({
      engineId: "startpage",
      query: "alice example",
      circuitPool: pool,
      fetchPage,
      parseResults,
      detectChallenge: () => null,
      maxAttempts: 3,
    });

    check("[3] parser_empty on attempt 0 -> success", result.ok === true, result);
    check("[3] success reports attempts=2", result.attempts === 2, result);
    check("[3] returned one parsed item", result.items.length === 1, result.items);
    check(
      "[3] retry used two different circuits",
      tokens.length === 2 && tokens[0] !== tokens[1],
      tokens
    );
    check(
      "[3] successful token is sticky in the pool",
      pool.stats().size === 1 && pool.stats().tokens[0]?.token === tokens[1] && pool.stats().tokens[0]?.sticky === true,
      pool.stats()
    );
  }

  // -------------------------------------------------------------------------
  // 4. runEngineWithRetry: challenge / timeout / HTTP errors exhaust retries
  // -------------------------------------------------------------------------
  section("4. retry reasons");
  {
    const pool = new StickyCircuitPool({ maxSlots: 3, makeToken: tokenFactory() });
    const seen = [];
    const result = await runEngineWithRetry({
      engineId: "ddg-lite",
      query: "q",
      circuitPool: pool,
      fetchPage: async ({ socksUser }) => {
        seen.push(socksUser);
        return page("<html><div class='anomaly-modal'></div></html>");
      },
      parseResults: () => [],
      detectChallenge: () => "search engine anomaly challenge",
      maxAttempts: 2,
    });
    check("[4] challenge retries then fails", result.ok === false && result.attempts === 2, result);
    check("[4] challenge reason is legible", result.reason === "challenge", result.reason);
    check("[4] challenge rotated circuits", seen.length === 2 && seen[0] !== seen[1], seen);
    check("[4] all challenged circuits evicted", pool.stats().size === 0, pool.stats());

    const timeoutPool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const timeout = await runEngineWithRetry({
      engineId: "brave",
      query: "q",
      circuitPool: timeoutPool,
      fetchPage: async () => {
        throw new Error("socket timed out after 15000ms");
      },
      parseResults: () => [],
      detectChallenge: () => null,
      maxAttempts: 2,
    });
    check("[4] timeout retries then fails", timeout.ok === false && timeout.attempts === 2, timeout);
    check("[4] timeout reason is legible", timeout.reason === "timeout", timeout.reason);

    const httpPool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const httpErr = await runEngineWithRetry({
      engineId: "mojeek",
      query: "q",
      circuitPool: httpPool,
      fetchPage: async () => page("", { ok: false, status: 429 }),
      parseResults: () => [],
      detectChallenge: (res) => (res.status === 429 ? "HTTP 429 rate-limited" : null),
      maxAttempts: 2,
    });
    check("[4] HTTP failure retries then fails", httpErr.ok === false && httpErr.attempts === 2, httpErr);
    check("[4] HTTP reason comes from detectChallenge", httpErr.reason === "HTTP 429 rate-limited", httpErr.reason);

    const abortedPool = new StickyCircuitPool({ makeToken: tokenFactory() });
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const aborted = await runEngineWithRetry({
      engineId: "startpage",
      query: "q",
      circuitPool: abortedPool,
      fetchPage: async () => {
        fetchCalls += 1;
        return page("");
      },
      parseResults: () => [],
      detectChallenge: () => null,
      maxAttempts: 3,
      signal: controller.signal,
    });
    check("[4] pre-aborted signal returns aborted", aborted.reason === "aborted" && aborted.attempts === 0, aborted);
    check("[4] pre-aborted signal performs no fetch", fetchCalls === 0, fetchCalls);
  }

  // -------------------------------------------------------------------------
  // 5. dedupeByUrl
  // -------------------------------------------------------------------------
  section("5. dedupeByUrl");
  {
    const a = { url: "https://Example.org/Alpha/" };
    const b = { url: "https://example.org/alpha" };
    const c = { url: "https://example.org/beta/" };
    const d = { url: "https://example.org/beta" };
    const unique = dedupeByUrl([a, b, c, d]);
    check("[5] case + trailing slash collapse", unique.length === 2, unique);
    check("[5] first occurrence is preserved", unique[0] === a && unique[1] === c, unique);

    const byId = dedupeByUrl(
      [
        { id: "x", url: "https://example.org/1" },
        { id: "x", url: "https://example.org/2" },
        { id: "y", url: "https://example.org/3" },
      ],
      (item) => item.id
    );
    check("[5] custom keyFn is honoured", byId.length === 2 && byId[0].url.endsWith("/1"), byId);
    check("[5] empty input -> empty", dedupeByUrl([]).length === 0, []);
  }

  // -------------------------------------------------------------------------
  // 6. runStreamingSearchUnion: primary union + live dedupe
  // -------------------------------------------------------------------------
  section("6. streaming union");
  {
    const engines = [
      { id: "startpage" },
      { id: "ddg-lite" },
      { id: "ddg-html" },
      { id: "brave" },
      { id: "mojeek" },
    ];
    const pool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const calls = [];
    const fixtures = {
      startpage: [
        { url: "https://Example.org/Alpha/", title: "Alpha (SP)" },
        { url: "https://example.org/shared", title: "Shared (SP)" },
      ],
      "ddg-lite": [
        { url: "https://example.org/alpha", title: "Alpha (DDG)" },
        { url: "https://example.org/shared/", title: "Shared (DDG)" },
        { url: "https://example.org/beta", title: "Beta (DDG)" },
      ],
    };
    const emitted = [];

    const result = await runStreamingSearchUnion({
      queries: ["alice example"],
      engines,
      circuitPool: pool,
      fetchPage: async ({ engineId }) => {
        calls.push(engineId);
        return page(`<html>${engineId}</html>`);
      },
      parseResults: (engineId) => fixtures[engineId] || [],
      detectChallenge: () => null,
      onItem: (item) => emitted.push(item),
      concurrency: 2,
    });

    check("[6] union returns three unique URLs", result.items.length === 3, result.items);
    check("[6] duplicates across engines collapsed", new Set(keysOf(result.items)).size === 3, keysOf(result.items));
    check("[6] onItem fired for each unique item", emitted.length === 3, emitted.length);
    check("[6] dedupe preserved first occurrence", keysOf(result.items).includes("https://example.org/alpha"), keysOf(result.items));
    check("[6] only the first two engines ran", calls.length === 2 && calls.includes("startpage") && calls.includes("ddg-lite"), calls);
    check("[6] no notices on clean primaries", result.notices.length === 0, result.notices);
    check("[6] not aborted", result.aborted === false, result.aborted);
  }

  // -------------------------------------------------------------------------
  // 7. runStreamingSearchUnion: ordered fallback to Brave/Mojeek
  // -------------------------------------------------------------------------
  section("7. streaming fallback");
  {
    const engines = [
      { id: "startpage" },
      { id: "ddg-lite" },
      { id: "ddg-html" },
      { id: "brave" },
      { id: "mojeek" },
    ];
    const pool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const calls = [];
    const fixtures = {
      brave: [{ url: "https://example.org/brave-result", title: "Brave" }],
      mojeek: [{ url: "https://example.org/mojeek-result", title: "Mojeek" }],
    };

    const result = await runStreamingSearchUnion({
      queries: ["alice example"],
      engines,
      circuitPool: pool,
      fetchPage: async ({ engineId }) => {
        calls.push(engineId);
        if (engineId === "startpage") return page("<html><div class='anomaly-modal'></div></html>");
        if (engineId === "ddg-lite") return page(bigPage());
        if (engineId === "ddg-html") return page("<html><p>unusual traffic</p></html>");
        return page(`<html>${engineId}</html>`);
      },
      parseResults: (engineId) => fixtures[engineId] || [],
      detectChallenge: (res, html) =>
        /anomaly-modal|unusual traffic/i.test(html) ? "challenge detected" : null,
      onItem: () => {},
      concurrency: 2,
    });

    check(
      "[7] fallback finds Brave after three primary failures",
      result.items.length === 1 && result.items[0].url === "https://example.org/brave-result",
      result.items
    );
    check(
      "[7] engines are tried in order up to the first success",
      calls.join(",") === "startpage,ddg-lite,ddg-html,brave",
      calls
    );
    check("[7] Mojeek is not launched after success", !calls.includes("mojeek"), calls);
    check(
      "[7] notices record engine: reason",
      result.notices.includes("startpage: challenge") &&
        result.notices.includes("ddg-lite: parser_empty") &&
        result.notices.includes("ddg-html: challenge"),
      result.notices
    );
    check("[7] not aborted", result.aborted === false, result.aborted);
  }

  // -------------------------------------------------------------------------
  // 8. Abort retention: emitted item survives, no fallback engine launches
  // -------------------------------------------------------------------------
  section("8. abort retention");
  {
    const engines = [{ id: "startpage" }, { id: "ddg-lite" }, { id: "brave" }];
    const pool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const controller = new AbortController();
    const calls = [];
    const emitted = [];

    const result = await runStreamingSearchUnion({
      queries: ["alice example"],
      engines,
      circuitPool: pool,
      signal: controller.signal,
      fetchPage: async ({ engineId, signal }) => {
        calls.push(engineId);
        if (engineId === "startpage") {
          return page("<html>startpage</html>");
        }
        // The second primary stays in flight until the abort tears it down.
        return new Promise((_, reject) => {
          const abort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
      parseResults: (engineId) =>
        engineId === "startpage"
          ? [
              { url: "https://example.org/kept", title: "Kept" },
              { url: "https://example.org/discarded", title: "Discarded" },
            ]
          : [{ url: "https://example.org/late", title: "Late" }],
      detectChallenge: () => null,
      onItem: (item) => {
        emitted.push(item);
        if (emitted.length === 1) controller.abort();
      },
      concurrency: 2,
    });

    check("[8] emitted item is retained after abort", result.items.length === 1 && result.items[0].url === "https://example.org/kept", result.items);
    check("[8] onItem saw exactly the retained item", emitted.length === 1, emitted);
    check("[8] result reports aborted", result.aborted === true, result.aborted);
    check("[8] only the two in-flight primaries launched", !calls.includes("brave") && calls.length === 2, calls);
    check("[8] no items emitted after abort", !keysOf(result.items).includes("https://example.org/late"), keysOf(result.items));
  }

  {
    // Even a fake fetch that ignores the signal must not hold the union open.
    const engines = [{ id: "startpage" }, { id: "ddg-lite" }, { id: "brave" }];
    const pool = new StickyCircuitPool({ maxSlots: 2, makeToken: tokenFactory() });
    const controller = new AbortController();
    const calls = [];

    const result = await runStreamingSearchUnion({
      queries: ["alice example"],
      engines,
      circuitPool: pool,
      signal: controller.signal,
      fetchPage: async ({ engineId }) => {
        calls.push(engineId);
        if (engineId === "startpage") return page("<html>startpage</html>");
        return new Promise(() => {}); // deliberately never settles and ignores abort
      },
      parseResults: (engineId) =>
        engineId === "startpage"
          ? [
              { url: "https://example.org/kept", title: "Kept" },
              { url: "https://example.org/never", title: "Never" },
            ]
          : [],
      detectChallenge: () => null,
      onItem: () => controller.abort(),
      concurrency: 2,
    });

    check(
      "[8] non-cooperative in-flight fetch cannot block abort",
      result.items.length === 1 && result.items[0].url === "https://example.org/kept" && result.aborted === true,
      result
    );
    check("[8] hung primary does not trigger fallback", !calls.includes("brave"), calls);
  }

  {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await runStreamingSearchUnion({
      queries: ["q1", "q2"],
      engines: [{ id: "startpage" }],
      signal: controller.signal,
      fetchPage: async () => {
        calls += 1;
        return page("<html>never</html>");
      },
      parseResults: () => [],
      detectChallenge: () => null,
      onItem: () => {},
      concurrency: 2,
    });
    check("[8] pre-aborted union performs no fetches", calls === 0 && result.items.length === 0, { calls, result });
    check("[8] pre-aborted union reports aborted", result.aborted === true, result.aborted);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failing checks:");
    for (const label of failures) console.log(`  - ${label}`);
    process.exit(1);
  }
  console.log("Search pool unit suite OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("Search pool unit suite crashed:", err);
  process.exit(1);
});
