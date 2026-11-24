// Standalone unit suite for the TAUF V6 anti-noise guard.
//
// Run:
//   "C:\Users\laksh\AppData\Local\OpenAI\Codex\runtimes\cua_node\76f5b5935a63c7ba\bin\node.exe" tests/unit/noise.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails. No network.

import {
  generateHighPrecisionHandles,
  isEmptyOrBoilerplateGist,
  isValidWikipediaBiography,
  shouldDropCollision,
  strongNameMatch,
} from "../../scripts/engine/noise_guard.mjs";

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

const handlesFor = (fullName, seed) =>
  generateHighPrecisionHandles(fullName, seed);
const values = (entries) => entries.map((entry) => entry.handle);

// ---------------------------------------------------------------------------
// 1. generateHighPrecisionHandles
// ---------------------------------------------------------------------------
section("1. generateHighPrecisionHandles");
{
  const entries = handlesFor("Lakshya Parashar", "@LakshyaP_77");
  const handleValues = values(entries);
  const patterns = entries.map((entry) => entry.pattern);

  check("[1] seed is preserved", handleValues.includes("lakshyap_77"), handleValues);
  check("[1] seed keeps pattern 'seed'", entries.find((e) => e.handle === "lakshyap_77")?.pattern === "seed", entries);
  check("[1] firstlast emitted", handleValues.includes("lakshyaparashar"), handleValues);
  check("[1] first.last emitted", handleValues.includes("lakshya.parashar"), handleValues);
  check("[1] first_last emitted", handleValues.includes("lakshya_parashar"), handleValues);
  check("[1] first-last emitted", handleValues.includes("lakshya-parashar"), handleValues);
  check("[1] lastfirst emitted", handleValues.includes("parasharlakshya"), handleValues);
  check("[1] flast emitted", handleValues.includes("lparashar"), handleValues);
  check("[1] firstl emitted", handleValues.includes("lakshyap"), handleValues);
  check("[1] no bare first name", !handleValues.includes("lakshya"), handleValues);
  check("[1] no bare surname", !handleValues.includes("parashar"), handleValues);
  check(
    "[1] exactly the seven compound patterns",
    ["firstlast", "first.last", "first_last", "first-last", "lastfirst", "flast", "firstl"]
      .every((pattern) => patterns.includes(pattern)),
    patterns
  );

  const deduped = handlesFor("Lakshya Parashar", "@LAKSHYA.PARASHAR");
  const dotHits = values(deduped).filter((handle) => handle === "lakshya.parashar");
  check("[1] case-insensitive dedupe", dotHits.length === 1, dotHits);
  check(
    "[1] seed wins the dedupe slot",
    deduped.find((entry) => entry.handle === "lakshya.parashar")?.pattern === "seed",
    deduped.find((entry) => entry.handle === "lakshya.parashar")
  );
  check("[1] handles are lowercase", values(deduped).every((h) => h === h.toLowerCase()), values(deduped));

  const single = handlesFor("Madonna", "@madonna");
  check("[1] single token emits only seed/single", values(single).length === 1 && single[0].handle === "madonna", single);
  check("[1] empty full name keeps seed only", values(handlesFor("", "@seed_1")).join(",") === "seed_1", handlesFor("", "@seed_1"));
  check("[1] invalid short seed is rejected", values(handlesFor("", "@x")).length === 0, handlesFor("", "@x"));
}

// ---------------------------------------------------------------------------
// 2. isValidWikipediaBiography
// ---------------------------------------------------------------------------
section("2. isValidWikipediaBiography");
{
  const name = "Lakshya Parashar";
  const body = "<html><body><h1>Lakshya Parashar</h1><p>Engineer.</p></body></html>";
  const article = "https://en.wikipedia.org/wiki/Lakshya_Parashar";

  check(
    "[2] /wiki/User: rejected",
    !isValidWikipediaBiography("https://en.wikipedia.org/wiki/User:Lakshya_Parashar", `${name} - Wikipedia`, body, name),
    "User:"
  );
  check(
    "[2] /wiki/Talk: rejected",
    !isValidWikipediaBiography("https://en.wikipedia.org/wiki/Talk:Lakshya_Parashar", `${name} - Wikipedia`, body, name),
    "Talk:"
  );
  check(
    "[2] /wiki/List_of_ rejected",
    !isValidWikipediaBiography("https://en.wikipedia.org/wiki/List_of_people", `${name} - Wikipedia`, body, name),
    "List_of_"
  );
  check(
    "[2] __DISAMBIG__ rejected",
    !isValidWikipediaBiography(article, `${name} - Wikipedia`, `${body}__DISAMBIG__`, name),
    "__DISAMBIG__"
  );
  check(
    "[2] 'may refer to' rejected",
    !isValidWikipediaBiography(article, `${name} - Wikipedia`, "<p>This page may refer to:</p>", name),
    "may refer to"
  );
  check(
    "[2] 'disambig' marker rejected",
    !isValidWikipediaBiography(article, `${name} - Wikipedia`, '<div id="disambigbox"></div>', name),
    "disambig"
  );
  check(
    "[2] 'Name - Wikipedia' accepted with strong name",
    isValidWikipediaBiography(article, `${name} - Wikipedia`, body, name),
    true
  );
  check(
    "[2] en dash 'Name – Wikipedia' accepted",
    isValidWikipediaBiography(article, `${name} – Wikipedia`, body, name),
    true
  );
  check(
    "[2] unrelated title rejected",
    !isValidWikipediaBiography("https://en.wikipedia.org/wiki/Python_(programming_language)", "Python (programming language) - Wikipedia", "<p>Python is a language.</p>", name),
    "unrelated"
  );
  check(
    "[2] injected strong evidence accepted",
    isValidWikipediaBiography(article, "Different title", body, name, () => ({ strong: true })),
    true
  );
  check(
    "[2] injected weak evidence rejected",
    !isValidWikipediaBiography(article, `${name} - Wikipedia`, body, name, () => ({ strong: false, proximity: true })),
    "weak"
  );
  check(
    "[2] strong matcher handles reversed 'Last, First'",
    strongNameMatch("Parashar, Lakshya", name),
    true
  );
}

