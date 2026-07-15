/*
 * protocol.js: the worker-per-session wire contract (ADR-0024).
 *
 * THIS FILE IS THE CROSS-LANE CONTRACT. The coordinator (main thread, "C") and
 * each session worker ("worker") exchange ONLY the messages defined here. No lane
 * may add a field, a message type, or a synchronous back-channel without changing
 * this file first: a change here is a contract change and is the lead's to make.
 *
 * Terms are ADR-0024's, by their protocol name (not single-letter symbols):
 *   baseline        per-session, coordinator-internal, NEVER sent
 *   playLimitNs     granted watermark the worker may play up to (§2)
 *   entryLimit      execute-up-to index (Pace: shared-step target; Race: shipped frontier)
 *   entriesDrained  highest entry index executed AND tape-drained
 *   round           grant id
 *   playbackNs      the protocol's currency (limits, acks, baselines, standings)
 *   simNs           telemetry-only in this protocol, NEVER the currency
 *   chunk (Delta)   = scale / targetFPS
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §2 CLOCK-RELEASE ALGEBRA (normative: C computes, worker obeys)
 *
 *   watermark:  playLimitNs_s = baseline_s + rel
 *               rel = MAX over s in S of (acked_s - baseline_s) + chunk
 *                     (acked_s = that session's last acked playbackNs)
 *               clamp: playLimitNs_s >= acked_s
 *   barrier:    release round+1  <=>  every current session has acked `round`
 *   gate:       worker executes while playbackNs < playLimitNs_s
 *               (one-op overshoot tolerated)
 *
 * Load-bearing properties (do not "optimize" away: each is a rejected-counter-model):
 *   DERIVED, NOT ACCUMULATED. rel is recomputed from acked playbackNs every round;
 *     never `playLimitNs += chunk`. Unconsumed grant is revoked for free; the
 *     ADR-0020 idle-burst bug cannot re-enter (no consumption => rel pinned at chunk).
 *   MAX, NOT MIN. Laggard headroom = rel - (acked_s - baseline_s) >= chunk; leader
 *     headroom = chunk. min would pin the ceiling to slowest+chunk and stall the
 *     leader, that lockstep is PACE's join (§3), never this inequality.
 *   chunk = scale / targetFPS => coordination cost per real-second ~ constant at
 *     every scale; at slow-mo chunk << one op so cross-FS pacing stays sub-op-fine.
 *   ADDITIVE differential: extra headroom / higher-scale range goes to whoever is
 *     behind; no ceiling is pushed below the common clock. We never slow the leader;
 *     we selectively speed the laggards up.
 *   scale rides grant.scale => a SPEED change is <= one frame, never a side channel;
 *     catch-up (late join / reseat / stall recovery) = a range granted at higher scale.
 *
 * §3 MODE BINDING (how Race/Pace bind the §2 algebra across the thread)
 *   Race:  baseline = common origin (reset/reseat) -> all equal.
 *          entryLimit = shipped frontier. Join = none (chunk barrier only).
 *          CEILING playLimitNs_s = max_s(acked_s) + chunk = leader's consumed
 *          position + one chunk (same for all); step-count divergence is intended.
 *   Pace:  baseline rebased per issued entry from its STEP-ACK playbackNs (never
 *          chunk acks). entryLimit = shared index + 1 for due sessions.
 *          Join = for all s: entriesDrained >= shared index (frontier advances one
 *          step at a time). Overshoot dies at the join.
 *
 * See adr/0024-worker-per-session.model.dedup.named.md for §5 invariants (I1-I10),
 * §7 data-pull model, §8 lifecycle, §9 prep bracket. This module is the wire; that
 * ADR is the behavior.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Coordinator -> worker message types. */
export const C2W = Object.freeze({
  INIT:    'init',     // build the session (runner+device+player+heat+journal/event rings)
  ENTRIES: 'entries',  // prefetch entries; authorizes NOTHING (commands ship as SOURCE)
  GRANT:   'grant',    // control plane: entryLimit + playLimitNs + scale, per §2; sent EVERY frame
  PULL:    'pull',     // request render/telemetry data for a rendered (focused) session
  RESET:   'reset',    // halt: let the round's acks land (<= 1 frame) then bump epoch
});

