/*
 * Lockstep coordinator (ADR-0016/0019, rebuilt on the ADR-0024 worker-per-session
 * wire). Runs ONE canonical, deterministic sequence across N session WORKERS, each
 * reached only through the protocol.js wire (§4) via a session-proxy on a Port. The
 * coordinator never touches a device/runner directly any more: it DERIVES a per-frame
 * grant (§2 clock-release algebra) and reads back acks + telemetry. Two modes:
 *
 *   RACE — one shared playback ceiling. §2 with a common baseline gives
 *   playLimitNs_s = max_s(acked_s) + chunk (the LEADER's consumed playback + one
 *   chunk, same for every session). Every FS is metered to the same real-time clock;
 *   a cheaper-per-op FS drains MORE entries under the identical playback ceiling, so
 *   step cursors diverge while playback stays level. A session that has fallen behind
 *   carries EXTRA headroom (rel − (acked − baseline) ≥ chunk) and burns it to catch
 *   up — we never slow the leader, we speed the laggards (MAX, not min).
 *
 *   PACE — the frontier advances one entry at a time. entryLimit = sharedIndex + 1;
 *   the shared index only moves when ∀ s : entriesDrained ≥ sharedIndex (the join).
 *   baseline is rebased per issued entry from each session's step-ack playbackNs, so
 *   the per-step headroom is chunk-fine. Cursors stay equal by construction.
 *
 * §2 is DERIVED, not accumulated: rel is recomputed from acked playbackNs every round
 * (a round advances only when every current session has acked the current round — the
 * §2 barrier), never `playLimitNs += chunk`. Unconsumed grant is revoked for free, so
 * the ADR-0020 idle-burst cannot re-enter (no consumption ⇒ rel pinned at chunk).
 *
 * A grant is sent to every session EVERY frame — a no-op (unchanged limits) when the
 * round has not advanced (I10). Determinism (I7): one coordinator sequence, the
 * gc/event coin is a SEEDED PRNG, commands ship as SOURCE with a per-command seed the
 * worker compiles against. The standing signals are derived purely from ack state:
 * `csActive` (raw per-frame: did playbackNs advance this frame) and `holding`
 * (debounced ~300ms: this session finished the shared step while a peer has not — the
 * sustained fast-FS-frozen-at-the-join wait, spec/ui.md).
 */
import { CHURN_EVENT } from './churn.js';

// mulberry32 — the seeded scalar generator the canonical sequence is drawn from, so
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
// (numeric copy the die animation also uses), so chunk = scale × ms-per-frame — the
// SAME per-frame budget the pre-0024 raceClock advanced by (dt·scale at 60fps), but
// now dt-INDEPENDENT: one fixed chunk of headroom per grant, which is what makes the
// grant cadence deterministic and the watermark cleanly derived.
const TARGET_FPS = 60;
const MS_PER_FRAME = 1000 / TARGET_FPS;
// No-delay (scale = Infinity): a fixed sim-ns chunk per frame so workers run flat-out
// yet stay pinned to the same advancing ceiling (sim-synced), not racing off by speed.
const NO_DELAY_STEP_NS = 50 * 1e6;

// (The old STALL_GAP_NS is retired: §2 MAX-not-min means no SUSTAINED Race stall exists
// — a laggard burns headroom and catches up. The one sustained standing signal is the
// Pace / catch-up HOLD below: a fast FS frozen at the step-join waiting for a slow peer.)
// "Holding" card debounce (spec/ui.md: "'Holding' card label — debounced (~300 ms) so
// it doesn't flicker"). The RAW hold predicate can toggle within a frame or two at a
// step boundary; the card only lights after the raw signal has held continuously for
// this long, and clears the instant it drops. csActive (the CS pin / status dot) is
// the RAW per-frame blinky and is NOT debounced. Read per-frame (not cached at import)
// so the __flashvisHoldShowMs test seam can be set after the module loads (as playground
// reads it at closure-build time).
const holdDebounceMs = () => (typeof globalThis !== 'undefined' && globalThis.__flashvisHoldShowMs != null) ? globalThis.__flashvisHoldShowMs : 300;