// ---------------------------------------------------------------------------
// 3. isEmptyOrBoilerplateGist
// ---------------------------------------------------------------------------
section("3. isEmptyOrBoilerplateGist");
{
  check(
    "[3] straight-apostrophe empty gist rejected",
    isEmptyOrBoilerplateGist("<p>This user doesn't have any public gists yet.</p>"),
    true
  );
  check(
    "[3] curly-apostrophe empty gist rejected",
    isEmptyOrBoilerplateGist("<p>This user doesn’t have any public gists yet.</p>"),
    true
  );
  check(
    "[3] gist page with gist-snippet kept",
    !isEmptyOrBoilerplateGist('<html><head><title>alice’s gists</title><meta property="og:url" content="https://gist.github.com/alice"></head><body><div class="gist-snippet">x</div></body></html>'),
    "snippet"
  );
  check(
    "[3] gist page missing gist-snippet rejected",
    isEmptyOrBoilerplateGist('<html><head><title>alice’s gists</title></head><body><a href="https://gist.github.com/alice">gist</a></body></html>'),
    true
  );
  check("[3] non-gist page not rejected", !isEmptyOrBoilerplateGist("<html><body>Home page</body></html>"), false);
}

// ---------------------------------------------------------------------------
// 4. shouldDropCollision
// ---------------------------------------------------------------------------
section("4. shouldDropCollision");
{
  const name = "Lakshya Parashar";
  const collision = { match_tier: "collision", match_reason: "Handle match only - collision risk", confidence: 0.36 };

  check(
    "[4] contradictory full name -> drop",
    shouldDropCollision(
      { title: "John Smith | LinkedIn", pageFullName: "John Smith" },
      collision,
      name,
      false
    ),
    true
  );
  check(
    "[4] brand-only shell -> drop",
    shouldDropCollision(
      { title: "LinkedIn", description: "Connect with professionals", siteBrand: "LinkedIn" },
      { match_tier: "collision", match_reason: "Brand-only page - no identity marker", confidence: 0.36 },
      name,
      false
    ),
    true
  );
  check(
    "[4] zero-signal non-seed -> drop",
    shouldDropCollision({ title: "random profile", outboundUrls: [] }, collision, name, false),
    true
  );
  check(
    "[4] exact seed handle -> keep",
    !shouldDropCollision(
      { title: "LakshyaP" },
      { match_tier: "probable", match_reason: "Exact provided handle match", confidence: 0.66 },
      name,
      true
    ),
    false
  );
  check(
    "[4] strong name + org -> keep",
    !shouldDropCollision(
      { title: "Lakshya Parashar", description: "Platform engineer at Acme Robotics", organizations: ["Acme Robotics"] },
      { match_tier: "probable", match_reason: "Full name phrase confirmed in bio", confidence: 0.78 },
      name,
      false
    ),
    false
  );
  check(
    "[4] strong name + shared domain flag -> keep",
    !shouldDropCollision(
      { title: "Lakshya Parashar", description: "Engineer", sharedDomain: "acme.dev" },
      { match_tier: "probable", match_reason: "Shared org/website signal", confidence: 0.72 },
      name,
      false
    ),
    false
  );
  check(
    "[4] contradictory name drops even seed handle",
    shouldDropCollision({ title: "John Smith", detectedName: "John Smith" }, collision, name, true),
    true
  );
  check("[4] missing fields are defensive (drop)", shouldDropCollision({}, {}, name, false), true);
  check("[4] null fields are defensive (seed keeps)", !shouldDropCollision(null, null, name, true), false);
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