/** Worker -> coordinator message types. */
export const W2C = Object.freeze({
  GRANT_ACK: 'grantAck',  // EVERY grant acked on receipt; coordinator keeps max per round
  FRAME:     'frame',     // render payload (heat, shown/wear, liveMap, journal/events tails)
  TELEMETRY: 'telemetry', // scalars ~250ms; UNCONDITIONAL = liveness heartbeat
});

// JOURNAL_MAX >= 400 (ADR-0024 §4). Current in-process session uses 2000; the ring
// bound is worker-local: this constant is the contract floor, not a cap.
export const JOURNAL_MIN = 400;

/*
 * ── Message shapes (JSDoc typedefs; §4 of the ADR) ──────────────────────────
 * Every message carries `epoch`. I5: msg.epoch !== current => discard. A bump
 * voids {playLimitNs, scale, entries, prep-flag, suspended-metering}.
 */

/**
 * @typedef {Object} InitMsg          C2W.INIT
 * @property {number} epoch
 * @property {string} fsId
 * @property {object} geometry        {sectorSize, sectorCount, pageSize}
 * @property {string} name
 */

/**
 * @typedef {Object} EntriesMsg       C2W.ENTRIES  (prefetch only; authorizes nothing)
 * @property {number} epoch
 * @property {Array<{index:number, kind:string, payload:*, seed:number}>} entries
 *   Race: a window per cursor; Pace: frontier +1 per join. `kind` is
 *   'event' | 'gc' | 'command'. A 'command' payload is SOURCE text compiled
 *   worker-side with a per-command seed (ADR-0019 determinism).
 */

/**
 * @typedef {Object} GrantMsg         C2W.GRANT   (control plane; §2)
 * @property {number} epoch
 * @property {number} round           grant id
 * @property {number} entryLimit      execute-up-to index
 * @property {number} playLimitNs     granted watermark (§2); worker gates on it
 * @property {number} scale           sim-ns per real-ms; a change is <= one frame
 *   ALWAYS sent per frame; a no-op grant (limits unchanged) when idle (I10). Any
 *   worker activity in response to a no-op grant is a bug (I10).
 */

/**
 * @typedef {Object} PullMsg          C2W.PULL   (once/rAF per RENDERED session; §7)
 * @property {number}  epoch
 * @property {boolean} [heat]
 * @property {boolean} [wear]
 * @property {{since:number}}                 [liveMap]
 * @property {{since:number, limit:number, newest?:boolean}} [journal]
 * @property {{since:number, limit:number}}   [events]
 *   focus = pull selection (ADR-0017 focus-is-view). Unfocused sessions stream
 *   nothing; heat stays warm and a focus switch is a full-state snap repaint.
 */

/**
 * @typedef {Object} ResetMsg         C2W.RESET
 * @property {number} epoch           the NEW epoch (epoch')
 *   Halt: in-flight awaits STARVE, the session rebuilds, UI re-attaches `newest`.
 */

/**
 * @typedef {Object} GrantAckMsg      W2C.GRANT_ACK
 * @property {number} epoch
 * @property {number} round
 * @property {number} playbackNs      last acked playback position (the currency)
 * @property {number} cursor          this session's sequence cursor
 * @property {number} entriesDrained  highest index executed AND tape-drained
 * @property {object} drainedCounters {fileOpCount, flashTimeNs} (ADR-0023), NEVER exec numbers
 *   EVERY grant acked on receipt (idle = parked playbackNs); re-acked at frame
 *   cadence / on limit / at quiescence. Idempotent per round; coordinator keeps max.
 *   For a command entry, the ack that reports quiescence IS command completion (I1).
 */

