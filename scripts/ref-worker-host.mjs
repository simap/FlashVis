/*
 * ref-worker-host.mjs — a REFERENCE worker-side host speaking protocol.js,
 * wrapping the REAL session.js/runner.js/device.js (real WASM).
 *
 * STATUS (see LANE-REPORT.md "seam" section): lane/worker owns the production
 * worker host; it does not exist in this worktree yet. This module is test
 * infrastructure only — a faithful-enough stand-in so the converted concurrency
 * suite has something real to run against today. It is bound in by
 * `scripts/worker-harness.mjs` via the FV_WORKER_HOST env seam, so swapping in
 * lane/worker's real module (once it lands and exports the same
 * `attachWorkerHost(workerPort, opts)` shape) is a one-line env change, not a
 * test rewrite. Flagged simplifications vs. the full ADR-0024 model:
 *
 *   - playbackNs is modeled here as `device.stats.simNs` at each entry's
 *     completion (a monotonic proxy for "flash time consumed so far"), NOT the
 *     real player/viz PACED clock (§6 "player... playback at realBudget×scale").
 *     Good enough for exactly-once / round-barrier / epoch-discard mechanics
 *     (what this lane converts); NOT sufficient to reproduce the real
 *     Pace/Race stall/holding/waiting UI signals (§3), which is why those
 *     scenarios are left unconverted — see LANE-REPORT.md.
 *   - no heat/wear/liveMap in FRAME (unused by the converted scenarios).
 *   - the "gate" a torture command awaits (forcing a deterministic mid-command
 *     window, ADR-0024 carrying forward the old suite's forcing technique) is
 *     TEST RIGGING, not a protocol message: the harness sets
 *     `globalThis.__fvTestGate` directly (same process as the mock transport)
 *     before compiling command source that reads it. A real cross-thread
 *     worker cannot see that global; production gating (if ever needed) would
 *     require a protocol message, which is exactly the kind of thing that
 *     would need the lead's sign-off on protocol.js — not invented here.
 */
import { createSession } from '../web/src/session.js';
import { installFakeDom } from './fake-dom.mjs';
import { C2W, W2C, msg } from '../web/src/protocol.js';

/**
 * Wire a reference worker host to `workerPort` (the `self`-side of a
 * mock-worker-transport pair). One host = one session, matching ADR-0024's
 * "worker granularity = one session" partition.
 */
// TEST-ONLY mutation seam (NOT a production flag): set to reproducibly
// reintroduce the exactly-once bug this host's re-entrancy guard closes, so
// the converted suite can prove its own assertion is not vacuous — the same
// role scripts/TEST-GAPS.md's `FV_LOCKSTEP`-pointed scratch mutants played for
// the old suite, just inline here since this whole module IS test
// infrastructure (see file banner). Left unset by `npm test`.
const NO_REENTRY_GUARD = process.env.FV_REF_HOST_NO_GUARD === '1';
// Same idea, for the ENTRIES-dedup guard (a re-sent/duplicated prefetch window
// must not double-append an index — see the ENTRIES handler below).
const NO_ENTRIES_DEDUP = process.env.FV_REF_HOST_NO_DEDUP === '1';

