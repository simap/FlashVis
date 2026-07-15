/*
 * Session client (ADR-0024 §4/§7/§8): the main-thread facade for ONE
 * worker-per-session. Owns exactly the render/telemetry-CONSUMING half of the
 * protocol — PULL (once/rAF, focused sessions only) and the two inbound data
 * messages, FRAME and TELEMETRY. It does NOT own ENTRIES/GRANT (the clock-
 * release algebra, §2 — that is the coordinator's job, driving `port`/`worker`
 * independently) — this module only ever SENDS init + pull + reset and only
 * ever READS frame + telemetry off the same port, discarding anything whose
 * epoch doesn't match (I5) and ignoring grantAck (the coordinator's concern).
 *
 * `port` is anything shaped like a Worker/MessagePort: `.postMessage(m)` +
 * `.onmessage = fn`. A real `new Worker(...)` satisfies it directly; tests
 * wire it to a `mock-worker-transport.mjs` port pair.
 *
 * NB: because a mock/real port exposes only ONE `.onmessage` slot (not
 * `addEventListener`, which would let two independent listeners coexist), a
 * session's port can have only one reader. If the coordinator (lockstep.js)
 * also needs grantAck off the SAME port, whoever owns worker construction
 * must demux by message type before handing this module its `port` — see the
 * lane report for this open cross-lane wiring question.
 */
import { C2W, W2C, msg } from './protocol.js';

/**
 * @param {Object} opts
 * @param {{postMessage:Function, onmessage:*}} opts.port  the worker-facing port
 * @param {string} opts.fsId
 * @param {string} [opts.name]
 * @param {Object} opts.geometry   {sectorSize, sectorCount, pageSize}
 * @param {number} [opts.epoch]    starting epoch (default 0)
 * @param {number} [opts.journalLimit]  tape lines to request per pull (default 400 — JOURNAL_MIN)
 */
export function createSessionClient({ port, fsId, name, geometry, epoch = 0 }) {
  let currentEpoch = epoch;
  let focused = false;
  let disposed = false;
  let attachedFresh = false;   // true once the next pull must re-attach (newest) — focus/re-foreground/epoch bump (§7)
  let lastFrame = null;
  let lastTelemetry = null;
  let journalSince = 0, eventsSince = 0, liveMapVersionSeen = 0;
  const frameSubs = new Set();
  const telemetrySubs = new Set();

  port.postMessage(msg(C2W.INIT, { epoch: currentEpoch, fsId, geometry, name: name || fsId }));

  port.onmessage = (e) => {
    const m = e.data;
    if (!m || m.epoch !== currentEpoch) return;   // I5: a stale/foreign epoch is discarded
    if (m.type === W2C.FRAME) {
      lastFrame = m;
      if (m.liveMap) liveMapVersionSeen = m.liveMap.version;
      if (m.journalHead != null) journalSince = m.journalHead;
      if (m.eventHead != null) eventsSince = m.eventHead;
      for (const cb of frameSubs) cb(m);
    } else if (m.type === W2C.TELEMETRY) {
      lastTelemetry = m;
      for (const cb of telemetrySubs) cb(m);
    }
    // grantAck: not this module's concern (the coordinator's algebra, §2).
  };

  /** Issue one PULL for this session (ADR-0024 §7). Only meaningful while
   *  focused — call once/rAF for the focused session; unfocused sessions
   *  stream nothing (heat stays warm worker-side; a later focus switch gets
   *  a full-state snap repaint via `newest`). */
  function pull() {
    if (!focused || disposed) return;
    port.postMessage(msg(C2W.PULL, {
      epoch: currentEpoch,
      heat: true,
      wear: true,
      liveMap: { since: liveMapVersionSeen },
      journal: attachedFresh ? { since: 0, limit: 400, newest: true } : { since: journalSince, limit: 400 },
      events: attachedFresh ? { since: 0, limit: 400 } : { since: eventsSince, limit: 400 },
    }));
    attachedFresh = false;
  }

  return {
    fsId, name: name || fsId,

    /** Set whether this session is the FOCUSED (rendered) one — focus is a
     *  pure view property (ADR-0017/0024 §8): no worker message on its own,
     *  just changes whether pull() actually sends anything and marks the
     *  NEXT pull as a fresh re-attach (`newest`) so it lands as the snap
     *  repaint (§7 "first pull after focus IS the snap repaint"). */
    setFocused(v) {
      v = !!v;
      if (v && !focused) attachedFresh = true;
      focused = v;
    },
    get focused() { return focused; },

    pull,

    /** Subscribe to every FRAME this session's port delivers (fires
     *  regardless of focus — a caller that wants focused-only should gate on
     *  `.focused` itself, since a stray frame after an unfocus can still
     *  arrive in flight). Returns an unsubscribe fn. */
    onFrame(cb) { frameSubs.add(cb); return () => frameSubs.delete(cb); },
    /** Subscribe to TELEMETRY — every session streams this UNCONDITIONALLY
     *  (~250ms heartbeat, ADR-0024 §4), focused or not, which is what backs
     *  the compare strip for every participant at once. */
    onTelemetry(cb) { telemetrySubs.add(cb); return () => telemetrySubs.delete(cb); },

    get lastFrame() { return lastFrame; },
    get lastTelemetry() { return lastTelemetry; },

    /** Bump to a new epoch (ADR-0024 §8 reset/teardown): voids in-flight
     *  state, clears cached frame/telemetry, and re-attaches `newest` on the
     *  next pull. Does not itself send RESET — the coordinator does that
     *  (it owns the grant/round machinery reset() must settle first). */
    rebase(newEpoch) {
      currentEpoch = newEpoch;
      lastFrame = null; lastTelemetry = null;
      journalSince = 0; eventsSince = 0; liveMapVersionSeen = 0;
      attachedFresh = true;
    },

    /** Detach this client from its port (teardown, ADR-0024 §8). Does not
     *  terminate the worker — that is the caller's job, after settling. */
    dispose() {
      disposed = true;
      port.onmessage = null;
      frameSubs.clear(); telemetrySubs.clear();
    },
  };
}
