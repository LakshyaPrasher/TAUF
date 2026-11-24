/**
 * TAUF V6 — generic bounded task scheduler
 * ----------------------------------------
 * A tiny, zero-dependency ESM priority queue for the engine's crawl stages.
 *
 * It deliberately knows nothing about pivots, networks, domains, emails or
 * handles: stages enqueue opaque task ids plus a `run` callback and the
 * scheduler enforces ordering, hop bounds, dedupe, cancellation and error
 * isolation.
 *
 *   import { createScheduler } from "./scheduler.mjs";
 *
 *   const scheduler = createScheduler({ maxHops: 4, signal });
 *   scheduler.enqueue({ id: "https://example.com", priority: 100, hop: 0, run: async (t) => {...} });
 *   const result = await scheduler.run();
 *   // -> { executed, errors, visited, aborted, stopped }
 *
 * Ordering: higher `priority` first, then lower `hop`, then insertion order.
 * `executed` holds `{ id, result }` entries for tasks whose `run` resolved;
 * thrown/rejected tasks go to `errors` as `{ id, error }` and do not stop
 * the remaining queue.
 */

/**
 * @param {object} [options]
 * @param {number} [options.maxHops=4] Maximum accepted hop depth.
 * @param {AbortSignal|null} [options.signal=null] Optional cancellation signal.
 * @returns {{
 *   enqueue: (task: { id: any, priority?: number, hop?: number, run: Function }) => boolean,
 *   run: () => Promise<{ executed: Array<{ id: any, result: any }>, errors: Array<{ id: any, error: any }>, visited: any[], aborted: boolean, stopped: boolean }>,
 *   stop: () => void,
 *   stats: () => { queued: number, visited: number, maxHops: number, stopped: boolean, aborted: boolean },
 *   visited: Set<any>,
 *   errors: Array<{ id: any, error: any }>,
 *   maxHops: number
 * }}
 */
export function createScheduler({ maxHops = 4, signal = null } = {}) {
  /** @type {Set<any>} */
  const visited = new Set();
  /** @type {Array<{ id: any, priority: number, hop: number, seq: number, run: Function }>} */
  const queue = [];
  /** @type {Array<{ id: any, error: any }>} */
  const errors = [];

  let seq = 0;
  let stopped = false;

  const isAborted = () => Boolean(signal && signal.aborted);

  // Higher priority first; then shallower hop; then enqueue order.
  function compare(a, b) {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.hop !== b.hop) return a.hop - b.hop;
    return a.seq - b.seq;
  }

  function enqueue({ id, priority = 0, hop = 0, run } = {}) {
    if (id === undefined || id === null || id === "") return false;
    if (visited.has(id)) return false;
    if (hop > maxHops) return false;
    if (stopped || isAborted()) return false;

    visited.add(id);

    const task = { id, priority, hop, seq: seq++, run };
    // Binary insertion keeps the queue ordered without a full re-sort.
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compare(queue[mid], task) <= 0) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, task);
    return true;
  }

  async function run() {
    /** @type {Array<{ id: any, result: any }>} */
    const executed = [];

    while (queue.length > 0) {
      if (stopped || isAborted()) break;

      const task = queue.shift();
      try {
        const result = await task.run(task);
        executed.push({ id: task.id, result });
      } catch (error) {
        errors.push({ id: task.id, error });
      }
    }

    return {
      executed,
      errors,
      visited: [...visited],
      aborted: isAborted(),
      stopped,
    };
  }

  function stop() {
    stopped = true;
  }

  function stats() {
    return {
      queued: queue.length,
      visited: visited.size,
      maxHops,
      stopped,
      aborted: isAborted(),
    };
  }

  return { enqueue, run, stop, stats, visited, errors, maxHops };
}
