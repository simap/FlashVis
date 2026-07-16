/*
 * mock-worker.mjs: a faithful, minimal session WORKER for the ADR-0024 wire.
 *
 * Lives on the `workerPort` of mock-worker-transport.mjs and speaks ONLY protocol.js
 * messages. It is NOT the real session (no WASM, no runner); it is the smallest thing
 * that HONORS the §2 gate so the coordinator's grant/ack/round algebra can be exercised
 * end to end over structuredClone + async delivery:
 *
 *   - executes an entry's ops one at a time while `playbackNs < playLimitNs` AND
 *     `cursor < entryLimit` (the §2 gate, one-op overshoot tolerated);
 *   - a command entry's ops meter under the same gate but its cursor only advances at
 *     the LAST op (quiescence), so the ack that reports it IS command completion (I1);
 *   - playbackNs is the currency (advances with metered execution); exec_simNs mirrors
 *     it as telemetry; a per-worker `unit` cost makes a "cheap" vs "pricey" FS diverge
 *     in step count under an identical playback ceiling (the Race comparison);
 *   - acks EVERY grant on receipt (idle = a re-ack of parked playbackNs), idempotent
 *     per round; discards any message whose epoch != its own (I5).
 *
 * Entry cost model (test-controllable):
 *   gc / event  → 1 op, cost = unit
 *   command     → payload.ops = number[] (per-op base costs); op i costs ops[i]*unit
 */

export function createMockWorker(port, { unit = 1e6, maxOpsPerGrant = 64 } = {}) {
  let epoch = -1;
  let entries = new Map();
  let cursor = 0, opIndex = 0, playbackNs = 0, execNs = 0, entriesDrained = -1, fileOpCount = 0, writes = 0;
  let lastRound = -1;

  function rebuild(e) {
    epoch = e; entries = new Map();
    cursor = 0; opIndex = 0; playbackNs = 0; execNs = 0; entriesDrained = -1; fileOpCount = 0; writes = 0; lastRound = -1;
  }

  const opsCount = (entry) => (entry.kind === 'command' && entry.payload && Array.isArray(entry.payload.ops) ? entry.payload.ops.length : 1);
  function opCost(entry, i) {
    if (entry.kind === 'command' && entry.payload && Array.isArray(entry.payload.ops)) return entry.payload.ops[i] * unit;
    return unit;
  }
  const isFileOp = (entry) => entry.kind !== 'gc';

  function ack(round) {
    port.postMessage({
      type: 'grantAck', epoch, round, playbackNs, cursor, entriesDrained,
      drainedCounters: { fileOpCount, flashTimeNs: execNs },
    });
  }
  function telemetry() {
    port.postMessage({
      type: 'telemetry', epoch,
      fsinfo: { files: writes, bytes: writes * 1024 },
      livenessCounts: { live: writes, obsolete: 0, metadata: 0 },
      exec_fileOpCount: fileOpCount, exec_simNs: execNs,
    });
  }

  function onGrant(g) {
    lastRound = g.round;
    // A real worker can only execute so many ops per frame (BACKLOG bound, ADR-0019);
    // without this a laggard would vault the entire divergence in one grant. The §2
    // gate (playback ceiling) is the primary limit; this cap only binds on a burst.
    let budget = maxOpsPerGrant;
    // §2 gate: run while below the playback ceiling with authorized entries present.
    while (budget-- > 0 && cursor < g.entryLimit && entries.has(cursor) && playbackNs < g.playLimitNs) {
      const entry = entries.get(cursor);
      const n = opsCount(entry);
      playbackNs += opCost(entry, opIndex);
      execNs = playbackNs;
      if (isFileOp(entry)) fileOpCount += 1;
      opIndex += 1;
      if (opIndex >= n) {                       // entry complete (command: quiescence)
        if (entry.kind !== 'gc') writes += 1;
        entriesDrained = cursor;
        cursor += 1;
        opIndex = 0;
      }
    }
    ack(g.round);          // EVERY grant acked, even a no-op (idle = parked playbackNs)
    telemetry();
  }

  port.onmessage = (ev) => {
    const m = ev && ev.data;
    if (!m) return;
    if (m.type === 'init' || m.type === 'reset') { rebuild(m.epoch); return; }
    if (m.epoch !== epoch) return;              // I5: discard off-epoch stragglers
    if (m.type === 'entries') { for (const e of m.entries) entries.set(e.index, e); return; }
    if (m.type === 'grant') { onGrant(m); return; }
    // 'pull' (focus render) is not modeled by the mock.
  };

  return {
    get epoch() { return epoch; },
    get cursor() { return cursor; },
    get playbackNs() { return playbackNs; },
    get execNs() { return execNs; },
    get entriesDrained() { return entriesDrained; },
    get lastRound() { return lastRound; },
  };
}
