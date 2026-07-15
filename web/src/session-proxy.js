/*
 * session-proxy.js — the coordinator's (C) view of one session worker (ADR-0024).
 *
 * Before ADR-0024 the coordinator held a real in-process `session` object and read
 * its device/runner SYNCHRONOUSLY (s.device.stats.simNs, s.pending(), s.runner.*).
 * Under worker-per-session the session lives on another thread behind a Port and the
 * only channel is the protocol.js wire (§4). This proxy is the seam: it OWNS the
 * mainPort endpoint for one worker, SENDS the C→worker control plane (init / entries
 * / grant / pull / reset), and ACCUMULATES the worker→C acks + telemetry into the
 * plain read-state the coordinator now reads instead of the old synchronous session.
 *
 * Everything the old coordinator read off a live session object is here reconstructed
 * from the wire:
 *   acked.playbackNs   — the protocol currency; last acked playback position (§2)
 *   acked.cursor       — this session's sequence cursor (was cursors.get(s))
 *   acked.entriesDrained — highest entry executed AND tape-drained (Pace join/rebase)
 *   acked.round        — last grant round this worker acked (the §2 barrier signal)
 *   acked.{fileOpCount,flashTimeNs} — drainedCounters (ADR-0023 cost view)
 *   telemetry.*        — heartbeat scalars (simNs is telemetry-only, NEVER currency)
 *
 * I5 (epoch coherence): a message whose epoch != the proxy's current epoch is
 * discarded here, at the boundary, so a straggler from before a reset() can never
 * touch fresh state. The coordinator bumps the proxy's epoch via reset(); every send
 * stamps that epoch, every receive checks it.
 */
import { msg, C2W, W2C } from './protocol.js';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * @param {{postMessage:Function, onmessage:Function, close?:Function}} port
 *   the coordinator-side (main) endpoint of the worker transport (mock or real).
 * @param {{fsId:string, name:string, geometry:object}} meta
 */
export function createSessionProxy(port, { fsId, name, geometry }) {
  let epoch = 0;
  // Coordinator-visible wire state, all reconstructed from acks/telemetry. Never a
  // live device/runner reference — the whole point of ADR-0024 is that those are on
  // the other thread. Kept as one mutable object each so the coordinator can read
  // fields cheaply every frame without allocating.
  const acked = { round: -1, playbackNs: 0, cursor: 0, entriesDrained: -1, fileOpCount: 0, flashTimeNs: 0 };
  const telemetry = { simNs: 0, fsinfo: { files: 0, bytes: 0 }, livenessCounts: { live: 0, obsolete: 0, metadata: 0 }, exec_fileOpCount: 0, programBytes: 0, hostBytes: 0, wa: 1 };
  let frame = null;          // last render FRAME (focus-only; the coordinator forwards it to the view layer)
  let lastHeardAt = 0;       // wall-ms of the last message (telemetry heartbeat = liveness, §8 crash detect)

  function resetState() {
    acked.round = -1; acked.playbackNs = 0; acked.cursor = 0; acked.entriesDrained = -1;
    acked.fileOpCount = 0; acked.flashTimeNs = 0;
    telemetry.simNs = 0; telemetry.exec_fileOpCount = 0;
    telemetry.fsinfo = { files: 0, bytes: 0 };
    telemetry.livenessCounts = { live: 0, obsolete: 0, metadata: 0 };
    telemetry.programBytes = 0; telemetry.hostBytes = 0; telemetry.wa = 1;
    frame = null;
  }

  function handle(m) {
    if (!m || m.epoch !== epoch) return;          // I5: discard anything not of the current epoch
    lastHeardAt = nowMs();
    if (m.type === W2C.GRANT_ACK) {
      // Idempotent per round; the coordinator "keeps max" (§4). playbackNs, cursor,
      // entriesDrained and round are all monotonic within an epoch, so max-merging a
      // possibly-reordered or re-acked grant can only move them forward, never back.
      acked.round = Math.max(acked.round, m.round);
      acked.playbackNs = Math.max(acked.playbackNs, m.playbackNs);
      acked.cursor = Math.max(acked.cursor, m.cursor);
      acked.entriesDrained = Math.max(acked.entriesDrained, m.entriesDrained);
      if (m.drainedCounters) {
        acked.fileOpCount = Math.max(acked.fileOpCount, m.drainedCounters.fileOpCount ?? 0);
        acked.flashTimeNs = Math.max(acked.flashTimeNs, m.drainedCounters.flashTimeNs ?? 0);
      }
    } else if (m.type === W2C.TELEMETRY) {
      telemetry.simNs = m.exec_simNs ?? telemetry.simNs;
      telemetry.exec_fileOpCount = m.exec_fileOpCount ?? telemetry.exec_fileOpCount;
      if (m.fsinfo) telemetry.fsinfo = m.fsinfo;
      if (m.livenessCounts) telemetry.livenessCounts = m.livenessCounts;
      if (typeof m.programBytes === 'number') telemetry.programBytes = m.programBytes;
      if (typeof m.hostBytes === 'number') telemetry.hostBytes = m.hostBytes;
      telemetry.wa = telemetry.hostBytes > 0 ? telemetry.programBytes / telemetry.hostBytes : 1;
      if (typeof m.caps === 'number') telemetry.caps = m.caps;   // ADR-0011 authority (A3); undefined until first telemetry => UI fails open
    } else if (m.type === W2C.FRAME) {
      frame = m;
    }
  }
  port.onmessage = (ev) => handle(ev && ev.data);

  return {
    fsId, name, geometry,
    // ---- read state (the coordinator's replacement for synchronous session reads) ----
    get acked() { return acked; },
    get telemetry() { return telemetry; },
    get frame() { return frame; },
    get lastHeardAt() { return lastHeardAt; },
    get epoch() { return epoch; },
    /** Align this proxy's epoch to the coordinator's before init (I5 stamping). */
    setEpoch(e) { epoch = e; },

    // ---- C→worker sends (every send stamps the current epoch) ----
    init() { port.postMessage(msg(C2W.INIT, { epoch, fsId, geometry, name })); },
    /** Prefetch entries (authorizes nothing — GRANT authorizes). No-op on empty. */
    entries(list) { if (list && list.length) port.postMessage(msg(C2W.ENTRIES, { epoch, entries: list })); },
    /** Control plane: { round, entryLimit, playLimitNs, scale } — sent EVERY frame (I10). */
    grant(g) { port.postMessage(msg(C2W.GRANT, { epoch, ...g })); },
    pull(sel) { port.postMessage(msg(C2W.PULL, { epoch, ...(sel || {}) })); },
    /** Bump to a new epoch and tell the worker to rebuild (I5); local state zeroes. */
    reset(newEpoch) { epoch = newEpoch; resetState(); port.postMessage(msg(C2W.RESET, { epoch: newEpoch })); },
    close() { if (port.close) port.close(); },
  };
}
