/*
 * Lockstep coordinator (ADR-0016): runs ONE canonical, deterministic churn
 * sequence across N participating sessions, in either of two scheduling modes:
 *
*   RACE — one shared SIMULATED-flash-time clock (raceClock) advances by the same
 *   scale the players animate at; each session runs until its own device.stats.simNs
 *   reaches that clock. Every FS therefore spends the SAME active flash time, and a
 *   cheaper-per-op FS gets MORE workload steps done inside it — active-time totals
 *   stay level, step cursors diverge. That divergence IS the comparison. (Race is
 *   clocked by sim-time, not animation/CPU: simulated flash time is our only clock.)
 *
 *   PACE — every session is fed step N, then the coordinator awaits every
 *   session's barrier() (its player finishing everything queued through step N)
 *   before anyone gets step N+1. Cursors stay equal by construction; each
 *   session's device.stats.simNs is its own total active flash time, so two
 *   FSes standing on the identical step can still be compared on real cost.
 *
 * A session stays a pure executor (ADR-0015): this module is the only thing
 * that decides what runs next, handing it to session.runChurnEvent/runGcStep.
 * The gc-vs-event coin flip uses a SEEDED PRNG, never Math.random(), so the
 * canonical sequence — and therefore the cross-session comparison — is
 * reproducible run to run.
 */
import { CHURN_EVENT } from './churn.js';

// mulberry32 — the same tiny deterministic-generator idiom session.js's
// deterministicBytes uses, sized here for one scalar draw per step rather than
// a byte fill. Seeded independently of the churn model's own LCG (churn.js) so
// the gc/op interleave and the churn content stream never correlate.
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

/**
 * @param {Object} opts
 * @param {import('./churn.js').ChurnModel} opts.churn  the ONE generator model —
 *   owned by the coordinator, not by any session (ADR-0015's split still holds:
 *   sessions never own a churn).
 * @param {number} [opts.gcRatio]  initial share of steps spent on a GC step.
 */
// Race-loop bounds (see raceTick). BACKLOG_CAP keeps a session's player from
// falling unboundedly behind the sim clock; RACE_STEP_GUARD bounds work per tick
// so a clamped-but-large dt (or a no-delay chunk) can't freeze the loop.
const BACKLOG_CAP = 3000;
const RACE_STEP_GUARD = 8000;
// At no-delay (scale = Infinity) there's no real-time budget to convert, so the
// shared race clock jumps by this fixed sim-ns chunk each tick — participants run
// flat-out yet stay pinned to the SAME advancing clock (sim-synced), instead of
// racing off by animation speed. Sized so BACKLOG_CAP ops always exceed it even
// when every op is a cheap read (~1e5 ns × 3000 ≫ this), so no session can fall
// permanently behind the clock at no-delay.
const NO_DELAY_STEP_NS = 50 * 1e6;

