// Standalone unit suite for the budget-driven ETA engine (WP2).
//
// Run:
//   node tests/unit/eta.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails.
// medianRttMs / rttFactorFromSamples / StageBudgetTracker are extracted from the
// shipped local-server.mjs, so this exercises the real code. No network, no Tor.

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

const prelude = [
  extractConst(source, "WAVE_BUDGETS_MS"),
  extractConst(source, "WAVE_KEYS"),
  extractConst(source, "WAVE_PROGRESS_BANDS"),
].join("\n");

const { clampNumber, medianRttMs, rttFactorFromSamples, StageBudgetTracker } = makeApi(
  ["clampNumber", "medianRttMs", "rttFactorFromSamples", "StageBudgetTracker"],
  {},
  prelude
);

const sumBudget = (tracker) =>
  Object.values(tracker.budget).reduce((acc, v) => acc + Number(v || 0), 0);

// ---------------------------------------------------------------------------
// 1. medianRttMs
// ---------------------------------------------------------------------------
section("1. medianRttMs");
{
  check("[1] median([1000,3000,2000]) === 2000", medianRttMs([1000, 3000, 2000]) === 2000, medianRttMs([1000, 3000, 2000]));
  check("[1] median([]) === 0", medianRttMs([]) === 0, medianRttMs([]));
  check("[1] median(null) === 0", medianRttMs(null) === 0, medianRttMs(null));
  check("[1] even count averages the middle", medianRttMs([1000, 2000]) === 1500, medianRttMs([1000, 2000]));
  check(
    "[1] non-numeric entries are ignored",
    medianRttMs([1000, "x", NaN, 3000]) === 2000,
    medianRttMs([1000, "x", NaN, 3000])
  );
}

// ---------------------------------------------------------------------------
// 2. rttFactorFromSamples clamp [0.75, 1.35]
// ---------------------------------------------------------------------------
section("2. rttFactorFromSamples");
{
  check("[2] empty samples -> 0.75 floor", rttFactorFromSamples([]) === 0.75, rttFactorFromSamples([]));
  check("[2] 100ms median -> 0.75 floor", rttFactorFromSamples([100, 100]) === 0.75, rttFactorFromSamples([100, 100]));
  check("[2] 1800ms median -> 1.0", rttFactorFromSamples([1800, 1800]) === 1, rttFactorFromSamples([1800, 1800]));
  check("[2] 6000ms median -> 1.35 ceiling", rttFactorFromSamples([6000, 6000]) === 1.35, rttFactorFromSamples([6000, 6000]));
  check(
    "[2] 2700ms median -> 1.35 ceiling",
    rttFactorFromSamples([2700, 2700]) === 1.35,
    rttFactorFromSamples([2700, 2700])
  );
}

// ---------------------------------------------------------------------------
// 3. Per-wave budgets match the plan (25s / 65s / 115s / 175s)
// ---------------------------------------------------------------------------
section("3. WAVE_BUDGETS_MS sums");
{
  const l1 = new StageBudgetTracker(1, []);
  const l2 = new StageBudgetTracker(2, []);
  const l3 = new StageBudgetTracker(3, []);
  const l4 = new StageBudgetTracker(4, []);

  check("[3] L1 budget sum === 25000", sumBudget(l1) === 25000, sumBudget(l1));
  check("[3] L2 budget sum === 65000", sumBudget(l2) === 65000, sumBudget(l2));
  check("[3] L3 budget sum === 115000", sumBudget(l3) === 115000, sumBudget(l3));
  check("[3] L4 budget sum === 175000", sumBudget(l4) === 175000, sumBudget(l4));

  check(
    "[3] L2 wave split is 24000/18000/23000",
    l2.budget.w1 === 24000 && l2.budget.w2 === 18000 && l2.budget.w3 === 23000,
    l2.budget
  );
  check(
    "[3] unknown depth falls back to L2",
    sumBudget(new StageBudgetTracker(9, [])) === 65000,
    sumBudget(new StageBudgetTracker(9, []))
  );
}

