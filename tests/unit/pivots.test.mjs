#!/usr/bin/env node
/**
 * Unit suite — recursive identity pivot extractors (`scripts/engine/pivots.mjs`)
 */

import crypto from "node:crypto";
import {
  PIVOT_PRIORITY,
  deriveEmailHandleCandidates,
  fetchGravatarProfile,
  crawlDomainIdentitySurface,
  buildContextDisambiguationQueries,
} from "../../scripts/engine/pivots.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
    fail++;
    failures.push(label);
  }
}

console.log("\n# 1. deriveEmailHandleCandidates");
{
  const cands = deriveEmailHandleCandidates("Alice.Dev_99+tag@gmail.com");
  check("[1] extracts exact + compact local-part", cands.includes("alice.dev_99") && cands.includes("alicedev99"), cands);
  check("[1] rejects generic role prefixes (info@, contact@, support@)", deriveEmailHandleCandidates("info@acme.com").length === 0 && deriveEmailHandleCandidates("support@acme.com").length === 0);
  check("[1] rejects short (<5 char) local-parts", deriveEmailHandleCandidates("ab@x.com").length === 0);
  check("[1] rejects pure digits", deriveEmailHandleCandidates("12345678@x.com").length === 0);
}

console.log("\n# 2. fetchGravatarProfile (offline fixture)");
{
  const email = "alice.research@example.org";
  const md5Hex = crypto.createHash("md5").update(email).digest("hex");
  let requestedUrl = "";

  const fakeFetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          entry: [
            {
              profileUrl: `https://gravatar.com/${md5Hex}`,
              preferredUsername: "aliceresearch",
              displayName: "Alice Research",
              aboutMe: "<p>Distributed systems engineer.</p>",
              currentLocation: "Zurich",
              accounts: [
                { shortname: "github", username: "aliceresearch", url: "https://github.com/aliceresearch", verified: true },
                { shortname: "mastodon", username: "alice", url: "https://fosstodon.org/@alice", verified: true },
              ],
              urls: [{ value: "https://aliceresearch.dev", title: "Personal Blog" }],
            },
          ],
        }),
    };
  };

  const prof = await fetchGravatarProfile(email, { fetchFn: fakeFetch });
  check("[2] queries MD5 .json endpoint (no api.* URL)", requestedUrl === `https://en.gravatar.com/${md5Hex}.json`, requestedUrl);
  check("[2] parses displayName, preferredUsername & HTML-stripped bio", prof.found && prof.displayName === "Alice Research" && prof.preferredUsername === "aliceresearch" && prof.bio === "Distributed systems engineer.", prof);
  check("[2] extracts verified linked accounts & personal URLs", prof.accounts.length === 2 && prof.urls[0]?.url === "https://aliceresearch.dev", prof);

  const abortedCtrl = new AbortController();
  abortedCtrl.abort();
  const abortedProf = await fetchGravatarProfile(email, { fetchFn: fakeFetch, signal: abortedCtrl.signal });
  check("[2] respects AbortSignal cleanly", abortedProf.found === false, abortedProf);
}

console.log("\n# 3. crawlDomainIdentitySurface (offline fixture)");
{
  const routes = {
    "https://aliceresearch.dev/about": `
      <html><head>
        <link rel="me" href="https://fosstodon.org/@alice" />
        <script type="application/ld+json">{"@type":"Person","sameAs":["https://github.com/aliceresearch"],"email":"mailto:alice.personal@aliceresearch.dev"}</script>
      </head><body>
        <a href="/files/alice_cv_2026.pdf">Download CV</a>
        <a href="https://www.linkedin.com/in/alice-research">LinkedIn</a>
        <p>Generic role info@aliceresearch.dev should be ignored.</p>
      </body></html>
    `,
    "https://aliceresearch.dev/.well-known/keybase.txt": `I hereby claim keybase.io/aliceresearch is me.`,
    "https://aliceresearch.dev/.well-known/atproto-did": `did:plc:z72i7hdynmk6r22z27h6tvur`,
    "https://aliceresearch.dev/.well-known/security.txt": `Contact: mailto:sec.alice@aliceresearch.dev\nEncryption: https://aliceresearch.dev/pgp-key.asc`,
  };

  const fakeFetch = async (url) => {
    if (routes[url]) {
      return { ok: true, status: 200, text: async () => routes[url] };
    }
    return { ok: false, status: 404, text: async () => "" };
  };

  const res = await crawlDomainIdentitySurface("aliceresearch.dev", { fetchFn: fakeFetch, maxPaths: 8 });
  check("[3] extracts personal email & filters generic info@", res.emails.includes("alice.personal@aliceresearch.dev") && !res.emails.includes("info@aliceresearch.dev"), res.emails);
  check("[3] extracts relative PDF resume URL as absolute", res.pdfUrls.includes("https://aliceresearch.dev/files/alice_cv_2026.pdf"), res.pdfUrls);
  check("[3] extracts rel=me, JSON-LD sameAs & outbound social links", res.sameAsUrls.includes("https://fosstodon.org/@alice") && res.sameAsUrls.includes("https://github.com/aliceresearch") && res.sameAsUrls.includes("https://www.linkedin.com/in/alice-research"), res.sameAsUrls);
  check("[3] extracts .well-known/keybase.txt & atproto-did & security.txt PGP", res.keybaseHandle === "aliceresearch" && res.atprotoDid === "did:plc:z72i7hdynmk6r22z27h6tvur" && res.pgpUrls.includes("https://aliceresearch.dev/pgp-key.asc"), res);
}

console.log("\n# 4. buildContextDisambiguationQueries & priority ordering");
{
  check("[4] priority ordering EMAIL > HANDLE > DOMAIN > CONTEXT", PIVOT_PRIORITY.EMAIL > PIVOT_PRIORITY.HANDLE && PIVOT_PRIORITY.HANDLE > PIVOT_PRIORITY.DOMAIN && PIVOT_PRIORITY.DOMAIN > PIVOT_PRIORITY.CONTEXT);
  const qs = buildContextDisambiguationQueries("Alice Sharma", ["ETH Zurich", "Engineer"], ["alicesharma.ch"], 3);
  check("[4] builds org + pdf + domain disambiguators & skips generic stopwords ('Engineer')", qs.length === 3 && qs[0].query === '"Alice Sharma" "ETH Zurich"' && !qs.some((q) => q.query.includes("Engineer")), qs);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failing checks:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
