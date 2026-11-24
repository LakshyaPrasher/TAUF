/**
 * TAUF V6 — sticky-circuit multi-engine search pool
 * --------------------------------------------------
 * Zero-dependency ESM helpers for the search cascade. Nothing in this module
 * performs network I/O: `fetchPage`, `parseResults` and `detectChallenge` are
 * injected, so the whole pipeline can be exercised offline with fixtures.
 *
 * Two layers live here:
 *
 *   StickyCircuitPool
 *     A small pool of `socksUser` tokens (RFC 1929 usernames used by Tor's
 *     IsolateSOCKSAuth). A token that produced a clean parse is marked sticky
 *     and reused; a challenged/timeout token is removed immediately so the
 *     next attempt runs on a fresh circuit.
 *
 *   runEngineWithRetry / runStreamingSearchUnion
 *     Retry one engine over fresh circuits, or stream a query across several
 *     engines (first two concurrently, then ordered fallbacks) while emitting
 *     every parsed item the moment it is seen.
 *
 * The parser-empty rule is deliberate: a large 200 OK page that parses to zero
 * items is treated as a parser failure and retried on a new circuit. Attempt 0
 * is retried like every other attempt (the old cascade aborted too early).
 *
 *   import { StickyCircuitPool, runEngineWithRetry } from "./search_pool.mjs";
 *
 *   const pool = new StickyCircuitPool({ maxSlots: 2 });
 *   const out = await runEngineWithRetry({
 *     engineId: "startpage",
 *     query: "example query",
 *     circuitPool: pool,
 *     fetchPage,
 *     parseResults,
 *     detectChallenge,
 *   });
 */

const DEFAULT_TIMEOUT_MS = 15000;
const PARSER_EMPTY_HTML_THRESHOLD = 20000;

let defaultTokenSeq = 0;

