// Standalone unit suite for the TAUF V6 generic task scheduler.
//
// Run:
//   "C:\Users\laksh\AppData\Local\OpenAI\Codex\runtimes\cua_node\76f5b5935a63c7ba\bin\node.exe" tests/unit/scheduler.test.mjs
//
// Prints PASS/FAIL per check and exits non-zero if anything fails.
// No network, no Tor, no real-person data: synthetic task ids only.

import { createScheduler } from "../../scripts/engine/scheduler.mjs";

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

async function main() {
  // -------------------------------------------------------------------------
  // 1. Priority order: 100 before 92 before 88
  // -------------------------------------------------------------------------
  section("1. priority order");
  {
    const order = [];
    const scheduler = createScheduler({ maxHops: 4 });

    scheduler.enqueue({ id: "low", priority: 88, run: async () => order.push("low") });
    scheduler.enqueue({ id: "high", priority: 100, run: async () => order.push("high") });
    scheduler.enqueue({ id: "mid", priority: 92, run: async () => order.push("mid") });

    const result = await scheduler.run();
    check("[1] 100 -> 92 -> 88", order.join(",") === "high,mid,low", order);
    check("[1] all three executed", result.executed.length === 3, result.executed);

    // Tie-break: same priority, lower hop first, then insertion order.
    const tieOrder = [];
    const ties = createScheduler({ maxHops: 4 });
    ties.enqueue({ id: "same-prio-hop-2", priority: 50, hop: 2, run: async () => tieOrder.push("h2") });
    ties.enqueue({ id: "same-prio-hop-1", priority: 50, hop: 1, run: async () => tieOrder.push("h1") });
    ties.enqueue({ id: "same-prio-hop-1b", priority: 50, hop: 1, run: async () => tieOrder.push("h1b") });
    await ties.run();
    check("[1] tie: lower hop, then insertion order", tieOrder.join(",") === "h1,h1b,h2", tieOrder);
  }

  // -------------------------------------------------------------------------
  // 2. Dedupe: the same id executes once; the second enqueue returns false
  // -------------------------------------------------------------------------
  section("2. dedupe by id");
  {
    let runs = 0;
    const scheduler = createScheduler();
    const first = scheduler.enqueue({ id: "dup", priority: 10, run: async () => { runs += 1; } });
    const second = scheduler.enqueue({ id: "dup", priority: 99, run: async () => { runs += 1; } });

    check("[2] first enqueue accepted", first === true, first);
    check("[2] duplicate enqueue rejected", second === false, second);

    const result = await scheduler.run();
    check("[2] duplicate executed once", runs === 1, runs);
    check("[2] executed list has one entry", result.executed.length === 1, result.executed);
    check("[2] visited set has one id", scheduler.visited.size === 1 && scheduler.visited.has("dup"), [...scheduler.visited]);
  }

  // -------------------------------------------------------------------------
  // 3. Hop cap: hop > maxHops rejected, hop === maxHops accepted
  // -------------------------------------------------------------------------
  section("3. hop cap");
  {
    const scheduler = createScheduler({ maxHops: 2 });

    check("[3] hop 3 > maxHops 2 rejected", scheduler.enqueue({ id: "too-deep", hop: 3, run: async () => {} }) === false);
    check("[3] hop 0 accepted", scheduler.enqueue({ id: "root", hop: 0, run: async () => {} }) === true);
    check("[3] hop === maxHops accepted", scheduler.enqueue({ id: "edge", hop: 2, run: async () => {} }) === true);
    check("[3] maxHops exposed", scheduler.maxHops === 2, scheduler.maxHops);
    check("[3] rejected id not visited", scheduler.visited.has("too-deep") === false, [...scheduler.visited]);

    const result = await scheduler.run();
    check("[3] hop-cap tasks executed", result.executed.length === 2, result.executed);
  }

  // -------------------------------------------------------------------------
  // 4. Abort: abort during the first task; no new tasks start afterwards
  // -------------------------------------------------------------------------
  section("4. abort signal");
  {
    const controller = new AbortController();
    const started = [];
    const scheduler = createScheduler({ signal: controller.signal });

    scheduler.enqueue({
      id: "a",
      priority: 100,
      run: async () => {
        started.push("a");
        controller.abort();
        return { id: "a" };
      },
    });
    scheduler.enqueue({ id: "b", priority: 90, run: async () => { started.push("b"); } });
    scheduler.enqueue({ id: "c", priority: 80, run: async () => { started.push("c"); } });

    const result = await scheduler.run();
    check("[4] only first task started", started.join(",") === "a", started);
    check("[4] aborted is true", result.aborted === true, result.aborted);
    check("[4] executed result retained", result.executed.length === 1 && result.executed[0].id === "a", result.executed);
    check("[4] executed result payload retained", result.executed[0]?.result?.id === "a", result.executed[0]);
    check("[4] visited keeps every enqueued id", result.visited.length === 3, result.visited);
    check("[4] no errors on abort", result.errors.length === 0, result.errors);
    check(
      "[4] enqueue after abort rejected",
      scheduler.enqueue({ id: "late", run: async () => {} }) === false
    );
  }

  // -------------------------------------------------------------------------
  // 5. Error isolation: a throwing task is recorded, the next still runs
  // -------------------------------------------------------------------------
  section("5. error isolation");
  {
    const started = [];
    const boom = new Error("synthetic task failure");
    const scheduler = createScheduler();

    scheduler.enqueue({
      id: "throws",
      priority: 100,
      run: async () => {
        started.push("throws");
        throw boom;
      },
    });
    scheduler.enqueue({
      id: "survives",
      priority: 90,
      run: async () => {
        started.push("survives");
        return "ok";
      },
    });

    const result = await scheduler.run();
    check("[5] both tasks started", started.join(",") === "throws,survives", started);
    check("[5] error recorded for throwing task", result.errors.length === 1 && result.errors[0].id === "throws", result.errors);
    check("[5] original error retained", result.errors[0]?.error === boom, result.errors[0]);
    check("[5] next task still executed", result.executed.length === 1 && result.executed[0].result === "ok", result.executed);
    check("[5] throwing task not in executed", result.executed.every((e) => e.id !== "throws"), result.executed);
  }

  // -------------------------------------------------------------------------
  // 6. stop() and stats()/visited reflect live state
  // -------------------------------------------------------------------------
  section("6. stop() / stats() / visited");
  {
    const scheduler = createScheduler({ maxHops: 3 });
    check("[6] initial queued is 0", scheduler.stats().queued === 0, scheduler.stats());

    scheduler.enqueue({ id: "one", run: async () => {} });
    scheduler.enqueue({ id: "two", run: async () => {} });
    check("[6] enqueue updates queued", scheduler.stats().queued === 2, scheduler.stats());
    check("[6] enqueue updates visited", scheduler.stats().visited === 2, scheduler.stats());
    check("[6] stats exposes maxHops", scheduler.stats().maxHops === 3, scheduler.stats());
    check("[6] not stopped before stop()", scheduler.stats().stopped === false, scheduler.stats());
    check("[6] not aborted without signal", scheduler.stats().aborted === false, scheduler.stats());

    scheduler.stop();
    check("[6] stop() flags stopped", scheduler.stats().stopped === true, scheduler.stats());
    check(
      "[6] enqueue after stop rejected",
      scheduler.enqueue({ id: "three", run: async () => {} }) === false
    );
    check("[6] rejected id not visited", scheduler.visited.has("three") === false, [...scheduler.visited]);

    const result = await scheduler.run();
    check("[6] stopped run starts nothing", result.executed.length === 0, result.executed);
    check("[6] stopped flag returned", result.stopped === true, result.stopped);
    check("[6] queue untouched by stop", scheduler.stats().queued === 2, scheduler.stats());
  }

  // -------------------------------------------------------------------------
  // 7. Missing id / sync throw handling
  // -------------------------------------------------------------------------
  section("7. edge cases");
  {
    const scheduler = createScheduler();
    check("[7] missing id rejected", scheduler.enqueue({ run: async () => {} }) === false);
    check("[7] empty id rejected", scheduler.enqueue({ id: "", run: async () => {} }) === false);
    check("[7] null id rejected", scheduler.enqueue({ id: null, run: async () => {} }) === false);

    scheduler.enqueue({
      id: "sync-throw",
      run: () => {
        throw new Error("sync failure");
      },
    });
    const result = await scheduler.run();
    check("[7] synchronous throw isolated", result.errors.length === 1 && result.errors[0].id === "sync-throw", result.errors);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failing checks:");
    for (const label of failures) console.log(`  - ${label}`);
    process.exit(1);
  }
  console.log("Scheduler unit suite OK");
  process.exit(0);
}

main().catch((error) => {
  console.error("Scheduler unit suite crashed:", error);
  process.exit(1);
});
