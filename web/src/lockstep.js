/*
 * Lockstep coordinator (ADR-0016/0019, rebuilt on the ADR-0024 worker-per-session
 * wire). Runs ONE canonical, deterministic sequence across N session WORKERS, each
 * reached only through the protocol.js wire (§4) via a session-proxy on a Port. The
 * coordinator never touches a device/runner directly any more: it DERIVES a per-frame
 * grant (§2 clock-release algebra) and reads back acks + telemetry. Two modes:
 *
 *   RACE, one shared playback ceiling. §2 with a common baseline gives
 *   playLimitNs_s = max_s(acked_s) + chunk (the LEADER's consumed playback + one
 *   chunk, same for every session). Every FS is metered to the same real-time clock;
 *   a cheaper-per-op FS drains MORE entries under the identical playback ceiling, so
 *   step cursors diverge while playback stays level. A session that has fallen behind
 *   carries EXTRA headroom (rel − (acked − baseline) ≥ chunk) and burns it to catch
 *   up, we never slow the leader, we speed the laggards (MAX, not min).
 *
 *   PACE, the frontier advances one entry at a time. entryLimit = sharedIndex + 1;
 *   the shared index only moves when ∀ s : entriesDrained ≥ sharedIndex (the join).
 *   baseline is rebased per issued entry from each session's step-ack playbackNs, so
 *   the per-step headroom is chunk-fine. Cursors stay equal by construction.
 *
 * §2 is DERIVED, not accumulated: rel is recomputed from acked playbackNs every round
 * (a round advances only when every current session has acked the current round, the
 * §2 barrier), never `playLimitNs += chunk`. Unconsumed grant is revoked for free, so
 * the ADR-0020 idle-burst cannot re-enter (no consumption ⇒ rel pinned at chunk).
 *
 * A grant is sent to every session EVERY frame, a no-op (unchanged limits) when the
 * round has not advanced (I10). Determinism (I7): one coordinator sequence, the
 * gc/event coin is a SEEDED PRNG, commands ship as SOURCE with a per-command seed the
 * worker compiles against. The standing signals are derived purely from ack state:
 * `csActive` (raw per-frame: did playbackNs advance this frame) and `holding`
 * (debounced ~300ms: this session finished the shared step while a peer has not, the
 * sustained fast-FS-frozen-at-the-join wait, spec/ui.md).
 */
import { CHURN_EVENT } from './churn.js';

// mulberry32, the seeded scalar generator the canonical sequence is drawn from, so
// the gc/op interleave is identical for every worker and reproducible run to run.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GEN_SEED = 0x5eed0001;
// Per-command seeds come from their OWN stream so hand-issuing a command never shifts
// the auto-workload's gc/op interleave (ADR-0016/0019 determinism).
const CMD_SEED = 0x900d5eed;

// chunk (Δ) = scale / targetFPS (§2). The code carries `scale` as sim-ns per real-MS
// (numeric copy the die animation also uses), so chunk = scale × ms-per-frame, the
// SAME per-frame budget the pre-0024 raceClock advanced by (dt·scale at 60fps), but
// now dt-INDEPENDENT: one fixed chunk of headroom per grant, which is what makes the
// grant cadence deterministic and the watermark cleanly derived.
const TARGET_FPS = 60;
const MS_PER_FRAME = 1000 / TARGET_FPS;
// §2 requires Δ = scale / targetFPS to be FINITE (the player is "capped at playLimitNs"
// unconditionally). An infinite scale / no-delay path is off-spec: at scale = Infinity the
// worker's drain budget is Infinity, so it ignores playLimitNs and the §2 bound (which lives
// entirely in playLimitNs) does nothing, and Race flash times diverge at "max". So there is
// NO infinite scale: setSpeed clamps to MAX_SCALE and everything flows the finite path, so
// the bounded playLimitNs is always the ceiling and the 2×chunk bound holds at every slider
// position including the top. USER-SET to 1e7 = 10× real-time (real-time = 1e6 sim-ns/ms):
// past ~5× the workers go execution-bound and the bound pins the leader (holding shows):
// keeping the top at 10× lets that be observed.
const MAX_SCALE = 1e7;   // 10× real-time; the §2 "Δ is finite" cap (user-set)

