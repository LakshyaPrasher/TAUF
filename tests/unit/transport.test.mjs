// Standalone unit suite for the SOCKS5h transport helpers (NET-6 / NET-7).
//
// Run:
//   node tests/unit/transport.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails.
// The functions under test are extracted from the shipped local-server.mjs, so
// this exercises the real code path. No network, no Tor, no file fixtures.

import { makeApi } from "./extract.mjs";

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

const { parseHttpHead, buildRedirectOptions } = makeApi(["parseHttpHead", "buildRedirectOptions"]);

// ---------------------------------------------------------------------------
// 1. NET-7 — parseHttpHead keeps every Set-Cookie value
// ---------------------------------------------------------------------------
section("1. NET-7 parseHttpHead");
{
  const head = [
    "HTTP/1.1 200 OK",
    "Content-Type: text/html; charset=utf-8",
    "Set-Cookie: a=1; Path=/; HttpOnly",
    "X-Dup: first",
    "set-cookie: b=2; Path=/; Secure",
    "X-Dup: last",
    "",
  ].join("\r\n");

  const parsed = parseHttpHead(head);

  check("[1] status line -> 200", parsed.status === 200, parsed.status);
  check("[1] setCookies.length === 2", parsed.setCookies.length === 2, parsed.setCookies);
  check(
    "[1] setCookies preserves both values in order",
    parsed.setCookies[0] === "a=1; Path=/; HttpOnly" && parsed.setCookies[1] === "b=2; Path=/; Secure",
    parsed.setCookies
  );

  const joined = parsed.headers.get("set-cookie");
  check(
    "[1] headers.get('set-cookie') contains both cookies",
    typeof joined === "string" && joined.includes("a=1") && joined.includes("b=2"),
    joined
  );

  check(
    "[1] duplicate non-cookie headers are last-wins",
    parsed.headers.get("x-dup") === "last",
    parsed.headers.get("x-dup")
  );
  check(
    "[1] header names are lowercased",
    parsed.headers.get("content-type") === "text/html; charset=utf-8" &&
      !parsed.headers.has("Content-Type"),
    parsed.headers.get("content-type")
  );
  check(
    "[1] single set-cookie still lands in setCookies",
    (() => {
      const single = parseHttpHead("HTTP/1.0 204 No Content\r\nSet-Cookie: solo=1\r\n");
      return single.setCookies.length === 1 && single.setCookies[0] === "solo=1";
    })(),
    "solo"
  );
}

// ---------------------------------------------------------------------------
// 2. NET-6 — buildRedirectOptions, same host
// ---------------------------------------------------------------------------
section("2. NET-6 same-host redirect");
{
  const opts = {
    method: "GET",
    headers: {
      Cookie: "session=abc",
      Authorization: "Bearer token-123",
      Accept: "text/html",
    },
  };
  const next = buildRedirectOptions(opts, 302, "example.com", "example.com");

  check("[2] same host preserves Cookie", next.headers.Cookie === "session=abc", next.headers);
  check(
    "[2] same host preserves Authorization",
    next.headers.Authorization === "Bearer token-123",
    next.headers
  );
  check("[2] same host preserves other headers", next.headers.Accept === "text/html", next.headers);
  check("[2] returns a new options object", next !== opts, next === opts);
  check("[2] caller opts.headers not mutated", opts.headers.Cookie === "session=abc", opts.headers);
}

// ---------------------------------------------------------------------------
// 3. NET-6 — buildRedirectOptions, cross host
// ---------------------------------------------------------------------------
section("3. NET-6 cross-host redirect");
{
  const opts = {
    method: "GET",
    headers: {
      Cookie: "session=abc",
      cookie: "lower=1",
      Authorization: "Bearer token-123",
      authorization: "Basic Zm9vOmJhcg==",
      Accept: "application/json",
      "X-Trace": "keep-me",
    },
  };
  const next = buildRedirectOptions(opts, 302, "example.com", "other.test");
  const keys = Object.keys(next.headers);

  check(
    "[3] drops Cookie/cookie",
    !keys.some((k) => k.toLowerCase() === "cookie"),
    next.headers
  );
  check(
    "[3] drops Authorization/authorization",
    !keys.some((k) => k.toLowerCase() === "authorization"),
    next.headers
  );
  check(
    "[3] preserves other headers",
    next.headers.Accept === "application/json" && next.headers["X-Trace"] === "keep-me",
    next.headers
  );
  check("[3] host compare is case-insensitive", (() => {
    const same = buildRedirectOptions(
      { headers: { Cookie: "c=1" } },
      302,
      "Example.COM",
      "example.com"
    );
    return same.headers.Cookie === "c=1";
  })(), "case-insensitive");
}

// ---------------------------------------------------------------------------
// 4. NET-6 — method/body rules
// ---------------------------------------------------------------------------
section("4. NET-6 method and body rules");
{
  const postOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"q":1}' };

  const seeOther = buildRedirectOptions(postOpts, 303, "example.com", "example.com");
  check("[4] 303 POST -> GET", seeOther.method === "GET", seeOther.method);
  check("[4] 303 POST -> body cleared", seeOther.body === undefined, seeOther.body);

  const temp307 = buildRedirectOptions(postOpts, 307, "example.com", "example.com");
  check("[4] 307 POST preserves method", temp307.method === "POST", temp307.method);
  check("[4] 307 POST preserves body", temp307.body === '{"q":1}', temp307.body);

  const perm308 = buildRedirectOptions(postOpts, 308, "example.com", "example.com");
  check("[4] 308 POST preserves method", perm308.method === "POST", perm308.method);
  check("[4] 308 POST preserves body", perm308.body === '{"q":1}', perm308.body);

  const moved301 = buildRedirectOptions(postOpts, 301, "example.com", "example.com");
  check("[4] 301 POST -> GET", moved301.method === "GET", moved301.method);
  check("[4] 301 POST -> body cleared", moved301.body === undefined, moved301.body);

  const found302Get = buildRedirectOptions({ method: "GET", body: "ignored" }, 302, "a.test", "a.test");
  check("[4] 302 GET stays GET", found302Get.method === "GET", found302Get.method);

  const found302Head = buildRedirectOptions({ method: "HEAD" }, 302, "a.test", "a.test");
  check("[4] 302 HEAD stays HEAD", found302Head.method === "HEAD", found302Head.method);
}

// ---------------------------------------------------------------------------
// 5. Status line parsing edge cases
// ---------------------------------------------------------------------------
section("5. status line parsing");
{
  check("[5] HTTP/1.1 200 OK -> 200", parseHttpHead("HTTP/1.1 200 OK").status === 200, parseHttpHead("HTTP/1.1 200 OK").status);
  check(
    "[5] HTTP/1.0 404 Not Found -> 404",
    parseHttpHead("HTTP/1.0 404 Not Found\r\nContent-Length: 0").status === 404,
    404
  );
  check(
    "[5] unparseable status line -> 0",
    parseHttpHead("garbage\r\nX: y").status === 0,
    parseHttpHead("garbage\r\nX: y").status
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`Failures:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
