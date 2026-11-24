// Standalone unit suite for the WP3 search-cascade reliability work.
//
// Run:
//   "C:\Users\laksh\AppData\Local\OpenAI\Codex\runtimes\cua_node\76f5b5935a63c7ba\bin\node.exe" tests/unit/search.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails.
// detectSearchChallenge / decodeSearchRedirectUrl / the engine-cooldown helpers
// are extracted from the shipped local-server.mjs, so this exercises real code.
// Synthetic fixtures only: no network, no Tor, no real-person data.

import { extractConst, makeApi, source } from "./extract.mjs";

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

const ok200 = () => ({ ok: true, status: 200, headers: { get: () => null } });

// ---------------------------------------------------------------------------
// 1. detectSearchChallenge: DDG / Brave anti-bot markers + negatives
// ---------------------------------------------------------------------------
section("1. detectSearchChallenge");
{
  const { detectSearchChallenge } = makeApi(["decodeHtmlEntities", "detectSearchChallenge"]);

  const ddgAnomaly = `<!doctype html><html><head><title>DuckDuckGo</title></head>
    <body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
    <div class="anomaly-modal">Please complete the following challenge.</div></body></html>`;
  check(
    "[1] DDG anomaly-modal -> challenge",
    Boolean(detectSearchChallenge(ok200(), ddgAnomaly)),
    detectSearchChallenge(ok200(), ddgAnomaly)
  );

  const ddgAnomalyBare = `<html><body><div class="anomaly-modal"></div></body></html>`;
  check(
    "[1] bare anomaly-modal class -> challenge",
    Boolean(detectSearchChallenge(ok200(), ddgAnomalyBare)),
    detectSearchChallenge(ok200(), ddgAnomalyBare)
  );

  const ddgPhrase = `<html><body>Unfortunately, bots use DuckDuckGo too.</body></html>`;
  check(
    "[1] DDG bots phrase -> challenge",
    Boolean(detectSearchChallenge(ok200(), ddgPhrase)),
    detectSearchChallenge(ok200(), ddgPhrase)
  );

  const braveTraffic = `<html><head><title>Brave Search</title></head>
    <body><p>We detected unusual traffic from your network. Please solve the CAPTCHA.</p></body></html>`;
  check(
    "[1] Brave unusual-traffic interstitial -> challenge",
    Boolean(detectSearchChallenge(ok200(), braveTraffic)),
    detectSearchChallenge(ok200(), braveTraffic)
  );

  const braveTrafficBare = `<html><body><h1>Unusual traffic</h1></body></html>`;
  check(
    "[1] case-insensitive unusual traffic -> challenge",
    Boolean(detectSearchChallenge(ok200(), braveTrafficBare)),
    detectSearchChallenge(ok200(), braveTrafficBare)
  );

  const normalSerp = `<html><head><title>example query at DuckDuckGo</title></head>
    <body><div class="result"><a href="https://example.com/">Example</a></div></body></html>`;
  check("[1] clean SERP -> null", detectSearchChallenge(ok200(), normalSerp) === null, detectSearchChallenge(ok200(), normalSerp));

  check(
    "[1] HTTP 429 -> rate limited",
    /429/.test(detectSearchChallenge({ ok: false, status: 429 }, "") || ""),
    detectSearchChallenge({ ok: false, status: 429 }, "")
  );
  check(
    "[1] HTTP 403 -> forbidden",
    /403/.test(detectSearchChallenge({ ok: false, status: 403 }, "") || ""),
    detectSearchChallenge({ ok: false, status: 403 }, "")
  );
  check(
    "[1] missing response -> network failure",
    detectSearchChallenge(null, "") === "network failure",
    detectSearchChallenge(null, "")
  );
}

// ---------------------------------------------------------------------------
// 2. decodeSearchRedirectUrl: /url?q=, RU=, uddg=, direct
// ---------------------------------------------------------------------------
section("2. decodeSearchRedirectUrl");
{
  const { decodeSearchRedirectUrl } = makeApi(["decodeSearchRedirectUrl"]);

  const google = "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&sa=U&ved=abc";
  check(
    "[2] Google /url?q= unwrapped",
    decodeSearchRedirectUrl(google) === "https://example.com/page?a=1",
    decodeSearchRedirectUrl(google)
  );

  const googleRaw = "https://www.google.com/url?q=https://example.com/raw&sa=U";
  check(
    "[2] Google /url?q= with unencoded target",
    decodeSearchRedirectUrl(googleRaw) === "https://example.com/raw",
    decodeSearchRedirectUrl(googleRaw)
  );

  const yahoo =
    "https://search.yahoo.com/r/xyz;_ylt=Awr.junk/RU=https%3a%2f%2fexample.com%2fpath%2f/RK=2/RS=abc-";
  check(
    "[2] Yahoo RU= unwrapped (RK/RS suffix dropped)",
    decodeSearchRedirectUrl(yahoo) === "https://example.com/path/",
    decodeSearchRedirectUrl(yahoo)
  );

  const ddg = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg&rut=zzz";
  check(
    "[2] DDG uddg= unwrapped",
    decodeSearchRedirectUrl(ddg) === "https://example.com/ddg",
    decodeSearchRedirectUrl(ddg)
  );

  const ddgAmp = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=x";
  check(
    "[2] uddg survives &amp; entity + nested query",
    decodeSearchRedirectUrl(ddgAmp) === "https://example.com/a?b=1",
    decodeSearchRedirectUrl(ddgAmp)
  );

  const direct = "https://example.com/page?x=1";
  check("[2] direct URL untouched", decodeSearchRedirectUrl(direct) === direct, decodeSearchRedirectUrl(direct));

  const directNoScheme = "example.com/page?q=test";
  check(
    "[2] non-URL string untouched",
    decodeSearchRedirectUrl(directNoScheme) === directNoScheme,
    decodeSearchRedirectUrl(directNoScheme)
  );

  const generic = "https://jump.example.com/go?url=https%3A%2F%2Ftarget.example%2Flanding";
  check(
    "[2] generic ?url= wrapper unwrapped",
    decodeSearchRedirectUrl(generic) === "https://target.example/landing",
    decodeSearchRedirectUrl(generic)
  );

  check("[2] empty input -> empty", decodeSearchRedirectUrl("") === "", decodeSearchRedirectUrl(""));
}