/**
 * @typedef {Object} FrameHeat        full per-cell heat state (~8KB), already-decayed
 * @property {Float32Array} read       per-page read-glow channel  [pageCount]
 * @property {Float32Array} prog       per-page program-glow channel [pageCount]
 *
 * @typedef {Object} FrameShown       shown ⊕ wear (~2.3KB), full-state
 * @property {Uint16Array} pages       per-page used-bytes / fill state [pageCount]
 * @property {Uint32Array} wear        per-sector erase count [sectorCount]
 *
 * @typedef {Object} FrameLiveMap     liveMap ⊕ version (~1KB); present iff version > since
 * @property {number}     version      stamps the WALK, not the mutation (§7)
 * @property {Uint8Array} classes      per-page class code [pageCount] (per-FS taxonomy)
 *
 * @typedef {Object} EventEntry       a discrete viz-event (§7 logs; ring, monotonic id)
 *   The two triggers a full-state snapshot CANNOT represent: one-shot sector
 *   animations. Everything continuous (read/prog glow) rides `heat`, not events.
 * @property {number}  id              monotonic per epoch (I6); served {since|newest,limit}
 * @property {'erase'|'reset'} kind
 * @property {number} [sector]         erase: the swept sector
 * @property {number} [ms]             erase: worker-computed animated slot duration at scale
 *
 * @typedef {Object} FrameMsg         W2C.FRAME   (render payload; §4/§7)
 * @property {number}       epoch
 * @property {FrameHeat}    heat        full-state per frame => first pull after focus IS the snap repaint
 * @property {FrameShown}   shown
 * @property {FrameLiveMap} [liveMap]   only iff version > since
 * @property {Array}        journal     journal entries (since|newest,limit)
 * @property {EventEntry[]} events
 * @property {number}       journalHead
 * @property {number}       eventHead
 *   firstId > since+1 => ring eviction => optional UI break marker.
 */

/**
 * @typedef {Object} TelemetryMsg     W2C.TELEMETRY  (~250ms, UNCONDITIONAL heartbeat)
 * @property {number} epoch
 * @property {object} fsinfo             {files, bytes}
 * @property {object} livenessCounts     {live, obsolete, metadata}
 * @property {number} exec_fileOpCount
 * @property {number} exec_simNs         telemetry only, never the currency
 * @property {number} programBytes       cumulative bytes programmed to flash (write-amp numerator)
 * @property {number} hostBytes          cumulative bytes the host asked to write (write-amp denominator)
 * @property {number} caps               runner.caps bitmask (ADR-0011 ff_caps single-source-of-truth;
 *                                        FF_CAP_GC / FF_CAP_LIVE_MAP / FF_CAP_SECTOR_CLASSES). Static per
 *                                        epoch; sent on telemetry so the UI gates off the real bitmask,
 *                                        not a hardcoded table (fixes A3). Never let the UI assume from fsId.
 *   write-amplification = programBytes / hostBytes; ~250ms scalars, not per-op (I9 intact).
 *   Silence for k*250ms => crash (§8): console tape line, wedges, reload.
 */

/*
 * NO stop / pause / speed / focus / terminate MESSAGE (ADR-0024 §4):
 *   Run/Stop -> gates the churn GENERATOR only (main-side, ADR-0020)
 *   SPEED    -> grant.scale
 *   focus    -> pull selection
 *   terminate-> worker.terminate() AFTER settle (§8 teardown: settle acks, discard
 *               stragglers by (epoch, round, sessionId), else Pace Promise.all hangs)
 */

const C2W_SET = new Set(Object.values(C2W));
const W2C_SET = new Set(Object.values(W2C));

/** True if `t` is a coordinator->worker message type. */
export const isC2W = (t) => C2W_SET.has(t);
/** True if `t` is a worker->coordinator message type. */
export const isW2C = (t) => W2C_SET.has(t);

/**
 * Build a typed message envelope. Every message is `{type, ...payload}` and every
 * payload carries `epoch`. Kept deliberately thin: a constructor, not a framework.
 * @param {string} type  one of C2W / W2C
 * @param {object} payload  must include `epoch`
 */
export function msg(type, payload) {
  if (!isC2W(type) && !isW2C(type)) throw new Error(`protocol: unknown message type ${type}`);
  if (payload == null || typeof payload.epoch !== 'number') {
    throw new Error(`protocol: ${type} message missing numeric epoch`);
  }
  return { type, ...payload };
}