export function createLockstep({ churn, gcRatio = 0.5 }) {
  let sessions = [];              // participating sessions, coordinator-owned list
  const cursors = new Map();      // session -> next unconsumed index into `sequence`
  const sequence = [];            // canonical step log, generated lazily, ever-growing
  let rnd = mulberry32(GEN_SEED);
  let ratio = gcRatio;
  let mode = 'race';              // 'race' | 'pace'
  let running = false;
  let scale = 20000;              // sim-ns per real-ms — the SAME scale the players use; numeric copy for the race clock
  let atMax = false;              // no-delay flag — set by setSpeed(Infinity)
  let paceBusy = false;           // guards against overlapping paceStep() calls
  // Race is clocked by SIMULATED flash time, not animation: a shared raceClock
  // (sim-ns) advances by real-elapsed × scale, and every session runs until its
  // own device.stats.simNs catches up to it. So all participants spend the SAME
  // active flash time (simNs ≈ raceClock across FS), and a cheaper-per-op FS
  // simply completes MORE workload steps in that budget — the step cursors
  // diverge, the active-time totals stay level. (ADR-0016; corrects the earlier
  // animation-gated Race, which had it backwards — steps level, sim-time drifting.)
  let raceClock = 0;              // shared simulated-time budget (sim-ns)
  let lastTickNow = 0;            // performance.now() of the previous running tick; 0 = re-baseline needed

  // ---- canonical sequence generation — the old workloadStep() decision
  // (playground.js, pre-ADR-0016), just driven by a seeded coin instead of
  // Math.random() so it's reproducible and identical for every session. ----
  function genStep() {
    if (rnd() < ratio) return { kind: 'gc' };
    const ev = churn.next();
    if (ev.type === CHURN_EVENT.WRITE || ev.type === CHURN_EVENT.DELETE) churn.apply(ev);
    return { kind: 'event', ev };
  }
  function ensure(n) { while (sequence.length < n) sequence.push(genStep()); }

  function runEntry(session, entry) {
    try {
      if (entry.kind === 'gc') session.runGcStep();
      else session.runChurnEvent(entry.ev);
    } catch { /* logged by the session's own timed() */ }
  }
  // Issue this session's own next step and move its cursor forward one.
  function advance(session) {
    const i = cursors.get(session) ?? 0;
    ensure(i + 1);
    runEntry(session, sequence[i]);
    cursors.set(session, i + 1);
  }

  // ---- Pace: issue step N to every session that hasn't already consumed it,
  // wait for every session's player to drain, then move on. `i` is the MIN
  // cursor — normally everyone's cursor, so "every session" gets step N. Right
  // after a race→pace switch, though, a session that raced ahead already
  // executed step i for real (Race just ran it out of lockstep) — re-issuing
  // it would redo that op. So only sessions AT i get it; a session ahead of i
  // just sits in the barrier this round. Laggards close the gap one step per
  // paceStep() call — cheap and bounded, unlike replaying the whole gap at
  // once — until every cursor reads i again and lockstep resumes for real. ----
  async function paceStep() {
    if (!sessions.length) return;
    const i = Math.min(...sessions.map((s) => cursors.get(s) ?? 0));
    ensure(i + 1);
    const due = sessions.filter((s) => (cursors.get(s) ?? 0) === i);
    for (const s of due) runEntry(s, sequence[i]);
    await Promise.all(sessions.map((s) => s.barrier()));
    for (const s of due) cursors.set(s, i + 1);
  }

  // ---- Race: advance one shared SIMULATED-time clock, then run every session
  // up to it. raceClock climbs by (real ms since last tick) × scale — the same
  // scale the players animate at, so at any finite speed the clock tracks wall
  // time exactly as the die does. Each session then executes steps while its own
  // simNs (which updates synchronously as ops run, ADR-0009) is below the clock,
  // so every FS ends the tick with simNs ≈ raceClock (equal active time, within
  // one op) while a cheaper FS got MORE steps done to reach it. Guards: at most
  // RACE_STEP_GUARD advances per tick, and stop if the player backlog hits
  // BACKLOG_CAP (animation mustn't fall unboundedly behind — it catches the clock
  // next tick once it drains). ----
  function raceTick(now) {
    if (!lastTickNow) { lastTickNow = now; return; }   // first tick after (re)start: just baseline, no jump
    let dt = now - lastTickNow; lastTickNow = now;
    if (dt > 100) dt = 100;                             // clamp a stall (same ceiling viz uses) so the clock can't balloon
    raceClock += atMax ? NO_DELAY_STEP_NS : dt * scale;
    for (const s of sessions) {
      let guard = RACE_STEP_GUARD;
      while (s.device.stats.simNs < raceClock && guard-- > 0 && s.pending() < BACKLOG_CAP) advance(s);
    }
  }

  setInterval(() => {
    if (!running) { lastTickNow = 0; return; }          // paused: drop the baseline so resume doesn't jump the clock
    if (mode === 'race') raceTick(performance.now());
    else if (!paceBusy) { paceBusy = true; paceStep().finally(() => { paceBusy = false; }); }
  }, 16);

  return {
    /** Replace the participating set. Cursors for any brand-new session start at
     *  0 — callers reset() right after adding/removing a participant (ADR-0016)
     *  so "start at 0" always means a genuinely fresh chip, never a mid-run join.
     *  Drop cursor entries for departed sessions too, so a removed (torn-down)
     *  session object isn't kept alive as a live Map key. */
    setSessions(list) {
      const next = new Set(list);
      for (const s of cursors.keys()) if (!next.has(s)) cursors.delete(s);
      sessions = list.slice();
      for (const s of sessions) if (!cursors.has(s)) cursors.set(s, 0);
    },
    setGcRatio(v) { ratio = v; },
    /** m: 'race' | 'pace'. No reconciliation needed on switch — paceStep()'s
     *  "only sessions at the min cursor are due" already handles a set of
     *  cursors left diverged by a prior Race phase, catching laggards up one
     *  step per call instead of needing a synchronous replay here. */
    setMode(m) { mode = m; },
    get mode() { return mode; },
    /** scale: sim-ns per real-ms (Infinity ⇒ no delay), fanned to every session.
     *  Kept as a numeric field too — the Race clock advances by this same scale,
     *  so the sim-time budget and the die animation share one rate. */
    setSpeed(next) { scale = next; atMax = !isFinite(next); for (const s of sessions) s.setScale(next); },
    start() { running = true; },
    stop() { running = false; },
    get running() { return running; },
    /** Manual single nudge: every session gets its own next step in Race
     *  (ignoring the pending() gate — same as the old single-FS Step button);
     *  one shared canonical step, barrier-awaited, in Pace. The Pace path shares
     *  the SAME paceBusy gate the 16ms interval uses — otherwise a manual Step
     *  (double-click, or Step while running) could overlap an in-flight
     *  paceStep(): both read the same not-yet-advanced min cursor and re-issue
     *  sequence[i] to the due sessions, duplicating a device write on every FS
     *  and silently breaking Pace's byte-comparability. Skipping the manual step
     *  while one is in flight is fine — the interval (or the next click) carries on. */
    async step() {
      if (mode === 'pace') {
        if (paceBusy) return;
        paceBusy = true;
        try { await paceStep(); } finally { paceBusy = false; }
        return;
      }
      for (const s of sessions) advance(s);
      // Keep the shared clock at/above every session's simNs so a subsequent Run
      // doesn't have to wait for raceClock to climb back up to what the manual
      // step already spent.
      for (const s of sessions) raceClock = Math.max(raceClock, s.device.stats.simNs);
    },
    /** Fresh, empty chip on every participant, generator restarted from its seed,
     *  sequence and cursors cleared. Called whenever the participant set changes
     *  (ADR-0015's "no carryover" rule extended to N sessions). Also zeroes the
     *  shared Race clock so a fresh set starts from an empty sim-time budget. */
    reset() {
      for (const s of sessions) s.freshFormat();
      churn.reset();
      sequence.length = 0;
      rnd = mulberry32(GEN_SEED);
      for (const s of sessions) cursors.set(s, 0);
      raceClock = 0;
      lastTickNow = 0;
    },
    /** Per-session comparison readout for the UI's compare strip. Garbage% comes
     *  from session.livenessCounts() (ADR-0015 accessor) — cached behind that
     *  session's own mapDirty gate and pure (no viz mutation), so this readout
     *  neither re-walks the live map itself nor mutates the die from a getter. */
    snapshots() {
      return sessions.map((s) => {
        const info = s.runner.fsinfo();
        const stats = s.device.stats;
        const wa = s.fs.hostBytes ? stats.programBytes / s.fs.hostBytes : 1;
        const c = s.livenessCounts();
        const programmed = c.live + c.obsolete + c.metadata;
        const garbagePct = programmed ? c.obsolete / programmed : 0;
        return { fsId: s.fsId, name: s.name, stepCursor: cursors.get(s) ?? 0, simNs: stats.simNs, wa, files: info.files, garbagePct };
      });
    },
  };
}