// ---------------------------------------------------------------------------
// 3. Engine cooldown predicate (2 strikes + ~5 minute window)
// ---------------------------------------------------------------------------
section("3. shouldSkipEngine / strike bookkeeping");
{
  const prelude = [
    extractConst(source, "ENGINE_FAILURE_STRIKES"),
    extractConst(source, "ENGINE_COOLDOWN_MS"),
  ].join("\n");
  const { shouldSkipEngine, recordEngineFailure, recordEngineSuccess } = makeApi(
    ["shouldSkipEngine", "recordEngineFailure", "recordEngineSuccess"],
    {},
    prelude
  );

  const T0 = 1_700_000_000_000;
  check("[3] missing record is not skipped", shouldSkipEngine(undefined, T0) === false, shouldSkipEngine(undefined, T0));
  check("[3] empty record is not skipped", shouldSkipEngine({}, T0) === false, shouldSkipEngine({}, T0));
  check(
    "[3] one strike is not skipped",
    shouldSkipEngine({ reason: "challenge", at: T0, strikes: 1 }, T0) === false,
    shouldSkipEngine({ reason: "challenge", at: T0, strikes: 1 }, T0)
  );
  check(
    "[3] two fresh strikes are skipped",
    shouldSkipEngine({ reason: "challenge", at: T0, strikes: 2 }, T0 + 1_000) === true,
    shouldSkipEngine({ reason: "challenge", at: T0, strikes: 2 }, T0 + 1_000)
  );
  check(
    "[3] cooldown expires after 5 minutes",
    shouldSkipEngine({ reason: "challenge", at: T0, strikes: 2 }, T0 + 5 * 60 * 1000 + 1) === false,
    shouldSkipEngine({ reason: "challenge", at: T0, strikes: 2 }, T0 + 5 * 60 * 1000 + 1)
  );
  check(
    "[3] three strikes still skip while fresh",
    shouldSkipEngine({ reason: "timeout", at: T0, strikes: 3 }, T0 + 60_000) === true,
    shouldSkipEngine({ reason: "timeout", at: T0, strikes: 3 }, T0 + 60_000)
  );
  check(
    "[3] malformed strikes do not skip",
    shouldSkipEngine({ reason: "x", at: T0, strikes: "nope" }, T0) === false,
    shouldSkipEngine({ reason: "x", at: T0, strikes: "nope" }, T0)
  );

  const map = new Map();
  recordEngineFailure(map, "brave", "HTTP 429 rate-limited", T0);
  check("[3] first failure records strikes=1", map.get("brave")?.strikes === 1, map.get("brave"));
  check("[3] engine usable after one failure", shouldSkipEngine(map.get("brave"), T0 + 10) === false, map.get("brave"));

  const second = recordEngineFailure(map, "brave", "HTTP 429 rate-limited", T0 + 20);
  check("[3] second failure records strikes=2", second?.strikes === 2, second);
  check("[3] reason + timestamp persist in record", second.reason === "HTTP 429 rate-limited" && second.at === T0 + 20, second);
  check("[3] engine skipped after two strikes", shouldSkipEngine(map.get("brave"), T0 + 30) === true, map.get("brave"));

  recordEngineSuccess(map, "brave", T0 + 40);
  check(
    "[3] successful parse resets strikes",
    map.get("brave")?.strikes === 0 && shouldSkipEngine(map.get("brave"), T0 + 50) === false,
    map.get("brave")
  );

  const fresh = new Map();
  recordEngineFailure(fresh, "ddg-html", "timeout/unreachable", T0);
  recordEngineFailure(fresh, "ddg-html", "timeout/unreachable", T0 + 5);
  check(
    "[3] cooldown is per-engine",
    shouldSkipEngine(fresh.get("ddg-html"), T0 + 10) === true && shouldSkipEngine(fresh.get("mojeek"), T0 + 10) === false,
    Array.from(fresh.entries())
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failing checks:");
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
console.log("Search cascade unit suite OK");
process.exit(0);
