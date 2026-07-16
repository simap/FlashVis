/*
 * stub-worker-host.mjs: a minimal, protocol.js-conformant worker-side host,
 * built ONLY to shape/run scripts/worker-conformance-test.mjs while the real
 * worker host (lane/worker) doesn't exist in this worktree yet.
 *
 * This is NOT a device/runner simulation, no WASM, no flash bytes. It models
 * exactly the message-level state machine ADR-0024 §2/§4/§5/§9 describe:
 * entries land via ENTRIES, a GRANT opens the gate `index < entryLimit &&
 * playbackNs < playLimitNs`, executing an entry advances playbackNs/cursor/
 * entriesDrained/drainedCounters, and every GRANT is acked on receipt (I10).
 * A test entry's payload carries a synthetic `costNs` (stands in for the real
 * per-op simulated flash cost) and optional `fileOps` / `ticks` knobs so the
 * suite can force the scenarios each invariant needs (multi-round command
 * settling for I1, gate-then-release for I2/§9, non-accumulation for I4).
 *
 * SEAM: scripts/worker-conformance-test.mjs imports this via
 *   const { installWorkerHost } = await import(process.env.FV_WORKER_HOST || './stub-worker-host.mjs');
 * exactly the FV_LOCKSTEP/FV_SESSION pattern (lockstep-concurrency-test.mjs,
 * command-error-test.mjs), pointing the suite at the real host (lane/worker)
 * once it lands is that one env var / one import line, no other suite change.
 * The real host MUST satisfy the exact same assertions this stub is built to
 * pass; nothing here is a shortcut the real host gets to skip.
 *
 * Entry payload shapes (test-only contract, not part of protocol.js):
 *   event | gc      { costNs, fileOps? }              fileOps defaults 1/0
 *   command (plain)  { costNs, fileOps?, ticks? }      ticks>1 => settles only
 *                                                       on the ticks-th GRANT
 *                                                       that reaches it (I1)
 *   command (prep enter)  { prep: true }               instant, no cost
 *   command (prep exit)   { prep: false, costNs? }     instant; zeroes
 *                                                       drainedCounters (§9)
 */
import { C2W, W2C, msg } from '../web/src/protocol.js';

/**
 * Wire a stub worker host onto one end of a mock-worker-transport port pair.
 * @param {import('./mock-worker-transport.mjs').Port} workerPort
 */
export function installWorkerHost(workerPort) {
  let epoch = null;
  /** @type {Map<number, {index:number, kind:string, payload:object, seed:number}>} */
  let entries = new Map();
  let entryLimit = 0;
  let playLimitNs = 0;
  let scale = 1;
  let round = -1;
  let playbackNs = 0;
  let cursor = 0; // next entry index to execute
  let entriesDrained = 0;
  let fileOpCount = 0;
  let flashTimeNs = 0;
  let prepActive = false;
  // multi-tick command settling state: { index, ticksRemaining }
  let pendingCommand = null;

  function resetState(newEpoch) {
    epoch = newEpoch;
    entries = new Map();
    entryLimit = 0;
    playLimitNs = 0;
    scale = 1;
    round = -1;
    playbackNs = 0;
    cursor = 0;
    entriesDrained = 0;
    fileOpCount = 0;
    flashTimeNs = 0;
    prepActive = false;
    pendingCommand = null;
  }

  function ack() {
    workerPort.postMessage(msg(W2C.GRANT_ACK, {
      epoch,
      round,
      playbackNs,
      cursor,
      entriesDrained,
      drainedCounters: { fileOpCount, flashTimeNs },
    }));
  }

  // Executes entries while the §2 gate is open. Returns nothing; state mutates
  // in place so `ack()` (called once per GRANT, matching "every grant acked on
  // receipt") reflects exactly what this GRANT authorized.
  function executeEntries() {
    for (;;) {
      if (cursor >= entryLimit) return;
      const entry = entries.get(cursor);
      if (!entry) return; // not shipped yet (ENTRIES is prefetch-only, §4)

      if (entry.kind === 'command' && entry.payload && entry.payload.prep === true) {
        prepActive = true;
        cursor += 1;
        entriesDrained = cursor;
        continue;
      }
      if (entry.kind === 'command' && entry.payload && entry.payload.prep === false) {
        // §9 exit join: this call executing entry j at all already presumes the
        // coordinator withheld entryLimit at j until every session's
        // entriesDrained >= j-1, that withholding is coordinator-side (the
        // test plays coordinator); the worker's own obligation is: execute it
        // instantly and zero the DISPLAYED counters (flashTime, fileOpCount)
        // at the exit, per §9.
        playbackNs += entry.payload.costNs || 0;
        cursor += 1;
        entriesDrained = cursor;
        prepActive = false;
        fileOpCount = 0;
        flashTimeNs = 0;
        continue;
      }

      if (entry.kind === 'command' && entry.payload && entry.payload.ticks > 1) {
        // Multi-round settling: I1 says a command's quiescence ack IS its
        // completion, nothing (playbackNs/cursor/entriesDrained/counters)
        // may move for this entry until the tick count reaches zero.
        if (!pendingCommand || pendingCommand.index !== cursor) {
          pendingCommand = { index: cursor, ticksRemaining: entry.payload.ticks };
        }
        pendingCommand.ticksRemaining -= 1;
        if (pendingCommand.ticksRemaining > 0) return; // still in flight; stop this GRANT's execution here
        // quiesced now: apply the whole entry atomically in one step
        playbackNs += entry.payload.costNs || 0;
        fileOpCount += entry.payload.fileOps ?? 1;
        flashTimeNs += entry.payload.costNs || 0;
        cursor += 1;
        entriesDrained = cursor;
        pendingCommand = null;
        continue;
      }

      // Ordinary event / gc / single-round command entry.
      if (!prepActive && playbackNs >= playLimitNs) return; // gate closed (§2)
      const cost = entry.payload?.costNs || 0;
      playbackNs += cost;
      const fileOps = entry.payload?.fileOps ?? (entry.kind === 'gc' ? 0 : 1);
      fileOpCount += fileOps;
      flashTimeNs += cost;
      cursor += 1;
      entriesDrained = cursor;
    }
  }

  workerPort.onmessage = ({ data: m }) => {
    // I5: INIT (bootstraps the epoch) and RESET (carries the NEW epoch) are
    // exempt from the match check by construction; every other message type
    // is discarded on epoch mismatch.
    if (m.type !== C2W.INIT && m.type !== C2W.RESET && m.epoch !== epoch) {
      return; // I5 epoch coherence: stale-epoch message, discard silently
    }
    switch (m.type) {
      case C2W.INIT:
        resetState(m.epoch);
        break;
      case C2W.ENTRIES:
        for (const e of m.entries) entries.set(e.index, e);
        break;
      case C2W.GRANT:
        entryLimit = m.entryLimit;
        playLimitNs = m.playLimitNs;
        scale = m.scale;
        round = m.round;
        executeEntries();
        ack(); // I10: every grant acked on receipt, no-op or not
        break;
      case C2W.PULL:
        workerPort.postMessage(msg(W2C.FRAME, {
          epoch, heat: null, shown: null, journal: [], events: [], journalHead: 0, eventHead: 0,
        }));
        break;
      case C2W.RESET:
        resetState(m.epoch); // halt: in-flight state voided, session rebuilds
        break;
      default:
        break;
    }
  };
}