function defaultMakeToken() {
  defaultTokenSeq += 1;
  return `tauf-${Date.now()}-${defaultTokenSeq.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalise an item (or bare URL string) to the default dedupe key:
 * lowercased, trimmed, without trailing slash(es).
 *
 * @param {any} item
 * @returns {string}
 */
function defaultUrlKey(item) {
  const raw = typeof item === "string" ? item : item && item.url;
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

function normaliseReason(reason) {
  if (reason === undefined || reason === null || reason === "") return "unknown";
  return String(reason);
}

/**
 * A tiny pool of sticky `socksUser` tokens.
 *
 * New tokens are assumed healthy until proven otherwise. `markSuccess()`
 * promotes one to "sticky", and `acquire()` prefers a sticky token so a
 * circuit that already worked is reused across engines/queries. `markFailure()`
 * evicts the token at once; an evicted token is never handed out again, even
 * if the injected `makeToken` tries to reuse the same string.
 */
export class StickyCircuitPool {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSlots=2] Maximum live tokens.
   * @param {() => string} [options.makeToken] Fresh `socksUser` factory.
   */
  constructor({ maxSlots = 2, makeToken } = {}) {
    const slots = Math.floor(Number(maxSlots));
    this.maxSlots = Number.isFinite(slots) && slots >= 1 ? slots : 2;
    this._makeToken = typeof makeToken === "function" ? makeToken : defaultMakeToken;

    /** @type {Array<{ token: string, healthy: boolean, sticky: boolean, successes: number, failures: number, createdAt: number, lastUsedAt: number }>} */
    this._tokens = [];
    /** @type {Map<string, any>} */
    this._byToken = new Map();
    /** @type {Set<string>} */
    this._removed = new Set();
    this._cursor = 0;
    this._seq = 0;
  }

  _createToken() {
    let token = String(this._makeToken() ?? "").trim();
    if (!token) token = `tauf-${Date.now()}-${this._seq++}`;
    // Never re-issue a token that failed, and never duplicate a live one.
    while (this._byToken.has(token) || this._removed.has(token)) {
      token = `${token}-${this._seq++}`;
    }

    const entry = {
      token,
      healthy: true,
      sticky: false,
      successes: 0,
      failures: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this._tokens.push(entry);
    this._byToken.set(token, entry);
    return token;
  }

  /**
   * Return a healthy token, preferring one already proven good.
   * Creates tokens until `maxSlots` is reached, then recycles live ones.
   *
   * @returns {string}
   */
  acquire() {
    if (this._tokens.length === 0) return this._createToken();

    const sticky = this._tokens.find((entry) => entry.healthy && entry.sticky);
    if (sticky) {
      sticky.lastUsedAt = Date.now();
      return sticky.token;
    }

    if (this._tokens.length < this.maxSlots) return this._createToken();

    const healthy = this._tokens.filter((entry) => entry.healthy);
    const candidates = healthy.length > 0 ? healthy : this._tokens;
    const entry = candidates[this._cursor % candidates.length];
    this._cursor += 1;
    entry.lastUsedAt = Date.now();
    return entry.token;
  }

  /**
   * Mark a token healthy and sticky.
   *
   * @param {string} token
   * @returns {boolean} true when the token belonged to this pool.
   */
  markSuccess(token) {
    const entry = this._byToken.get(token);
    if (!entry) return false;
    entry.healthy = true;
    entry.sticky = true;
    entry.successes += 1;
    entry.lastUsedAt = Date.now();
    return true;
  }

  /**
   * Remove/rotate a token immediately. Unknown or already-removed tokens are
   * ignored so late failures from an in-flight request cannot corrupt the pool.
   *
   * @param {string} token
   * @param {string} [reason]
   * @returns {boolean} true when a live token was removed.
   */
  markFailure(token, reason) {
    const entry = this._byToken.get(token);
    if (!entry) return false;

    entry.failures += 1;
    this._byToken.delete(token);
    this._removed.add(token);

    const index = this._tokens.indexOf(entry);
    if (index >= 0) this._tokens.splice(index, 1);
    return true;
  }

  /**
   * @returns {{ size: number, healthy: number, tokens: Array<{ token: string, healthy: boolean, sticky: boolean, successes: number, failures: number, createdAt: number, lastUsedAt: number }> }}
   */
  stats() {
    return {
      size: this._tokens.length,
      healthy: this._tokens.filter((entry) => entry.healthy).length,
      tokens: this._tokens.map((entry) => ({
        token: entry.token,
        healthy: entry.healthy,
        sticky: entry.sticky,
        successes: entry.successes,
        failures: entry.failures,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
      })),
    };
  }
}

/**
 * A large 200 OK page that parses to zero rows is a parser/anti-bot failure,
 * not a legitimately empty result set.
 *
 * @param {any[]} items
 * @param {string} html
 * @returns {boolean}
 */
export function isEmptyParserResult(items, html) {
  return Array.isArray(items) && items.length === 0 && String(html || "").length > PARSER_EMPTY_HTML_THRESHOLD;
}

/**
 * Deduplicate search items by URL, preserving first occurrence.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} [keyFn]
 * @returns {T[]}
 */
export function dedupeByUrl(items, keyFn) {
  const keyFor = typeof keyFn === "function" ? keyFn : defaultUrlKey;
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = normaliseReason(keyFor(item));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Run one engine over fresh sticky circuits.
 *
 * Every failed attempt (HTTP error, challenge, parser-empty, timeout) evicts
 * its token and retries, including attempt 0. A successful parse marks the
 * token sticky and returns immediately.
 *
 * @param {object} options
 * @param {string} options.engineId
 * @param {string} options.query
 * @param {StickyCircuitPool} [options.circuitPool]
 * @param {(req: { engineId: string, query: string, socksUser: string, timeoutMs: number, signal?: AbortSignal }) => Promise<{ ok: boolean, status?: number, text: () => Promise<string>|string, headers?: any }>} options.fetchPage
 * @param {(engineId: string, html: string, res?: any) => any[]} options.parseResults
 * @param {(res: any, html: string) => any} [options.detectChallenge]
 * @param {(items: any[], html: string) => boolean} [options.isEmptyResult]
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.timeoutMs=15000]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ ok: boolean, items: any[], reason: string, attempts: number }>}
 */
export async function runEngineWithRetry({
  engineId,
  query,
  circuitPool,
  fetchPage,
  parseResults,
  detectChallenge = () => null,
  isEmptyResult = isEmptyParserResult,
  maxAttempts = 3,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("runEngineWithRetry: fetchPage must be a function");
  if (typeof parseResults !== "function") throw new TypeError("runEngineWithRetry: parseResults must be a function");

  const pool = circuitPool || new StickyCircuitPool();
  const limit = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  let attempts = 0;
  let lastReason = "timeout";

  for (let attempt = 0; attempt < limit; attempt++) {
    if (signal?.aborted) return { ok: false, items: [], reason: "aborted", attempts };

    const token = pool.acquire();
    attempts = attempt + 1;

    let res = null;
    let html = "";
    try {
      res = await fetchPage({ engineId, query, socksUser: token, timeoutMs, signal });
      if (res && typeof res.text === "function") {
        const body = await res.text();
        html = body === undefined || body === null ? "" : String(body);
      }
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") {
        return { ok: false, items: [], reason: "aborted", attempts };
      }
      const message = `${err?.name || ""} ${err?.message || err || ""}`;
      lastReason = /timeout|timed out/i.test(message) ? "timeout" : "circuit_error";
      pool.markFailure(token, lastReason);
      continue;
    }

    if (!res || !res.ok) {
      const detected = typeof detectChallenge === "function" ? detectChallenge(res, html) : null;
      lastReason = normaliseReason(detected || "http_error");
      pool.markFailure(token, lastReason);
      continue;
    }

    const challenge = typeof detectChallenge === "function" ? detectChallenge(res, html) : null;
    if (challenge) {
      lastReason = "challenge";
      pool.markFailure(token, "challenge");
      continue;
    }

    let items = [];
    try {
      items = await parseResults(engineId, html, res);
    } catch {
      lastReason = "parser_error";
      pool.markFailure(token, lastReason);
      continue;
    }
    if (!Array.isArray(items)) items = [];

    if (isEmptyResult(items, html)) {
      lastReason = "parser_empty";
      pool.markFailure(token, "parser_empty");
      continue;
    }

    pool.markSuccess(token);
    return { ok: true, items, reason: "ok", attempts };
  }

  return { ok: false, items: [], reason: lastReason, attempts };
}

/**
 * Stream a query set across several engines and emit every unique item as soon
 * as it is parsed.
 *
 * Per query: the first two engines run concurrently. If both fail (challenge,
 * HTTP error, timeout, parser-empty) the remaining engines are tried in order
 * until one returns a clean parse. Queries themselves run with bounded
 * concurrency. `onItem` is called synchronously for each newly seen URL, before
 * the other engine in the pair resolves, so aborting mid-stream keeps every
 * item already handed to the caller.
 *
 * @param {object} options
 * @param {string[]} [options.queries]
 * @param {Array<{ id: string }|string>} [options.engines]
 * @param {StickyCircuitPool} [options.circuitPool]
 * @param {Function} [options.fetchPage]
 * @param {Function} [options.parseResults]
 * @param {Function} [options.detectChallenge]
 * @param {Function} [options.isEmptyResult]
 * @param {AbortSignal} [options.signal]
 * @param {(item: any) => void} [options.onItem]
 * @param {number} [options.concurrency=2]
 * @param {number} [options.timeoutMs=15000]
 * @returns {Promise<{ items: any[], notices: string[], aborted: boolean }>}
 */
export async function runStreamingSearchUnion({
  queries = [],
  engines = [],
  circuitPool,
  fetchPage,
  parseResults,
  detectChallenge = () => null,
  isEmptyResult = isEmptyParserResult,
  signal = null,
  onItem = null,
  concurrency = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("runStreamingSearchUnion: fetchPage must be a function");
  if (typeof parseResults !== "function") throw new TypeError("runStreamingSearchUnion: parseResults must be a function");

  const pool = circuitPool || new StickyCircuitPool();
  const items = [];
  const notices = [];
  const seen = new Set();
  let aborted = false;

  const isAborted = () => Boolean(signal && signal.aborted);
  const markAborted = () => {
    aborted = true;
  };

  // A pending fetch should not hold the union open after the caller aborts.
  // Real fetchPage implementations listen to `signal`, but injected/fake ones
  // may not, so in-flight waits are raced against this promise.
  const ABORTED = Symbol("aborted");
  let releaseAbort = null;
  const abortGate = new Promise((resolve) => {
    releaseAbort = resolve;
  });
  const onAbort = () => {
    markAborted();
    if (releaseAbort) {
      const release = releaseAbort;
      releaseAbort = null;
      release();
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const raceAbort = (promise) => Promise.race([promise, abortGate.then(() => ABORTED)]);

  const emit = (item) => {
    const key = defaultUrlKey(item);
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    items.push(item);
    if (typeof onItem === "function") {
      // The callback is part of the streaming contract; a throwing consumer
      // must not abort the union or lose the item that was just emitted.
      try {
        onItem(item);
      } catch {
        /* ignore consumer callback errors */
      }
    }
    return true;
  };

  const attemptEngine = async (engineId, query) => {
    if (isAborted()) {
      markAborted();
      return { ok: false, items: [], reason: "aborted" };
    }

    const token = pool.acquire();
    let res = null;
    let html = "";

    try {
      res = await fetchPage({ engineId, query, socksUser: token, timeoutMs, signal });
      if (res && typeof res.text === "function") {
        const body = await res.text();
        html = body === undefined || body === null ? "" : String(body);
      }
    } catch (err) {
      if (isAborted() || err?.name === "AbortError") {
        markAborted();
        return { ok: false, items: [], reason: "aborted" };
      }
      const message = `${err?.name || ""} ${err?.message || err || ""}`;
      const reason = /timeout|timed out/i.test(message) ? "timeout" : "circuit_error";
      pool.markFailure(token, reason);
      notices.push(`${engineId}: ${reason}`);
      return { ok: false, items: [], reason };
    }

    if (isAborted()) {
      markAborted();
      return { ok: false, items: [], reason: "aborted" };
    }

    if (!res || !res.ok) {
      const detected = typeof detectChallenge === "function" ? detectChallenge(res, html) : null;
      const reason = normaliseReason(detected || "http_error");
      pool.markFailure(token, reason);
      notices.push(`${engineId}: ${reason}`);
      return { ok: false, items: [], reason };
    }

    const challenge = typeof detectChallenge === "function" ? detectChallenge(res, html) : null;
    if (challenge) {
      pool.markFailure(token, "challenge");
      notices.push(`${engineId}: challenge`);
      return { ok: false, items: [], reason: "challenge" };
    }

    let parsed = [];
    try {
      parsed = await parseResults(engineId, html, res);
    } catch {
      pool.markFailure(token, "parser_error");
      notices.push(`${engineId}: parser_error`);
      return { ok: false, items: [], reason: "parser_error" };
    }
    if (!Array.isArray(parsed)) parsed = [];

    if (isEmptyResult(parsed, html)) {
      pool.markFailure(token, "parser_empty");
      notices.push(`${engineId}: parser_empty`);
      return { ok: false, items: [], reason: "parser_empty" };
    }

    if (isAborted()) {
      markAborted();
      return { ok: false, items: [], reason: "aborted" };
    }

    pool.markSuccess(token);

    // Emit one by one, immediately. If the consumer aborts from `onItem`, the
    // remaining rows are skipped but everything already emitted is retained.
    let emitted = 0;
    for (const item of parsed) {
      if (isAborted()) {
        markAborted();
        break;
      }
      if (emit(item)) emitted += 1;
    }

    return { ok: true, items: parsed, reason: "ok", emitted };
  };

  const runQuery = async (query) => {
    if (isAborted()) {
      markAborted();
      return;
    }

    const engineIds = (Array.isArray(engines) ? engines : [])
      .map((engine) => (typeof engine === "string" ? engine : engine && engine.id))
      .filter(Boolean);
    if (engineIds.length === 0) return;

    const primaries = engineIds.slice(0, 2);
    const fallbacks = engineIds.slice(2);

    const primaryResults = await raceAbort(Promise.all(primaries.map((engineId) => attemptEngine(engineId, query))));
    if (primaryResults === ABORTED || isAborted()) {
      markAborted();
      return;
    }
    // A clean parse (even an empty one on a small page) counts as success;
    // only challenge/error/parser-empty fall through to the backup engines.
    if (primaryResults.some((result) => result.ok)) return;

    for (const engineId of fallbacks) {
      if (isAborted()) {
        markAborted();
        return;
      }
      const result = await raceAbort(attemptEngine(engineId, query));
      if (result === ABORTED || isAborted()) {
        markAborted();
        return;
      }
      if (result.ok) return;
    }
  };

  const queryList = Array.isArray(queries) ? queries : [];
  const requested = Math.floor(Number(concurrency));
  const workerCount = Math.max(
    1,
    Math.min(Number.isFinite(requested) && requested > 0 ? requested : 2, Math.max(1, queryList.length))
  );

  let nextQuery = 0;
  const worker = async () => {
    while (true) {
      if (isAborted()) {
        markAborted();
        return;
      }
      const index = nextQuery;
      nextQuery += 1;
      if (index >= queryList.length) return;
      await runQuery(queryList[index]);
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return { items, notices, aborted: aborted || isAborted() };
}