// (The old STALL_GAP_NS is retired: §2 MAX-not-min means no SUSTAINED Race stall exists
//, a laggard burns headroom and catches up. The one sustained standing signal is the
// Pace / catch-up HOLD below: a fast FS frozen at the step-join waiting for a slow peer.)
// "Holding" card debounce (spec/ui.md: "'Holding' card label, debounced (~300 ms) so
// it doesn't flicker"). The RAW hold predicate can toggle within a frame or two at a
// step boundary; the card only lights after the raw signal has held continuously for
// this long, and clears the instant it drops. csActive (the CS pin / status dot) is
// the RAW per-frame blinky and is NOT debounced. Read per-frame (not cached at import)
// so the __flashvisHoldShowMs test seam can be set after the module loads (as playground
// reads it at closure-build time).
const holdDebounceMs = () => (typeof globalThis !== 'undefined' && globalThis.__flashvisHoldShowMs != null) ? globalThis.__flashvisHoldShowMs : 300;

// opsPerSec (ADR-0020/0023): EMA of the drained fileOpCount rate, in ops per SIMULATED
// flash-second (never wall-clock), so it is speed-invariant: at slow-mo an FS doing the
// same sim-work reads the same rate. Both the rate and the EMA decay key off each
// session's own sim-time advance (acked.playbackNs delta), so the smoothing is a FIXED
// window in sim time at every speed (precedent: worker-heat.js HEAT_SCALE_REF). The tau
// is 2 sim-seconds (equals the old 2000 wall-ms at real-time = 1e6 sim-ns/ms). Idle (no
// sim-time advancing) does not decay: sim-time is the only clock, and a stopped run has
// no sim-seconds, so the bar holds its last reading instead of fading on wall time.
const OPS_EMA_TAU_SIM_NS = 2e9;   // 2 simulated seconds

// Race prefetch is the STRICT ADR-0024 minimal: entries are prefetch only (they
// authorize nothing; §4), entryLimit = the shipped frontier (§0/§3), and the frontier is
// held exactly one entry ahead of the furthest session's cursor (RACE_LOOKAHEAD, below).
// A starved worker acks at once on window exhaustion and the coordinator ships the next
// fresh entry: at most one round-trip of idle, never a bug (§4 "window size is a deferred
// tuning knob"). No sized or drain-rate window: prefetch none beyond the current item.
const RACE_LOOKAHEAD = 1;           // smallest lookahead that does not deadlock (frontier > cursor so the worker may proceed)

// Bounded MAX for the §2 RACE watermark (symptom-1 fix). A too-slow FS is genuinely
// EXECUTION-bound: the coordinator grants it the headroom to catch up, but the worker
// cannot burn it (a real limit we do NOT paper over by capping animation, ADR-0022).
// The answer is to BOUND how far the leader's race clock may run ahead of the SLOWEST
// session: while the lead is under the bound the clock still advances by MAX exactly
// (small jitter => no hold), and once a session falls further behind the leader pins at
// slowest + bound and advances only as that laggard does, a real hold, but ONLY for
// the too-far-behind case. SCALE-RELATIVE (a multiple of chunk = scale × MS_PER_FRAME)
// so the visual lead stays a constant number of frames at every speed. USER-SET to
// N = 2 frames: the leader may run at most 2 x chunkNs() of race time ahead of the
// slowest session, then pins at slowest + 2 x chunk. Easy to retune here; a FIXED
// sim-ns flash-time tolerance is the alternative (swap `RACE_LEAD_BOUND_FRAMES * chunk`
// for a constant ns) if a speed-invariant absolute tolerance is wanted instead of a
// speed-invariant visual one.
const RACE_LEAD_BOUND_FRAMES = 2;   // user-set, scale-relative (x chunk)

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * @param {Object} opts
 * @param {import('./churn.js').ChurnModel} opts.churn  the ONE generator model.
 * @param {number} [opts.gcRatio]  initial share of steps spent on a GC step.
 * @param {boolean} [opts.autoTick=true]  install the 16ms frame interval (tests drive
 *   frame() manually via the returned _tick when false).
 */
