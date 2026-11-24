// Standalone unit/verification suite for TAUF.
//
// Run:
//   "C:\Users\laksh\AppData\Local\OpenAI\Codex\runtimes\cua_node\76f5b5935a63c7ba\bin\node.exe" tests/unit/functions.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails.
// All data below is synthetic; no network, no Tor, no real-person data.

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
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

const digitsOf = (s) => String(s).replace(/\D/g, "");

// ---------------------------------------------------------------------------
// 1. nameEvidence (token-boundary name gate)
// ---------------------------------------------------------------------------
section("1. nameEvidence");
{
  const { nameEvidence } = makeApi(["normalizeNameText", "escapeRegExp", "nameEvidence"]);

  const strongExact = nameEvidence("Raj Sharma joined Acme", "Raj Sharma");
  check(
    '[1] "Raj Sharma" vs "Raj Sharma joined Acme" -> strong',
    strongExact.strong === true,
    strongExact
  );

  const substringTrap = nameEvidence("Rajasthan tourism", "Raj");
  check(
    '[1] "Raj" vs "Rajasthan tourism" -> not strong',
    substringTrap.strong === false,
    substringTrap
  );
  check(
    '[1] "Raj" vs "Rajasthan tourism" -> not proximity',
    substringTrap.proximity === false,
    substringTrap
  );

  const nearMiss = nameEvidence("Rajesh Sharma", "Raj Sharma");
  check(
    '[1] "Raj Sharma" vs "Rajesh Sharma" -> not strong',
    nearMiss.strong === false,
    nearMiss
  );

  const reversed = nameEvidence("Sharma, Raj", "Raj Sharma");
  check(
    '[1] reversed "Sharma, Raj" vs "Raj Sharma" -> strong',
    reversed.strong === true,
    reversed
  );

  const middle = nameEvidence("Raj Kumar Sharma", "Raj Sharma");
  check(
    '[1] middle name "Raj Kumar Sharma" vs "Raj Sharma" -> strong',
    middle.strong === true,
    middle
  );

  const wideOrder = nameEvidence(
    "Sharma is a common surname and Raj is a common given name",
    "Raj Sharma"
  );
  check(
    "[1] wide / no-order text -> not strong",
    wideOrder.strong === false,
    wideOrder
  );
  check(
    "[1] wide / no-order text -> proximity only",
    wideOrder.proximity === true,
    wideOrder
  );
}

// ---------------------------------------------------------------------------
// 2. scoreProfileMatch (entity-resolution tiers)
// ---------------------------------------------------------------------------
section("2. scoreProfileMatch");
{
  const FREE_MAIL_DOMAINS = new Set([
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "icloud.com",
    "proton.me",
  ]);
  const { scoreProfileMatch } = makeApi(
    ["normalizeNameText", "escapeRegExp", "nameEvidence", "scoreProfileMatch"],
    { FREE_MAIL_DOMAINS }
  );

  const brandOnly = scoreProfileMatch(
    { title: "GitLab", description: "", outboundUrls: [] },
    "Alice Smith",
    [],
    [],
    [],
    true,
    "GitLab",
    "alice"
  );
  check(
    '[2] brand-only title + isSeedHandle -> match_tier "collision"',
    brandOnly.match_tier === "collision",
    brandOnly
  );

  const handleInTitle = scoreProfileMatch(
    { title: "Alice (@alice) · GitLab", description: "Alice on GitLab", outboundUrls: [] },
    "Alice Smith",
    [],
    [],
    [],
    true,
    "GitLab",
    "alice"
  );
  check(
    '[2] "Alice (@alice) · GitLab" + isSeedHandle -> probable/verified (not collision)',
    handleInTitle.match_tier === "probable" || handleInTitle.match_tier === "verified",
    handleInTitle
  );

  const sharedEmail = scoreProfileMatch(
    {
      title: "Alice",
      description: "Contact alice@acme-lab.test for work",
      outboundUrls: [],
    },
    "Alice Smith",
    [],
    [],
    ["alice@acme-lab.test"],
    false
  );
  check(
    "[2] shared email present -> verified",
    sharedEmail.match_tier === "verified",
    sharedEmail
  );

  const strongNamePlusOrg = scoreProfileMatch(
    { title: "Raj Sharma", description: "Director at Acme Corp", outboundUrls: [] },
    "Raj Sharma",
    ["Acme"],
    [],
    [],
    false
  );
  check(
    "[2] strong name + org -> verified",
    strongNamePlusOrg.match_tier === "verified",
    strongNamePlusOrg
  );
}