export function attachWorkerHost(workerPort) {
  let session = null;
  let epoch = -1;
  let entries = [];
  let cursor = 0;
  let playbackNs = 0;
  let runningEpoch = -1;        // epoch of the currently-running pump loop, or -1 if idle (I10/exactly-once)
  let pendingRound = -1;        // highest round to ack once the (possibly already-running) loop settles

  async function onInit(m) {
    epoch = m.epoch;
    entries = [];
    cursor = 0;
    playbackNs = 0;
    runningEpoch = -1;
    pendingRound = -1;
    installFakeDom();
    session = await createSession(m.fsId, {
      geometry: m.geometry,
      container: document.createElement('div'),
      name: m.name,
    });
    session.freshFormat(); // fresh, mounted chip — matches the old rig's coord.reset() at construction
  }

  function compileCommand(source) {
    // eslint-disable-next-line no-eval
    return (0, eval)(source);
  }

  // Drain entries up to the CURRENT grant's limits (read fresh off `pendingRound`'s
  // caller-supplied limits each loop iteration via the closed-over `limits` box,
  // so a grant that arrives while a loop is already running just raises the
  // ceiling for the SAME loop instead of spawning a second one — the worker-local
  // analog of the old coordinator's busy-map: exactly one dispatcher touches
  // `cursor`/`entries[cursor]` at a time). epoch is snapshotted at entry; any
  // await inside re-checks it, so a reset() landing mid-command STARVES this
  // loop (§8) instead of resurrecting a stale cursor/ack into the new epoch (I5).
  let limits = { entryLimit: 0, playLimitNs: 0 };
  async function pumpGrant(m) {
    limits = { entryLimit: m.entryLimit, playLimitNs: m.playLimitNs };
    pendingRound = m.round;
    // Re-entrancy guard scoped to the CURRENT epoch only: a loop already
    // draining THIS epoch just gets its ceiling raised (limits/pendingRound,
    // above) and will ack the latest round when it next re-checks the
    // while-condition — no second dispatcher ever touches `cursor`. A loop
    // left running from a STALE (already-reset) epoch does not block a fresh
    // epoch's grant from starting; it starves on its own (below).
    if (runningEpoch === epoch && !NO_REENTRY_GUARD) return;
    const myEpoch = epoch;
    runningEpoch = myEpoch;
    try {
      while (epoch === myEpoch && session && cursor < entries.length && cursor < limits.entryLimit && playbackNs < limits.playLimitNs) {
        const e = entries[cursor];
        if (e.kind === 'command') {
          const fn = compileCommand(e.payload);
          // §8 "in-flight awaits STARVE": once a reset() bumps epoch mid-command,
          // every SUBSEQENT op the command's fn issues (via the local API's
          // runOp -> pace.before/after) must hang forever, never touching the
          // freshly-reformatted chip — not just "the loop notices and stops
          // bookkeeping" (below). A real op already past pace.before() when the
          // epoch bumps still completes (matches ADR-0019: reset lets the
          // round's in-flight op land, then bumps epoch); only ops that haven't
          // yet cleared the gate are starved.
          const pace = {
            before: () => (epoch === myEpoch ? Promise.resolve() : new Promise(() => {})),
            after: () => (epoch === myEpoch ? Promise.resolve() : new Promise(() => {})),
          };
          await session.runCommand(fn, e.seed, pace);
        } else if (e.kind === 'event') {
          session.runChurnEvent(e.payload);
        } else if (e.kind === 'gc') {
          session.runGcStep();
        }
        if (epoch !== myEpoch) break; // reset landed while this op was in flight — abandon, no cursor/playback write
        playbackNs = session.device.stats.simNs;
        cursor++;
      }
    } finally {
      if (runningEpoch === myEpoch) runningEpoch = -1; // don't clobber a newer loop's flag
    }
    if (epoch === myEpoch) ack(pendingRound);
  }

  function ack(round) {
    workerPort.postMessage(msg(W2C.GRANT_ACK, {
      epoch,
      round,
      playbackNs,
      cursor,
      entriesDrained: cursor,
      drainedCounters: {
        fileOpCount: session ? session.fileOpCount : 0,
        flashTimeNs: session ? session.device.stats.simNs : 0,
      },
    }));
  }

  function sendFrame(pull) {
    const jr = pull.journal;
    const j = session ? session.journal : [];
    const jSlice = jr ? j.slice(Math.max(0, j.length - (jr.limit || j.length))) : [];
    workerPort.postMessage(msg(W2C.FRAME, {
      epoch,
      heat: null,
      shown: null,
      journal: jSlice,
      events: [],
      journalHead: j.length,
      eventHead: 0,
    }));
  }

  workerPort.onmessage = (ev) => {
    const m = ev.data;
    (async () => {
      if (m.type === C2W.INIT) { await onInit(m); return; }
      if (m.type === C2W.RESET) {
        // RESET carries the NEW epoch (epoch') by definition (protocol.js) —
        // it is exempt from the generic epoch-discard check below, which
        // exists to reject messages STAMPED WITH a stale epoch, not the
        // message that MINTS the next one.
        epoch = m.epoch;
        entries = [];
        cursor = 0;
        playbackNs = 0;
        // `runningEpoch` is left alone on purpose — a stale in-flight pumpGrant
        // loop (if any) checks `epoch === myEpoch` itself and abandons (see
        // pumpGrant); clearing it here would let a fresh grant race a
        // still-in-flight stale command's runCommand microtasks.
        if (session) session.freshFormat();
        return;
      }
      if (m.epoch !== epoch) return; // I5: stale-epoch message discarded
      if (m.type === C2W.ENTRIES) {
        if (NO_ENTRIES_DEDUP) { entries.push(...m.entries); return; }
        const seen = new Set(entries.map((e) => e.index));
        for (const e of m.entries) if (!seen.has(e.index)) { entries.push(e); seen.add(e.index); }
        return;
      }
      if (m.type === C2W.GRANT) { await pumpGrant(m); return; }
      if (m.type === C2W.PULL) { sendFrame(m); return; }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('ref-worker-host: unhandled error', err);
    });
  };
}
