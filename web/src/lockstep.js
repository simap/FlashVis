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
 * worker compiles against. holding/stalled/waiting are derived purely from ack state.
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

// Race stall/standing threshold: an idle, ceiling-gated FS reads as WAITING ON THE
// OTHERS only when its playback sits more than this above the field minimum — the FS
// at the min never flags, and an FS merely metered to one chunk between ops stays
// under it. (playbackNs replaces the old simNs here; the ceiling replaces raceClock.)
const STALL_GAP_NS = 50 * 1e6;

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
  function holdingNow(p) {
    if (!proxies.includes(p)) return false;
    if (gateOpen(p)) return false;                             // still working — never the one others wait for
    if (mode === 'race') {
      const hasWork = p.acked.cursor < sequence.length || running;
      if (!hasWork) return false;
      const minPb = Math.min(...proxies.map((q) => q.acked.playbackNs));
      return (p.acked.playbackNs - minPb) > STALL_GAP_NS;      // metered at the ceiling, far above the field min
    }
    // Pace: p finished the shared step (or leads the min cursor) while a peer has not.
    const c = p.acked.cursor;
    let peerWorking = false, leads = false;
    for (const q of proxies) {
      if (q === p) continue;
      if (q.acked.entriesDrained < sharedIndex) peerWorking = true;   // peer hasn't finished the shared step
      if (q.acked.cursor < c) { peerWorking = true; leads = true; }
    }
    const doneStep = p.acked.entriesDrained >= sharedIndex;
    return peerWorking && (leads || doneStep);
  }

  return {
    /** Replace the participating set (session PROXIES). New proxies are init()'d and
     *  start at baseline 0; departed proxies' per-session state is dropped. Callers
     *  reset() right after (ADR-0016) so "start at 0" always means a fresh chip. */
    setSessions(list) {
      const next = new Set(list);
      for (const p of [...baseline.keys()]) if (!next.has(p)) {
        baseline.delete(p); cached.delete(p); shipped.delete(p); opsEma.delete(p); lastOps.delete(p);
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
        const hn = holdingNow(p);
        return {
          fsId: p.fsId, name: p.name,
          stepCursor: p.acked.cursor,
          fileOpCount: p.acked.fileOpCount,
          simNs: t.simNs,
          wa: t.wa ?? null,
          files: t.fsinfo.files,
          garbagePct,
          opsPerSec: Math.max(0, opsEma.get(p) ?? 0),
          holding: mode === 'pace' && hn,
          stalled: mode === 'race' && hn,
          waiting: hn,
        };
      });
    },
    /** Cheap per-fsId holding map (the unified signal, no telemetry walk) for the
     *  per-frame FS-card pins / status dots. */
    waitStates() {
      const out = {};
      for (const p of proxies) out[p.fsId] = holdingNow(p);
      return out;
    },
    /** Test seam: drive one frame manually (autoTick:false). */
    _tick() { frame(); },
  };
}
