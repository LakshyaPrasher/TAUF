// Standalone unit suite for the .onion reliability work (ONION-3 / ONION-5 / ONION-7).
//
// Run:
//   "C:\Users\laksh\AppData\Local\OpenAI\Codex\runtimes\cua_node\76f5b5935a63c7ba\bin\node.exe" tests/unit/onion.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails.
// Every function under test is extracted from the shipped local-server.mjs, so
// this exercises the real parser/telemetry/classifier code. Synthetic fixtures
// only: no network, no Tor, no real-person data.

import { makeApi, source } from "./extract.mjs";

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

// extract.mjs's extractFn() assumes plain parameters: it treats the first `{`
// after the `function name(` token as the body opener. `classifyOnionFailure`
// is declared with destructured parameters (`({ error, res, ... } = {})`), so
// extractFn truncates it. This helper locates the real body brace after the
// parameter list's closing paren and returns the shipped source verbatim; the
// caller injects it through makeApi's prelude so the real function is tested.
function serverFunctionSource(name) {
  const declRe = new RegExp(`(^|[\\n;}])\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const decl = declRe.exec(source);
  if (!decl) throw new Error(`serverFunctionSource: function ${name} not found`);
  const start = decl.index + decl[1].length;

  // Skip the parameter list, including destructuring braces/brackets/strings.
  let i = source.indexOf("(", start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }

  // Walk the body from its opening brace to the matching close.
  let bodyStart = source.indexOf("{", i + 1);
  if (bodyStart === -1) throw new Error(`serverFunctionSource: no body for ${name}`);
  depth = 0;
  for (i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`serverFunctionSource: unbalanced braces for ${name}`);
}

// ---------------------------------------------------------------------------
// Fixtures (synthetic)
// ---------------------------------------------------------------------------
const AHMIA_FIXTURE = `
  <ul class="results">
    <li class="result featured">
      <h4><a href="http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/search/?q=raj&amp;redirect_url=https://acmeleaks.onion/leak">Raj Sharma Leak Dump</a></h4>
      <cite>acmeleaks.onion/leak</cite>
      <p>Indexed leak listing that mentions Raj Sharma.</p>
    </li>
  </ul>
`;

const ONIONLAND_FIXTURE = `
  <div class="results">
    <div class="result-block sponsored">
      <div class="title"><a href="http://adsbuy.onion/promo">Sponsored placement</a></div>
      <div class="link">adsbuy.onion/promo</div>
      <div class="desc">Sponsored ad block that must never surface as a hit.</div>
    </div>
    <div class="result-block featured">
      <div class="title"><a href="http://acmeleaks.onion/leak">Raj Sharma Leak Dump</a></div>
      <div class="link">acmeleaks.onion/leak</div>
      <div class="desc">Organic result describing the Raj Sharma leak listing.</div>
    </div>
  </div>
`;

// ---------------------------------------------------------------------------
// A. Parser resilience (ONION-5)
// ---------------------------------------------------------------------------
section("A. Parser resilience (ONION-5)");
{
  const { parseAhmiaResults, parseOnionLandResults, extractHiddenInputs } = makeApi([
    "decodeHtmlEntities",
    "parseAhmiaResults",
    "parseOnionLandResults",
    "extractHiddenInputs",
  ]);

  const ahmiaHits = parseAhmiaResults(AHMIA_FIXTURE, "Raj Sharma", "Ahmia v3");
  check("[A] Ahmia li.result.featured -> exactly 1 hit", ahmiaHits.length === 1, ahmiaHits);
  check(
    "[A] Ahmia hit url is the redirect .onion target",
    ahmiaHits.length === 1 && ahmiaHits[0].url === "https://acmeleaks.onion/leak",
    ahmiaHits[0] && ahmiaHits[0].url
  );
  check(
    "[A] Ahmia hit title parsed",
    ahmiaHits.length === 1 && ahmiaHits[0].title.includes("Raj Sharma Leak Dump"),
    ahmiaHits[0] && ahmiaHits[0].title
  );
  check(
    "[A] Ahmia hit snippet parsed",
    ahmiaHits.length === 1 && ahmiaHits[0].snippet.includes("Indexed leak listing"),
    ahmiaHits[0] && ahmiaHits[0].snippet
  );

  const stats = { adsFiltered: 0 };
  const onionLandHits = parseOnionLandResults(ONIONLAND_FIXTURE, "Raj Sharma", stats);
  check("[A] OnionLand result-block.featured -> exactly 1 organic hit", onionLandHits.length === 1, onionLandHits);
  check(
    "[A] OnionLand sponsored block skipped",
    onionLandHits.length === 1 && !onionLandHits.some((h) => h.url.includes("adsbuy.onion")),
    onionLandHits.map((h) => h.url)
  );
  check("[A] OnionLand stats.adsFiltered incremented", stats.adsFiltered === 1, stats);
  check(
    "[A] OnionLand hit title + .onion url",
    onionLandHits.length === 1 &&
      onionLandHits[0].url === "http://acmeleaks.onion/leak" &&
      onionLandHits[0].title.includes("Raj Sharma Leak Dump"),
    onionLandHits[0]
  );

  const reversed = extractHiddenInputs('<input value="TOK" type="hidden" name="token" />');
  check(
    "[A] hidden input with value before name",
    reversed.length === 1 && reversed[0].name === "token" && reversed[0].value === "TOK",
    reversed
  );

  const singleQuoted = extractHiddenInputs(
    "<form><input class='x' type='hidden' value='ABC123' name='csrf' autocomplete='off' /></form>"
  );
  check(
    "[A] hidden input single-quoted with extra attributes",
    singleQuoted.some((f) => f.name === "csrf" && f.value === "ABC123"),
    singleQuoted
  );

  const mixed = extractHiddenInputs(
    '<input type="text" name="q" value="visible"><input name=nonce type=hidden value=unquoted>'
  );
  check(
    "[A] non-hidden input ignored, unquoted hidden parsed",
    mixed.length === 1 && mixed[0].name === "nonce" && mixed[0].value === "unquoted",
    mixed
  );
}

// ---------------------------------------------------------------------------
// B. Failure telemetry (ONION-7)
// ---------------------------------------------------------------------------
section("B. Failure telemetry (ONION-7)");
{
  // classifyOnionFailure is declared with destructured parameters, which
  // extractFn() cannot slice (it stops at the parameter pattern's `}`). Inject
  // the shipped function body via the prelude and expose it on a box that was
  // passed in as a factory argument. The extracted `decodeHtmlEntities` body
  // supplies detectSearchChallenge's HTML-entity dependency.
  const apiBox = {};
  const classifyPrelude = [
    serverFunctionSource("detectSearchChallenge"),
    serverFunctionSource("classifyOnionFailure"),
    "apiBox.classifyOnionFailure = classifyOnionFailure;",
  ].join("\n");
  makeApi(["decodeHtmlEntities"], { apiBox }, classifyPrelude);
  const classifyOnionFailure = apiBox.classifyOnionFailure;
  check("[B] real classifyOnionFailure injected from source", typeof classifyOnionFailure === "function", typeof classifyOnionFailure);

  check(
    "[B] SOCKS5h timeout -> timeout",
    classifyOnionFailure({ error: new Error("SOCKS5h connect timed out") }) === "timeout",
    classifyOnionFailure({ error: new Error("SOCKS5h connect timed out") })
  );
  check(
    "[B] other transport error -> circuit_error",
    classifyOnionFailure({ error: new Error("connection reset by peer") }) === "circuit_error",
    classifyOnionFailure({ error: new Error("connection reset by peer") })
  );
  check(
    "[B] HTTP 500 -> http_error",
    classifyOnionFailure({ res: { ok: false, status: 500 } }) === "http_error",
    classifyOnionFailure({ res: { ok: false, status: 500 } })
  );
  check(
    "[B] HTTP 403 -> challenge",
    classifyOnionFailure({ res: { ok: false, status: 403 } }) === "challenge",
    classifyOnionFailure({ res: { ok: false, status: 403 } })
  );
  check(
    "[B] large ok body with 0 hits -> parser_empty",
    classifyOnionFailure({
      res: { ok: true, status: 200, headers: { get: () => null } },
      html: "x".repeat(25000),
      hitCount: 0,
    }) === "parser_empty",
    classifyOnionFailure({
      res: { ok: true, status: 200, headers: { get: () => null } },
      html: "x".repeat(25000),
      hitCount: 0,
    })
  );
  check(
    "[B] small ok body with a hit -> ok",
    classifyOnionFailure({ res: { ok: true, status: 200 }, html: "small", hitCount: 1 }) === "ok",
    classifyOnionFailure({ res: { ok: true, status: 200 }, html: "small", hitCount: 1 })
  );
  check(
    "[B] ok body with CAPTCHA markup -> challenge",
    classifyOnionFailure({
      res: { ok: true, status: 200, headers: { get: () => null } },
      html: '<div class="g-recaptcha"></div>',
      hitCount: 0,
    }) === "challenge",
    classifyOnionFailure({
      res: { ok: true, status: 200, headers: { get: () => null } },
      html: '<div class="g-recaptcha"></div>',
      hitCount: 0,
    })
  );
}

// ---------------------------------------------------------------------------
// C. Classifier false-positive gate
// ---------------------------------------------------------------------------
section("C. classifyOnionHit false-positive gate");
{
  const { classifyOnionHit } = makeApi([
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

  const unrelated = classifyOnionHit(
    {
      url: "http://hiddenwiki.onion/directory",
      title: "Hidden Wiki",
      snippet: "A curated directory of onion links for Tor users.",
      query: "Raj Sharma",
      engine: "Ahmia v3",
    },
    "Raj Sharma",
    "full_name",
    "Raj Sharma",
    null
  );
  check("[C] unrelated .onion directory -> null", unrelated === null, unrelated);

  const exactName = classifyOnionHit(
    {
      url: "http://acmeleaks.onion/raj-sharma",
      title: "Raj Sharma leak record",
      snippet: "Raj Sharma appears in this synthetic leak index.",
      query: "Raj Sharma",
      engine: "Ahmia v3",
    },
    "Raj Sharma",
    "full_name",
    "Raj Sharma",
    null
  );
  check(
    "[C] exact full name in title/snippet -> verified/probable",
    exactName !== null && (exactName.match_tier === "verified" || exactName.match_tier === "probable"),
    exactName && exactName.match_tier
  );

  const partial = classifyOnionHit(
    {
      url: "http://blogdump.onion/post/1",
      title: "Raj",
      snippet: "Raj writes about synthetic test data.",
      query: "Raj",
      engine: "Ahmia v3",
    },
    "Raj",
    "full_name",
    "Raj Sharma",
    null
  );
  check("[C] partial name only -> null", partial === null, partial);

  const emailExact = classifyOnionHit(
    {
      url: "http://maildump.onion/records",
      title: "Contact records",
      snippet: "Reach the account owner at raj@x.com for details.",
      query: "raj@x.com",
      engine: "Ahmia v3",
    },
    "raj@x.com",
    "email",
    "Raj Sharma",
    null
  );
  check(
    "[C] exact email -> verified",
    emailExact !== null && emailExact.match_tier === "verified",
    emailExact && emailExact.match_tier
  );

  const emailFragment = classifyOnionHit(
    {
      url: "http://maildump.onion/records",
      title: "Contact records",
      snippet: "Lookalike address raj@x.com.evil is not the same account.",
      query: "raj@x.com",
      engine: "Ahmia v3",
    },
    "raj@x.com",
    "email",
    "Raj Sharma",
    null
  );
  check("[C] email fragment inside a longer address -> null", emailFragment === null, emailFragment);

  const handleBodyOnly = classifyOnionHit(
    {
      url: "http://abcd1234.onion/page",
      title: "Anonymous dump",
      snippet: "The account rajsharma99 posted this file.",
      query: "rajsharma99",
      engine: "Ahmia v3",
    },
    "rajsharma99",
    "handle",
    null,
    null
  );
  check("[C] handle in body only -> null", handleBodyOnly === null, handleBodyOnly);

  const handleInTitle = classifyOnionHit(
    {
      url: "http://abcd1234.onion/profile",
      title: "rajsharma99 profile",
      snippet: "Profile page for the account.",
      query: "rajsharma99",
      engine: "Ahmia v3",
    },
    "rajsharma99",
    "handle",
    null,
    null
  );
  check(
    "[C] handle in title -> probable",
    handleInTitle !== null && handleInTitle.match_tier === "probable",
    handleInTitle && handleInTitle.match_tier
  );

  const handleTooShort = classifyOnionHit(
    {
      url: "http://abcd1234.onion/profile",
      title: "raj1 profile",
      snippet: "raj1 is here.",
      query: "raj1",
      engine: "Ahmia v3",
    },
    "raj1",
    "handle",
    null,
    null
  );
  check("[C] handle shorter than 5 -> null", handleTooShort === null, handleTooShort);

  const domainInTitle = classifyOnionHit(
    {
      url: "http://abcd1234.onion/",
      title: "Welcome to rajsharma.example",
      snippet: "A synthetic page about this domain.",
      query: "rajsharma.example",
      engine: "Ahmia v3",
    },
    "rajsharma.example",
    "domain",
    null,
    null
  );
  check(
    "[C] domain in title -> probable",
    domainInTitle !== null && domainInTitle.match_tier === "probable",
    domainInTitle && domainInTitle.match_tier
  );
}

// ---------------------------------------------------------------------------
// D. Mirror/base configuration (ONION-3)
// ---------------------------------------------------------------------------
section("D. Mirror/base configuration (ONION-3)");
{
  const AHMIA_PRIMARY = "http://ahmia-primary.onion";
  const ONIONLAND_PRIMARY = "http://onionland-primary.onion";

  const { getConfiguredOnionBases } = makeApi(
    ["getConfiguredOnionBases"],
    {
      state: {
        config: {
          custom_onion_seeds: [
            "http://ahmia-mirror2.onion/search/?q={query}",
            "http://ahmia-mirror2.onion/",
            "not-a-valid-url",
            "http://onionland-mirror2.onion/search?q={query}",
            "http://onionland-mirror2.onion/",
          ],
        },
      },
      AHMIA_V3_BASE: AHMIA_PRIMARY,
      ONIONLAND_V3_BASE: ONIONLAND_PRIMARY,
    }
  );

  const ahmiaBases = getConfiguredOnionBases("ahmia");
  check(
    "[D] custom Ahmia mirror appears first",
    ahmiaBases[0] === "http://ahmia-mirror2.onion",
    ahmiaBases
  );
  check(
    "[D] Ahmia primary mirror present",
    ahmiaBases.includes(AHMIA_PRIMARY),
    ahmiaBases
  );
  check(
    "[D] https://ahmia.fi fallback present",
    ahmiaBases.includes("https://ahmia.fi"),
    ahmiaBases
  );
  check(
    "[D] Ahmia bases deduped (mirror once)",
    ahmiaBases.filter((b) => b === "http://ahmia-mirror2.onion").length === 1 &&
      new Set(ahmiaBases).size === ahmiaBases.length,
    ahmiaBases
  );
  check(
    "[D] getConfiguredOnionBases('ahmia') first base is the custom mirror",
    getConfiguredOnionBases("ahmia")[0] === "http://ahmia-mirror2.onion",
    getConfiguredOnionBases("ahmia")
  );

  const onionlandBases = getConfiguredOnionBases("onionland");
  check(
    "[D] OnionLand custom mirror first then primary",
    onionlandBases.length === 2 &&
      onionlandBases[0] === "http://onionland-mirror2.onion" &&
      onionlandBases[1] === ONIONLAND_PRIMARY,
    onionlandBases
  );
}

// ---------------------------------------------------------------------------
// D2. Ahmia mirror fallback loop (fake transport; no network)
// ---------------------------------------------------------------------------
section("D2. queryAhmiaOnion walks mirrors on failure");
{
  const AHMIA_PRIMARY = "http://ahmia-primary.onion";
  const ONIONLAND_PRIMARY = "http://onionland-primary.onion";
  const calls = [];

  const fakeSocks5hRequest = async (host, port, url) => {
    calls.push(url);
    if (url.startsWith("http://ahmia-mirror2.onion")) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => "upstream error" };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => AHMIA_FIXTURE };
  };
  const fakeEnsureAhmiaSession = async (torHost, torPort, base) => ({
    base,
    token: null,
    cookieHeader: "",
    at: 0,
  });
  const fakeInvalidateAhmiaSession = () => {};

  const { queryAhmiaOnion } = makeApi(
    [
      "decodeHtmlEntities",
      "detectSearchChallenge",
      "getConfiguredOnionBases",
      "parseAhmiaResults",
      "queryAhmiaOnion",
    ],
    {
      state: {
        config: {
          custom_onion_seeds: ["http://ahmia-mirror2.onion/search/?q={query}"],
        },
      },
      AHMIA_V3_BASE: AHMIA_PRIMARY,
      ONIONLAND_V3_BASE: ONIONLAND_PRIMARY,
      socks5hRequest: fakeSocks5hRequest,
      ensureAhmiaSession: fakeEnsureAhmiaSession,
      invalidateAhmiaSession: fakeInvalidateAhmiaSession,
    },
    serverFunctionSource("classifyOnionFailure")
  );

  const result = await queryAhmiaOnion("127.0.0.1", 9050, "Raj Sharma", null);

  check("[D2] fallback query returns >=1 hit", result.hits.length >= 1, result.hits);
  check("[D2] fallback query reason is ok", result.reason === "ok", result.reason);
  check("[D2] first base attempted before primary", calls[0]?.startsWith("http://ahmia-mirror2.onion"), calls);
  check("[D2] primary attempted after the failed mirror", calls.some((u) => u.startsWith(AHMIA_PRIMARY)), calls);
  check("[D2] stats.attempts === 1 (succeeded on first attempt)", result.stats.attempts === 1, result.stats);
}

// ---------------------------------------------------------------------------
// E. Owned-domain .onion snippet matching & expanded canonical URL extractors
// ---------------------------------------------------------------------------
section("E. Domain snippet exposure & canonical platform extractors");
{
  const {
    classifyOnionHit,
    extractSocialAccountFromUrl,
    buildCanonicalProfileUrl,
  } = makeApi(
    [
      "decodeHtmlEntities",
      "getNameParts",
      "normalizeNameText",
      "escapeRegExp",
      "nameEvidence",
      "hasExactPhraseProximity",
      "hasFullNameMatch",
      "stripBoilerplateHtml",
      "extractContextExcerpt",
      "classifyOnionSitePurpose",
      "classifyOnionHit",
      "normalizePlatformSlug",
      "buildCanonicalProfileUrl",
      "extractSocialAccountFromUrl",
    ],
    {
      PLATFORM_SLUG_ALIASES: {
        "dev.to": "devto",
        devto: "devto",
        "github gist": "gist",
        gist: "gist",
        stackoverflow: "stackoverflow",
        hackernews: "hackernews",
        huggingface: "huggingface",
        npm: "npm",
        pypi: "pypi",
        dockerhub: "dockerhub",
        orcid: "orcid",
      },
      RESERVED_PATHS: new Set(["about", "login", "signup", "explore", "settings", "trending"]),
    }
  );

  const domInBody = classifyOnionHit(
    {
      url: "http://z7x9k2p4q8m1n5v3b6c0d2f4g6h8j0k2l4m6n8p0q2r4s6t8u0v2w4ad.onion/thread/42",
      title: "Config archive dump",
      snippet: "Exposed staging endpoint referencing irah.co.in mail gateway.",
      query: "irah.co.in",
      engine: "OnionLand v3",
    },
    "irah.co.in",
    "domain",
    "Hari Kant Prasher",
    null
  );
  check(
    "[E] owned domain in .onion snippet (56-char base32 host) -> probable",
    domInBody !== null && domInBody.match_tier === "probable" && domInBody.matched_identifier === "Domain: irah.co.in",
    domInBody
  );

  const domLookalike = classifyOnionHit(
    {
      url: "http://z7x9k2p4q8m1n5v3b6c0d2f4g6h8j0k2l4m6n8p0q2r4s6t8u0v2w4ad.onion/thread/43",
      title: "Config archive dump",
      snippet: "Unrelated domain my-irah.co.in.example listed.",
      query: "irah.co.in",
      engine: "OnionLand v3",
    },
    "irah.co.in",
    "domain",
    "Hari Kant Prasher",
    null
  );
  check("[E] domain lookalike boundary rejected -> null", domLookalike === null, domLookalike);

  check(
    "[E] dev.to extractor + canonical URL",
    extractSocialAccountFromUrl("https://dev.to/alice_dev", "", "Alice")?.platform === "Dev.to" &&
      buildCanonicalProfileUrl("Dev.to", "alice_dev") === "https://dev.to/alice_dev",
    extractSocialAccountFromUrl("https://dev.to/alice_dev", "", "Alice")
  );
  check(
    "[E] ORCID extractor + canonical URL",
    extractSocialAccountFromUrl("https://orcid.org/0000-0002-1825-0097", "", "Alice")?.handle === "0000-0002-1825-0097" &&
      buildCanonicalProfileUrl("ORCID", "0000-0002-1825-0097") === "https://orcid.org/0000-0002-1825-0097",
    extractSocialAccountFromUrl("https://orcid.org/0000-0002-1825-0097", "", "Alice")
  );
  check(
    "[E] PyPI & npm extractors",
    extractSocialAccountFromUrl("https://pypi.org/user/alicepkg/", "", "Alice")?.platform === "PyPI" &&
      extractSocialAccountFromUrl("https://www.npmjs.com/~alicenpm", "", "Alice")?.platform === "npm",
    true
  );
  check(
    "[E] Mastodon instance preserved",
    extractSocialAccountFromUrl("https://fosstodon.org/@alice", "", "Alice")?.platform === "Mastodon:fosstodon.org" &&
      buildCanonicalProfileUrl("Mastodon:fosstodon.org", "alice") === "https://fosstodon.org/@alice",
    extractSocialAccountFromUrl("https://fosstodon.org/@alice", "", "Alice")
  );
  check(
    "[E] Gist paste hex URL & story.php rejected as accounts",
    extractSocialAccountFromUrl("https://gist.github.com/alice/0123456789abcdef0123", "", "Alice") === null &&
      extractSocialAccountFromUrl("https://www.facebook.com/story.php?id=123", "", "Alice") === null,
    true
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failing checks:");
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
process.exit(0);