// ---------------------------------------------------------------------------
// 3. decodeChunkedBody
// ---------------------------------------------------------------------------
section("3. decodeChunkedBody");
{
  const { decodeChunkedBody } = makeApi(["decodeChunkedBody"]);

  const normal = decodeChunkedBody(Buffer.from("3\r\nabc\r\n0\r\n\r\n"));
  check(
    '[3] normal "3\\r\\nabc\\r\\n0\\r\\n\\r\\n" -> "abc", truncated=false',
    normal.buf.toString() === "abc" && normal.truncated === false,
    normal
  );

  const mislabeled = decodeChunkedBody(Buffer.from("<html>hi</html>"));
  check(
    "[3] mislabeled HTML -> raw body + mislabeled=true",
    mislabeled.buf.toString() === "<html>hi</html>" &&
      mislabeled.mislabeled === true &&
      mislabeled.truncated === false,
    mislabeled
  );

  const partial = decodeChunkedBody(Buffer.from("5\r\nab"));
  check(
    "[3] partial chunk -> truncated=true",
    partial.truncated === true,
    partial
  );
}

// ---------------------------------------------------------------------------
// 4. redactProxyUrl
// ---------------------------------------------------------------------------
section("4. redactProxyUrl");
{
  const { redactProxyUrl } = makeApi(["redactProxyUrl"]);

  const masked = redactProxyUrl("socks5h://alice:s3cret@127.0.0.1:9050");
  check(
    "[4] masks password but preserves username",
    masked === "socks5h://alice:***@127.0.0.1:9050",
    masked
  );
  check(
    "[4] masked value never contains the password",
    !String(masked).includes("s3cret"),
    masked
  );

  const noCreds = "socks5h://127.0.0.1:9050";
  check(
    "[4] credential-free URL unchanged",
    redactProxyUrl(noCreds) === noCreds,
    redactProxyUrl(noCreds)
  );

  check("[4] null -> null", redactProxyUrl(null) === null, redactProxyUrl(null));
}

// ---------------------------------------------------------------------------
// 5. isUnsafeCorpusRoot (filesystem safety guard)
// ---------------------------------------------------------------------------
section("5. isUnsafeCorpusRoot");
{
  const { isUnsafeCorpusRoot } = makeApi(["isUnsafeCorpusRoot"], { path, os });

  const home = os.homedir();
  const driveRoot = path.parse(home).root;
  const windows = path.join(driveRoot, "Windows");
  const system32 = path.join(windows, "System32");
  const defaultCorpus = path.join(
    process.env.LOCALAPPDATA || path.join(home, ".tauf"),
    "TAUF",
    "corpus"
  );

  check("[5] rejects drive root", isUnsafeCorpusRoot(driveRoot) === true, driveRoot);
  check("[5] rejects C:\\Windows", isUnsafeCorpusRoot(windows) === true, windows);
  check(
    "[5] rejects C:\\Windows\\System32",
    isUnsafeCorpusRoot(system32) === true,
    system32
  );
  check("[5] rejects home root", isUnsafeCorpusRoot(home) === true, home);
  check(
    "[5] allows home\\Documents\\corpus",
    isUnsafeCorpusRoot(path.join(home, "Documents", "corpus")) === false,
    path.join(home, "Documents", "corpus")
  );
  check(
    "[5] allows %LOCALAPPDATA%\\TAUF\\corpus",
    isUnsafeCorpusRoot(defaultCorpus) === false,
    defaultCorpus
  );
}