export function createLockstep({ churn, gcRatio = 0.5, autoTick = true }) {
  let proxies = [];                 // participating session proxies (wire endpoints)
  const sequence = [];              // canonical step log, generated lazily, ever-growing
  let rnd = mulberry32(GEN_SEED);
  let cmdRng = mulberry32(CMD_SEED);
  let ratio = gcRatio;
  let mode = 'pace';                // 'race' | 'pace', Pace is the boot default
  let running = false;
  let scale = 20000;                // sim-ns per real-ms, the SAME scale the players use (always finite, ≤ MAX_SCALE)
  let epoch = 0;

  // ---- §2 state ----
  const baseline = new Map();       // proxy -> baseline_s (coordinator-internal, NEVER sent)
  const cached = new Map();         // proxy -> last computed grant {round, entryLimit, playLimitNs, scale}
  const shipped = new Map();        // proxy -> count of entries already prefetched
  let round = 0;                    // current grant round (the §2 barrier id)
  let lastComputedRound = -1;       // highest round we have derived a grant for
  let sharedIndex = 0;              // Pace: the one entry currently authorized (entryLimit = +1)
  let frontier = 0;                 // Race: shipped/authorized entry count

  // one-shot step nudges (paused single-step; see step())
  let forceProduce = false;         // Pace: allow one shared-index advance while paused
  let raceStepLimit = -1;           // Race: authorize up to this index once, ungated

  // ---- standing signals, updated once per frame() (both modes) ----
  // csActive: RAW per-frame, did this session's playbackNs advance since last frame?
  //   Drives the CS pin / status dot (raw real-time blinky, spec/ui.md). No debounce.
  // holdingRaw: this session finished the shared step / leads on cursor while a peer
  //   has NOT, the SUSTAINED "fast FS frozen at the join waiting for the slow peer"
  //   state (real in Pace slow-mo; also at Race↔Pace catch-up). Debounced into
  //   `holdingShown` (~holdDebounceMs()) for the "Holding" card.
  const prevPlayback = new Map();   // proxy -> playbackNs at the previous frame
  const csActive = new Map();       // proxy -> raw "advanced this frame" bool
  const holdRawSince = new Map();   // proxy -> nowMs() when holdingRaw first turned true (null when false)
  const holdingShown = new Map();   // proxy -> debounced hold bool (the card)

  // ---- opsPerSec sampling (per-session SIM time; no wall clock) ----
  const opsEma = new Map();
  const lastOps = new Map();     // proxy -> fileOpCount at the previous sample
  const lastPb = new Map();      // proxy -> acked.playbackNs (sim-ns) at the previous sample
  const opsOf = (p) => p.acked.fileOpCount ?? 0;
  function sampleRates() {
    for (const p of proxies) {
      const curOps = opsOf(p);
      const curPb = p.acked.playbackNs;
      if (!lastPb.has(p)) { lastOps.set(p, curOps); lastPb.set(p, curPb); continue; }
      const dOps = Math.max(0, curOps - (lastOps.get(p) ?? curOps));
      const dSim = curPb - (lastPb.get(p) ?? curPb);   // sim-ns (flash time) advanced this sample
      lastOps.set(p, curOps); lastPb.set(p, curPb);
      if (dSim <= 0) continue;                          // no sim-time advanced ⇒ no rate, no decay (idle holds)
      const inst = dOps / (dSim / 1e9);                 // ops per SIMULATED second
      const alpha = 1 - Math.exp(-dSim / OPS_EMA_TAU_SIM_NS);   // decay in sim time ⇒ fixed window at every speed
      const ema = opsEma.get(p) ?? 0;
      opsEma.set(p, ema + alpha * (inst - ema));
    }
  }

  // ---- canonical sequence generation (seeded coin, reproducible, identical per worker) ----
  function genStep() {
    if (rnd() < ratio) return { kind: 'gc' };
    const ev = churn.next();
    if (ev.type === CHURN_EVENT.WRITE || ev.type === CHURN_EVENT.DELETE) churn.apply(ev);
    return { kind: 'event', ev };
  }
  function ensure(n) { while (sequence.length < n) sequence.push(genStep()); }

  // Map a canonical entry to its wire shape (§4). A command ships as SOURCE (`payload`),
  // never as a live fn, a closure cannot cross the worker boundary (I7: compiled
  // worker-side with the per-command seed).
  function wireEntry(i) {
    const e = sequence[i];
    if (e.kind === 'command') return { index: i, kind: 'command', payload: e.payload, seed: e.seed };
    if (e.kind === 'event') return { index: i, kind: 'event', payload: e.ev, seed: 0 };
    return { index: i, kind: 'gc', payload: null, seed: 0 };
  }
  function shipEntries() {
    for (const p of proxies) {
      let from = shipped.get(p) ?? 0;
      if (from >= sequence.length) continue;
      const list = [];
      for (let i = from; i < sequence.length; i++) list.push(wireEntry(i));
      p.entries(list);
      shipped.set(p, sequence.length);
    }
  }

  const chunkNs = () => scale * MS_PER_FRAME;   // §2 Δ, always finite
  const wireScale = () => scale;                // always finite ⇒ the worker runs its metered (playLimitNs-capped) path

  // Pace join: advance the shared index one entry at a time, only when every session
  // has drained the current shared step (∀ entriesDrained ≥ sharedIndex). On each
  // advance, rebase every baseline to that session's step-ack playbackNs, the paced
  // position at which it finished the step, so the next step's headroom is chunk-fine.
  function paceAdvance() {
    // Advance the shared index past every step the whole field has already drained.
    // A worker can only drain entries that exist, so this naturally stops at the
    // first not-yet-drained index (it never runs ahead of generation).
    while (proxies.length && proxies.every((p) => p.acked.entriesDrained >= sharedIndex)) {
      for (const p of proxies) baseline.set(p, p.acked.playbackNs);   // rebase from the step-ack
      sharedIndex += 1;
    }
    // Make sure the CURRENT shared step exists to authorize (produce churn while
    // running, or once on a paused step()). Paused + queue drained ⇒ nothing to make.
    if ((running || forceProduce) && sharedIndex >= sequence.length) ensure(sharedIndex + 1);
    forceProduce = false;
  }

  // Derive the per-session grant for round `r` (§2). Called only when the round
  // advances; between rounds the cached grant is re-sent unchanged (I10 no-op).
  function computeGrants(r) {
    const chunk = chunkNs();
    if (mode === 'pace') {
      paceAdvance();
    } else {
      // Hold the frontier exactly RACE_LOOKAHEAD (one entry) ahead of the furthest
      // session's cursor: refill on demand as sessions drain, nothing beyond the current
      // work item (ADR-0024 §4). Run/pause gates only this GENERATOR, never execution.
      if (running) ensure(Math.max(...proxies.map((p) => p.acked.cursor), 0) + RACE_LOOKAHEAD);
      frontier = sequence.length;
    }
    // rel = MAX over sessions of (acked_s − baseline_s), plus one chunk. DERIVED from
    // current acks every time, never accumulated (I4).
    let relMax = -Infinity, relMin = Infinity;
    for (const p of proxies) {
      const d = p.acked.playbackNs - (baseline.get(p) ?? 0);
      if (d > relMax) relMax = d;
      if (d < relMin) relMin = d;
    }
    if (!isFinite(relMax)) { relMax = 0; relMin = 0; }
    let rel = relMax + chunk;
    if (mode === 'race') {
      // Bounded MAX (symptom-1): the leader's race clock may run at most
      // RACE_LEAD_BOUND_FRAMES chunks ahead of the SLOWEST session. Under the bound
      // rel IS the MAX exactly (small jitter, no hold); once a session falls further
      // behind (exec-bound, cannot burn its headroom) the ceiling pins at slowest +
      // bound and climbs only as that laggard climbs. Never below one chunk, so the
      // slowest always keeps >= chunk of headroom and nothing deadlocks. The per-
      // session clamp (>= acked_s, below) means a session already past the bound is
      // held at its own position, never rewound. Pace keeps the unbounded MAX.
      rel = Math.max(Math.min(rel, relMin + RACE_LEAD_BOUND_FRAMES * chunk), chunk);
    }
    for (const p of proxies) {
      const base = baseline.get(p) ?? 0;
      let playLimitNs = base + rel;
      if (playLimitNs < p.acked.playbackNs) playLimitNs = p.acked.playbackNs;   // clamp ≥ acked_s
      let entryLimit;
      if (mode === 'pace') entryLimit = Math.max(sharedIndex + 1, p.acked.cursor);
      else entryLimit = frontier;   // Race: authorization = the shipped frontier (ADR-0024 §0/§3)
      if (raceStepLimit >= 0) { entryLimit = raceStepLimit; playLimitNs = Infinity; }   // one-shot Race step: ungated
      cached.set(p, { round: r, entryLimit, playLimitNs, scale: wireScale() });
    }
    raceStepLimit = -1;
  }

  // The per-frame driver: ship prefetch, advance the round barrier, grant everyone.
  function frame() {
    sampleRates();
    if (!proxies.length) return;
    shipEntries();
    if (lastComputedRound < round) { computeGrants(round); lastComputedRound = round; }
    else if (proxies.every((p) => p.acked.round >= round)) {   // §2 barrier: all acked ⇒ release round+1
      round += 1;
      computeGrants(round);
      lastComputedRound = round;
    }
    shipEntries();                                             // paceAdvance may have generated a new entry
    for (const p of proxies) p.grant(cached.get(p));           // grant EVERY frame (I10)
    updateSignals(nowMs());                                    // csActive (raw) + holding (debounced)
  }

  if (autoTick && typeof setInterval !== 'undefined') setInterval(frame, 16);

  // ---- standing signals, DERIVED from ack state only (was device/pending reads) ----
  // A session is "running/animating" (never a holding candidate) while its gate is
  // open: it still has authorized entries below its playback ceiling to drain.
  function gateOpen(p) {
    const g = cached.get(p);
    if (!g) return false;
    return p.acked.playbackNs < g.playLimitNs - 1e-6 && p.acked.cursor < g.entryLimit;
  }
  // RAW hold: p is idle (gate shut) yet a peer is still working the SAME shared step /
  // is behind on the cursor, i.e. p is the FAST FS FROZEN AT THE JOIN waiting for the
  // slow peer. This is SUSTAINED, not a flicker: in Pace slow-mo the fast FS finishes
  // its step in ~90ms then sits frozen ~1.8s while the slow peer grinds; it also fires
  // during a Race↔Pace catch-up (a cursor-lead FS parked until the laggard reaches it).
  // Mode-agnostic: in STEADY Race the lead FS keeps its gate OPEN (more entries under
  // the shared ceiling), so it is never "frozen" and this stays false, matching the
  // spec note that steady Race generally won't fire.
  function holdingRaw(p) {
    if (!proxies.includes(p)) return false;
    if (gateOpen(p)) return false;                             // still has work to run, not frozen
    const c = p.acked.cursor;
    let peerWorking = false, leads = false;
    for (const q of proxies) {
      if (q === p) continue;
      const behindStep = q.acked.entriesDrained < sharedIndex; // hasn't finished the shared step
      const behindCursor = q.acked.cursor < c;                 // strictly behind p on the sequence
      if (behindCursor) leads = true;
      // the peer is genuinely the thing being waited ON: still executing (gate open) or
      // not yet done the shared step. A peer that is merely idle-behind at end-of-run
      // (nothing left to do) is NOT "working", so p does not read as holding for it.
      if ((behindStep || behindCursor) && (behindStep || gateOpen(q))) peerWorking = true;
    }
    const finishedStep = p.acked.entriesDrained >= sharedIndex;
    return peerWorking && (finishedStep || leads);
  }
  // RACE hold: p is PINNED by the bounded-MAX clock: its granted headroom has been
  // squeezed below one chunk (the RACE_LEAD_BOUND_FRAMES bound engaged) while a peer
  // sits further back (the exec-bound laggard it is waiting on). Unlike the Pace freeze,
  // a pinned leader still CREEPS forward one laggard-step per frame (so csActive may
  // blink); it is nonetheless "holding", held at the boundary, advancing only as the
  // slow peer advances. Under the bound but with the field level (no peer behind), or
  // with a full chunk of headroom (still MAX-driven), this stays false: no false hold.
  function racePinned(p) {
    const g = cached.get(p);
    if (!g) return false;
    if ((g.playLimitNs - p.acked.playbackNs) >= chunkNs() - 1) return false;   // full chunk of room ⇒ MAX-driven, not pinned
    const dp = p.acked.playbackNs - (baseline.get(p) ?? 0);
    for (const q of proxies) if (q !== p && (q.acked.playbackNs - (baseline.get(q) ?? 0)) < dp - 1) return true;  // a peer is further behind
    return false;
  }
  // Update the per-frame signals. Called once per frame() so csActive is a true
  // per-frame delta and the hold debounce advances on real time.
  function updateSignals(now) {
    for (const p of proxies) {
      const pb = p.acked.playbackNs;
      const advanced = pb > (prevPlayback.get(p) ?? 0) + 1e-6;   // advanced this frame?
      csActive.set(p, advanced);
      prevPlayback.set(p, pb);
      // Pace: the fast FS is FROZEN at the join, holding and csActive are mutually
      //   exclusive (the frame it finishes the step it counts as active, holding only
      //   from the next genuinely frozen frame). Race: the pinned leader CREEPS at the
      //   laggard's pace, so holding is the bound-pinned signal directly (not gated on
      //   being frozen this frame).
      const raw = (mode === 'race') ? racePinned(p) : (!advanced && holdingRaw(p));
      if (raw) {
        if (holdRawSince.get(p) == null) holdRawSince.set(p, now);
        holdingShown.set(p, (now - holdRawSince.get(p)) >= holdDebounceMs());
      } else {
        holdRawSince.set(p, null);
        holdingShown.set(p, false);                              // clears instantly (spec/ui.md)
      }
    }
  }
  const isHolding = (p) => holdingShown.get(p) === true;
  const isCsActive = (p) => csActive.get(p) === true;

  return {
    /** Replace the participating set (session PROXIES). New proxies are init()'d and
     *  start at baseline 0; departed proxies' per-session state is dropped. Callers
     *  reset() right after (ADR-0016) so "start at 0" always means a fresh chip. */
    setSessions(list) {
      const next = new Set(list);
      for (const p of [...baseline.keys()]) if (!next.has(p)) {
        baseline.delete(p); cached.delete(p); shipped.delete(p); opsEma.delete(p); lastOps.delete(p); lastPb.delete(p);
        prevPlayback.delete(p); csActive.delete(p); holdRawSince.delete(p); holdingShown.delete(p);
      }
      proxies = list.slice();
      for (const p of proxies) if (!baseline.has(p)) {
        baseline.set(p, 0); shipped.set(p, 0);
        if (p.setEpoch) p.setEpoch(epoch);
        if (p.init) p.init();
      }
      lastComputedRound = -1;   // re-derive grants for the new membership next frame
    },
    setGcRatio(v) { ratio = v; },
    /** m: 'race' | 'pace'. Reseat §2 baselines so no gate bursts unintentionally.
     *  Race: common origin at the field-min playback (§3 baseline = common origin) ⇒
     *  playLimitNs_s = max_s(acked)+chunk for all; a behind session then burns its
     *  extra headroom to catch the leader (MAX, not min, the intended §2 catch-up).
     *  Pace: sharedIndex = min cursor, baselines rebased to current playback, so the
     *  Race cursor divergence is caught up incrementally with nothing re-executed. */
    setMode(m) {
      if (m === mode) return;
      if (m === 'race') {
        const minPb = proxies.length ? Math.min(...proxies.map((p) => p.acked.playbackNs)) : 0;
        for (const p of proxies) baseline.set(p, minPb);
        frontier = sequence.length;
      } else {
        sharedIndex = proxies.length ? Math.min(...proxies.map((p) => p.acked.cursor)) : 0;
        for (const p of proxies) baseline.set(p, p.acked.playbackNs);
      }
      lastComputedRound = -1;
      mode = m;
    },
    get mode() { return mode; },
    /** scale: sim-ns per real-ms. Rides grant.scale (§2): the next frame's grant
     *  carries it, so a SPEED change lands in <= one frame. Rejects non-finite or
     *  negative (Infinity/-Infinity/NaN/<0); 0 is allowed (a future freeze option). */
    setSpeed(next) { if (!isFinite(next) || next < 0) throw new Error('setSpeed: speed must be finite and >= 0'); scale = Math.min(next, MAX_SCALE); lastComputedRound = -1; },   // clamp valid finite: no infinite scale (§2 Δ finite)
    start() { running = true; },
    /** Pause: gate the churn GENERATOR only (ADR-0020 / §4, no stop message). Grants
     *  keep flowing (no-ops); in-flight worker ops drain to quiescence on their own. */
    stop() { running = false; },
    get running() { return running; },
    /** Manual single nudge. Pace: allow one shared-index advance even while paused.
     *  Race: authorize one more entry per session, ungated, for this one grant. */
    step() {
      if (mode === 'pace') { forceProduce = true; }
      else {
        const base = Math.max(...proxies.map((p) => p.acked.cursor), 0);
        ensure(base + 1);
        frontier = sequence.length;
        raceStepLimit = base + 1;
      }
      lastComputedRound = -1;   // force a fresh grant carrying the nudge
      frame();
    },
    /** Fresh chip on every worker (RESET → new epoch, worker rebuilds, I5), sequence
     *  and §2 state cleared, generators re-seeded. `format` is worker-side today (the
     *  wire RESET carries only epoch'); the boot double-format is avoided by the boot
     *  flow broadcasting the ONE real format command after reset (see LANE-REPORT). */
    reset(_opts = {}) {
      epoch++;
      round = 0; lastComputedRound = -1; sharedIndex = 0; frontier = 0;
      forceProduce = false; raceStepLimit = -1;
      sequence.length = 0;
      rnd = mulberry32(GEN_SEED);
      cmdRng = mulberry32(CMD_SEED);
      churn.reset();
      for (const p of proxies) { baseline.set(p, 0); shipped.set(p, 0); cached.delete(p); p.reset(epoch); }
      opsEma.clear(); lastOps.clear(); lastPb.clear();
      prevPlayback.clear(); csActive.clear(); holdRawSince.clear(); holdingShown.clear();
    },
    get epoch() { return epoch; },
    /** Append one ATOMIC COMMAND at the frontier ("present"). `payload` is the wire
     *  SOURCE the worker compiles (per-command seed drawn here from the CMD stream so
     *  a random draw inside is identical call-for-call across workers). `label` is the
     *  echoed source text. Returns { index, entry }. NB (C↔V): the command is no
     *  longer a live fn, it ships as serializable source; the worker owns the tape. */
    broadcast(payload, label) {
      const seed = (cmdRng() * 0x100000000) >>> 0;
      const entry = { kind: 'command', payload, label, seed };
      const index = sequence.length;
      sequence.push(entry);
      shipEntries();   // prefetch it now so a paused queue still drains it (ADR-0020)
      return { index, entry };
    },
    /** What a session still has queued ahead of it (tape / present-gap). `behind` is
     *  GENUINE cross-session lag (this cursor strictly behind a peer's), false through
     *  steady Pace where cursors are equal. */
    pendingFor(proxy) {
      const c = proxy.acked.cursor;
      const front = sequence.length;
      const entries = [];
      for (let i = c; i < front; i++) if (sequence[i].kind === 'command') entries.push({ index: i, entry: sequence[i] });
      const maxCursor = proxies.length ? Math.max(...proxies.map((p) => p.acked.cursor)) : c;
      return { entries, gap: front - c, behind: c < maxCursor };
    },
    /** Per-session compare readout, rebuilt from telemetry + acks (§7 pulls / §4 acks)
     *  instead of synchronous device/runner reads. `wa` is not currently a telemetry
     *  field, see LANE-REPORT; surfaced as null until the worker reports it. */
    snapshots() {
      return proxies.map((p) => {
        const t = p.telemetry;
        const lc = t.livenessCounts;
        const programmed = lc.live + lc.obsolete + lc.metadata;
        const garbagePct = programmed ? lc.obsolete / programmed : 0;
        // The two pinned C↔V standing-signal contracts (spec/ui.md): `holding` is the
        // DEBOUNCED "Holding" card (sustained fast-FS-frozen-at-the-join), `csActive`
        // is the RAW per-frame CS-pin/status-dot blinky (playback advanced this frame).
        const holding = isHolding(p);
        return {
          fsId: p.fsId, name: p.name,
          stepCursor: p.acked.cursor,
          fileOpCount: p.acked.fileOpCount,
          // flashTimeNs is the PACED flash time (drainedCounters, advances with the §2
          // playbackNs the grant bounds), so in Race it converges across FS within the
          // 2x chunk bound: this is the flash time the FS card should show. simNs is the
          // EXECUTION counter (telemetry only): it vaults atomically when a command runs,
          // so it leads paced playback by up to one command and does NOT converge. Both
          // are exposed; the card reads flashTimeNs (playground read swapped at merge).
          flashTimeNs: p.acked.flashTimeNs,
          simNs: t.simNs,
          wa: t.wa,
          files: t.fsinfo.files,
          garbagePct,
          opsPerSec: Math.max(0, opsEma.get(p) ?? 0),
          holding,
          csActive: isCsActive(p),
        };
      });
    },
    /** Cheap per-fsId standing-signal map (no telemetry walk) for the per-frame pins /
     *  status dots. Each entry is `{ csActive, holding }`, csActive raw (CS pin /
     *  status dot blinky), holding debounced (the "Holding" card). Same two values
     *  snapshots() carries, for consumers that poll per frame without the full snap. */
    waitStates() {
      const out = {};
      for (const p of proxies) out[p.fsId] = { csActive: isCsActive(p), holding: isHolding(p) };
      return out;
    },
    /** Test seam: drive one frame manually (autoTick:false). */
    _tick() { frame(); },
  };
}