// opsPerSec (ADR-0020/0023): EMA of the drained fileOpCount rate, smoothed ~2s so the
// coarse per-step arrivals average into a steady bar and decay to 0 when idle.
const OPS_EMA_TAU_MS = 2000;

// Race prefetch lookahead: keep the shipped frontier this far ahead of the leader's
// cursor while running, so a bursting laggard never starves for an authorized entry.
const RACE_LOOKAHEAD = 256;

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
  let mode = 'pace';                // 'race' | 'pace' — Pace is the boot default
  let running = false;
  let scale = 20000;                // sim-ns per real-ms — the SAME scale the players use
  let atMax = false;                // no-delay flag — set by setSpeed(Infinity)
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
  // csActive: RAW per-frame — did this session's playbackNs advance since last frame?
  //   Drives the CS pin / status dot (raw real-time blinky, spec/ui.md). No debounce.
  // holdingRaw: this session finished the shared step / leads on cursor while a peer
  //   has NOT — the SUSTAINED "fast FS frozen at the join waiting for the slow peer"
  //   state (real in Pace slow-mo; also at Race↔Pace catch-up). Debounced into
  //   `holdingShown` (~holdDebounceMs()) for the "Holding" card.
  const prevPlayback = new Map();   // proxy -> playbackNs at the previous frame
  const csActive = new Map();       // proxy -> raw "advanced this frame" bool
  const holdRawSince = new Map();   // proxy -> nowMs() when holdingRaw first turned true (null when false)
  const holdingShown = new Map();   // proxy -> debounced hold bool (the card)

  // ---- opsPerSec sampling ----
  const opsEma = new Map();
  const lastOps = new Map();
  let lastSampleNow = 0;
  const opsOf = (p) => p.acked.fileOpCount ?? 0;
  function sampleRates(now) {
    if (!lastSampleNow) { lastSampleNow = now; for (const p of proxies) lastOps.set(p, opsOf(p)); return; }
    const dt = now - lastSampleNow;
    if (dt <= 0) return;
    lastSampleNow = now;
    const alpha = 1 - Math.exp(-dt / OPS_EMA_TAU_MS);
    for (const p of proxies) {
      const cur = opsOf(p);
      const inst = Math.max(0, cur - (lastOps.get(p) ?? cur)) / (dt / 1000);
      lastOps.set(p, cur);
      const ema = opsEma.get(p) ?? 0;
      opsEma.set(p, ema + alpha * (inst - ema));
    }
  }

  // ---- canonical sequence generation (seeded coin — reproducible, identical per worker) ----
  function genStep() {
    if (rnd() < ratio) return { kind: 'gc' };
    const ev = churn.next();
    if (ev.type === CHURN_EVENT.WRITE || ev.type === CHURN_EVENT.DELETE) churn.apply(ev);
    return { kind: 'event', ev };
  }
  function ensure(n) { while (sequence.length < n) sequence.push(genStep()); }

  // Map a canonical entry to its wire shape (§4). A command ships as SOURCE (`payload`),
  // never as a live fn — a closure cannot cross the worker boundary (I7: compiled
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

  const chunkNs = () => (atMax ? NO_DELAY_STEP_NS : scale * MS_PER_FRAME);
  const wireScale = () => (atMax ? Infinity : scale);

  // Pace join: advance the shared index one entry at a time, only when every session
  // has drained the current shared step (∀ entriesDrained ≥ sharedIndex). On each
  // advance, rebase every baseline to that session's step-ack playbackNs — the paced
  // position at which it finished the step — so the next step's headroom is chunk-fine.
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
      if (running) ensure(Math.max(...proxies.map((p) => p.acked.cursor), 0) + RACE_LOOKAHEAD);
      frontier = sequence.length;
    }
    // rel = MAX over sessions of (acked_s − baseline_s), plus one chunk. DERIVED from
    // current acks every time — never accumulated (I4).
    let rel = -Infinity;
    for (const p of proxies) rel = Math.max(rel, p.acked.playbackNs - (baseline.get(p) ?? 0));
    if (!isFinite(rel)) rel = 0;
    rel += chunk;
    for (const p of proxies) {
      const base = baseline.get(p) ?? 0;
      let playLimitNs = base + rel;
      if (playLimitNs < p.acked.playbackNs) playLimitNs = p.acked.playbackNs;   // clamp ≥ acked_s
      let entryLimit;
      if (mode === 'pace') entryLimit = Math.max(sharedIndex + 1, p.acked.cursor);
      else entryLimit = frontier;
      if (raceStepLimit >= 0) { entryLimit = raceStepLimit; playLimitNs = Infinity; }   // one-shot Race step: ungated
      cached.set(p, { round: r, entryLimit, playLimitNs, scale: wireScale() });
    }
    raceStepLimit = -1;
  }

  // The per-frame driver: ship prefetch, advance the round barrier, grant everyone.
  function frame() {
    sampleRates(nowMs());
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
  // is behind on the cursor — i.e. p is the FAST FS FROZEN AT THE JOIN waiting for the
  // slow peer. This is SUSTAINED, not a flicker: in Pace slow-mo the fast FS finishes
  // its step in ~90ms then sits frozen ~1.8s while the slow peer grinds; it also fires
  // during a Race↔Pace catch-up (a cursor-lead FS parked until the laggard reaches it).
  // Mode-agnostic: in STEADY Race the lead FS keeps its gate OPEN (more entries under
  // the shared ceiling), so it is never "frozen" and this stays false — matching the
  // spec note that steady Race generally won't fire.
  function holdingRaw(p) {
    if (!proxies.includes(p)) return false;
    if (gateOpen(p)) return false;                             // still has work to run — not frozen
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
  // Update the per-frame signals. Called once per frame() so csActive is a true
  // per-frame delta and the hold debounce advances on real time.
  function updateSignals(now) {
    for (const p of proxies) {
      const pb = p.acked.playbackNs;
      const advanced = pb > (prevPlayback.get(p) ?? 0) + 1e-6;   // advanced this frame?
      csActive.set(p, advanced);
      prevPlayback.set(p, pb);
      // A session that advanced this frame is ACTIVE, never frozen — so csActive and
      // holding are mutually exclusive by construction (the frame a fast FS finishes
      // its step it both moved AND becomes a hold candidate; it counts as active that
      // frame and only reads holding from the next, genuinely frozen, frame on).
      if (!advanced && holdingRaw(p)) {
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
        baseline.delete(p); cached.delete(p); shipped.delete(p); opsEma.delete(p); lastOps.delete(p);
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
     *  extra headroom to catch the leader (MAX, not min — the intended §2 catch-up).
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
    /** scale: sim-ns per real-ms (Infinity ⇒ no delay). Rides grant.scale (§2): the
     *  next frame's grant carries it, so a SPEED change lands in ≤ one frame. */
    setSpeed(next) { scale = next; atMax = !isFinite(next); lastComputedRound = -1; },
    start() { running = true; },
    /** Pause: gate the churn GENERATOR only (ADR-0020 / §4 — no stop message). Grants
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
    /** Fresh chip on every worker (RESET → new epoch, worker rebuilds — I5), sequence
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
      opsEma.clear(); lastOps.clear(); lastSampleNow = 0;
      prevPlayback.clear(); csActive.clear(); holdRawSince.clear(); holdingShown.clear();
    },
    get epoch() { return epoch; },
    /** Append one ATOMIC COMMAND at the frontier ("present"). `payload` is the wire
     *  SOURCE the worker compiles (per-command seed drawn here from the CMD stream so
     *  a random draw inside is identical call-for-call across workers). `label` is the
     *  echoed source text. Returns { index, entry }. NB (C↔V): the command is no
     *  longer a live fn — it ships as serializable source; the worker owns the tape. */
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
     *  field — see LANE-REPORT; surfaced as null until the worker reports it. */
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
     *  status dots. Each entry is `{ csActive, holding }` — csActive raw (CS pin /
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