// ---------------------------------------------------------------------------
// 6. normalizeNodeId / normalizeAccountNodeId (graph identity)
// ---------------------------------------------------------------------------
section("6. normalizeNodeId / normalizeAccountNodeId");
{
  const { normalizeNodeId, normalizePlatformSlug, normalizeAccountNodeId } = makeApi(
    ["normalizeNodeId", "normalizePlatformSlug", "normalizeAccountNodeId"],
    { crypto },
    extractConst(source, "PLATFORM_SLUG_ALIASES")
  );

  const liLei = normalizeNodeId("entity", "李雷");
  const wangWei = normalizeNodeId("entity", "王伟");
  check(
    "[6] non-ASCII 李雷 vs 王伟 -> distinct node ids",
    liLei !== wangWei && liLei.startsWith("entity:h_") && wangWei.startsWith("entity:h_"),
    { liLei, wangWei }
  );

  const chessDotCom = normalizeAccountNodeId("Chess.com", "alice");
  const chess = normalizeAccountNodeId("Chess", "alice");
  check(
    '[6] account "Chess.com" === "Chess" for alice',
    chessDotCom === chess,
    { chessDotCom, chess }
  );

  const mastodonSocial = normalizeAccountNodeId("mastodon.social", "alice");
  const mastodonOnline = normalizeAccountNodeId("mastodon.online", "alice");
  check(
    '[6] mastodon.social !== mastodon.online for alice',
    mastodonSocial !== mastodonOnline,
    { mastodonSocial, mastodonOnline }
  );

  const emptyHandle = normalizeAccountNodeId("GitHub", "");
  check(
    "[6] empty handle is not the shared @unknown",
    !/@unknown$/i.test(emptyHandle),
    emptyHandle
  );
  check(
    "[6] empty handle falls back to a hashed id",
    /@h_[0-9a-f]{12}$/i.test(emptyHandle),
    emptyHandle
  );
}

// ---------------------------------------------------------------------------
// 7. parseSearchResults (hand-written engine fixtures)
// ---------------------------------------------------------------------------
section("7. parseSearchResults");
{
  const { parseSearchResults } = makeApi([
    "decodeHtmlEntities",
    "extractAttr",
    "decodeSearchRedirectUrl",
    "parseSearchResults",
  ]);

  const fixtures = {
    startpage: `
      <div class="result css-x1">
        <a data-testid="gl-title-link" href="https://www.startpage.com/sp/search?query=alice">Startpage redirect</a>
        <p class="description">Internal startpage navigation, not a result.</p>
      </div>
      <div class="w-gl__result">
        <a data-testid="gl-title-link" href="https://example.org/alice">Alice Example &mdash; Engineer</a>
        <p class="description">Alice Example builds synthetic test fixtures.</p>
      </div>
    `,
    "ddg-lite": `
      <table>
        <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Falice">Alice Example</a></td></tr>
        <tr><td class="result-snippet">Alice Example lives in a synthetic town.</td></tr>
      </table>
    `,
    "ddg-html": `
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="https://example.org/alice">Alice Example</a>
        <a class="result__snippet" href="#">Alice Example is an engineer.</a>
      </div>
    `,
    brave: `
      <div data-type="web">
        <a href="https://example.org/alice">
          <div class="title">Alice Example</div>
          <div class="snippet-description">Alice Example builds synthetic fixtures.</div>
        </a>
      </div>
    `,
    mojeek: `
      <li class="results-standard">
        <a href="https://example.org/alice">Alice Example</a>
        <p class="s">Alice Example writes code.</p>
      </li>
    `,
  };

  for (const engine of ["startpage", "ddg-lite", "ddg-html", "brave", "mojeek"]) {
    const results = parseSearchResults(engine, fixtures[engine]);
    check(
      `[7] ${engine} -> >=1 parsed result`,
      Array.isArray(results) && results.length >= 1,
      results
    );
    check(
      `[7] ${engine} result has absolute http(s) url`,
      results.length > 0 && /^https?:\/\//i.test(results[0].url),
      results[0]
    );
  }

  const sp = parseSearchResults("startpage", fixtures.startpage);
  check("[7] startpage.com self-link is filtered", sp.length === 1, sp);
  check(
    "[7] startpage keeps the real result",
    sp.length === 1 && sp[0].url === "https://example.org/alice",
    sp
  );
  check(
    "[7] no parsed url points back at startpage.com",
    sp.every((r) => !/(?:^|\.)startpage\.com(?:\/|$)/i.test(r.url)),
    sp.map((r) => r.url)
  );
}