// ---------------------------------------------------------------------------
// 4. ETA decreases as progress advances (L2, factor 1.0)
// ---------------------------------------------------------------------------
section("4. etaSec decreases with progress");
{
  const t = new StageBudgetTracker(2, [1800, 1800]);
  t.setWave(0);
  const early = t.etaSec(6);
  const mid = t.etaSec(20);
  const late = t.etaSec(36);

  check("[4] ETA at 6% is a sane full-run estimate", early >= 55 && early <= 70, early);
  check("[4] ETA drops from 6% -> 20%", mid < early, { early, mid });
  check("[4] ETA drops from 20% -> 36%", late < mid, { mid, late });

  t.setWave(2);
  const wave3Start = t.etaSec(74);
  const wave3End = t.etaSec(99);
  check("[4] Wave 3 ETA shrinks toward the end", wave3End < wave3Start, { wave3Start, wave3End });
  check("[4] ETA is clamped to >= 2s", wave3End >= 2, wave3End);
  check("[4] 100% progress -> 0 eta", t.etaSec(100) === 0, t.etaSec(100));
}

// ---------------------------------------------------------------------------
// 5. Monotonic smoothing: never rise more than 3s above the previous ETA
// ---------------------------------------------------------------------------
section("5. monotonic smoothing");
{
  const t = new StageBudgetTracker(2, [1800, 1800]);
  t.setWave(0);
  const prev = t.etaSec(30);
  // Rewinding progress would normally inflate the raw estimate well past prev.
  const next = t.etaSec(6);

  check("[5] rewind does not exceed prev + 3s", next <= prev + 3, { prev, next });
  check("[5] smoothing caps the rise at exactly +3s here", next === prev + 3, { prev, next });

  const again = t.etaSec(6);
  check("[5] repeated calls stay monotonic", again <= next + 3 && again >= 2, { next, again });
}

// ---------------------------------------------------------------------------
// 6. Truncation ledger and branch tick hint
// ---------------------------------------------------------------------------
section("6. truncations & branch ticks");
{
  const t = new StageBudgetTracker(3, []);
  check("[6] no truncations initially", t.getTruncations().length === 0, t.getTruncations());

  t.setWave(1);
  const entry = t.markTruncated(1, "stage0a:social_web+public_records");
  check("[6] markTruncated returns the entry", entry.wave === 1 && typeof entry.at === "string", entry);

  const cuts = t.getTruncations();
  check("[6] truncation recorded", cuts.length === 1, cuts);
  check("[6] truncation wave/detail preserved", cuts[0].wave === 1 && cuts[0].detail.includes("stage0a"), cuts[0]);

  cuts.push({ wave: 99, detail: "mutated copy" });
  check("[6] getTruncations returns a defensive copy", t.getTruncations().length === 1, t.getTruncations());

  const beforeWave = t.getWave();
  const hint = t.onBranchDone();
  check(
    "[6] onBranchDone returns a positive progress hint",
    hint && Number(hint.progressDelta) > 0,
    hint
  );
  check(
    "[6] onBranchDone has no side effects",
    t.getWave() === beforeWave && t.getTruncations().length === 1,
    { wave: t.getWave(), cuts: t.getTruncations().length }
  );
}

// ---------------------------------------------------------------------------
// 7. Clamp bounds & RTT sensitivity
// ---------------------------------------------------------------------------
section("7. clamp bounds & RTT sensitivity");
{
  const slow = new StageBudgetTracker(4, [6000, 6000]);
  slow.setWave(0);
  const slowEta = slow.etaSec(5);
  check("[7] slow RTT stretches Wave 1 estimate", slowEta > 150, slowEta);
  check("[7] ETA upper clamp <= 300", slowEta <= 300, slowEta);

  const fast = new StageBudgetTracker(4, [100, 100]);
  fast.setWave(0);
  const fastEta = fast.etaSec(5);
  check("[7] fast RTT shrinks Wave 1 estimate", fastEta < slowEta, { fastEta, slowEta });

  const q = new StageBudgetTracker(1, []);
  q.setWave(2);
  const floorEta = q.etaSec(99.9);
  check("[7] ETA lower clamp >= 2", floorEta >= 2, floorEta);
  check("[7] estimate without progress uses remaining budget", q.etaSec() >= 2, q.etaSec());

  check("[7] remainingWaveMs is bounded by the wave budget", q.remainingWaveMs() <= 6000, q.remainingWaveMs());
  check("[7] clampNumber handles NaN", clampNumber(NaN, 3, 9) === 3, clampNumber(NaN, 3, 9));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error(`\nFailures:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("ETA unit suite OK");