// ---------------------------------------------------------------------------
// 8. extractPublicPhones
// ---------------------------------------------------------------------------
section("8. extractPublicPhones");
{
  const { extractPublicPhones } = makeApi(["extractPublicPhones"]);

  const text = `
    <div>
      Desk: <a href="tel:+91 98765 43210">+91 98765 43210</a><br>
      Mobile: +1 (555) 123-4567<br>
      Filed on 2024-01-01. Record id a1b2c3d4e5f6.
    </div>
  `;
  const phones = extractPublicPhones(text);
  console.log(`      phones found: ${JSON.stringify(phones)}`);

  check(
    "[8] tel:+91 98765 43210 link parsed",
    phones.some((p) => digitsOf(p) === "919876543210"),
    phones
  );
  check(
    "[8] +1 (555) 123-4567 plain-text line parsed",
    phones.some((p) => digitsOf(p) === "15551234567"),
    phones
  );
  check(
    "[8] date 2024-01-01 not treated as phone",
    phones.every((p) => !p.includes("2024") && digitsOf(p) !== "20240101"),
    phones
  );
  check(
    "[8] hex id not treated as phone",
    phones.every((p) => !/a1b2c3d4e5f6/i.test(p)),
    phones
  );
}

// ---------------------------------------------------------------------------
// 9. classifyOnionHit
// ---------------------------------------------------------------------------
section("9. classifyOnionHit");
{
  let api = null;
  try {
    api = makeApi([
      "decodeHtmlEntities",
      "getNameParts",
      "normalizeNameText",
      "escapeRegExp",
      "nameEvidence",
      "hasExactPhraseProximity",
      "stripBoilerplateHtml",
      "extractContextExcerpt",
      "classifyOnionSitePurpose",
      "classifyOnionHit",
    ]);
  } catch (err) {
    check(`[9] classifyOnionHit extractable (${err.message})`, false, err.message);
  }

  if (api) {
    const { classifyOnionHit } = api;

    const spam = classifyOnionHit(
      {
        url: "http://spamspamspam.onion/buy-cheap-pills",
        title: "Buy Cheap Pills Online",
        snippet: "Best prices, no prescription needed.",
        query: "Raj Sharma",
        engine: "Ahmia v3",
      },
      "Raj Sharma",
      "full_name",
      "Raj Sharma",
      null
    );
    check(
      "[9] paid/ad .onion with unrelated title -> null",
      spam === null,
      spam
    );

    const real = classifyOnionHit(
      {
        url: "http://acmeleaks.onion/profile/raj-sharma",
        title: "Raj Sharma",
        snippet: "Raj Sharma — Director at Acme, contact for filings.",
        query: "Raj Sharma",
        engine: "Ahmia v3",
      },
      "Raj Sharma",
      "full_name",
      "Raj Sharma",
      null
    );
    check(
      "[9] snippet with exact full name -> verified/probable",
      real !== null &&
        (real.match_tier === "verified" || real.match_tier === "probable"),
      real
    );
    check(
      "[9] onion_host populated",
      real !== null && real.onion_host === "acmeleaks.onion",
      real && real.onion_host
    );
    check(
      "[9] where_found populated with host + path",
      real !== null && real.where_found === "acmeleaks.onion/profile/raj-sharma",
      real && real.where_found
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failing checks:");
  for (const label of failures) console.log(`  - ${label}`);
}
process.exit(fail === 0 ? 0 : 1);
