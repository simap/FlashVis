/*
 * Lockstep coordinator (ADR-0016, broadcast granularity per ADR-0019): runs ONE
 * canonical, deterministic sequence across N participating sessions, in either
 * of two scheduling modes:
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
 * that decides what runs next, handing it to session.runChurnEvent/runGcStep/
 * runCommand. The gc-vs-event coin flip uses a SEEDED PRNG, never Math.random(),
 * so the canonical sequence — and therefore the cross-session comparison — is
 * reproducible run to run.
 *
 * Sequence entries come in three kinds:
 *   { kind:'gc' }                          — one opportunistic GC step
 *   { kind:'event', ev }                   — one churn write/delete (the auto-workload)
 *   { kind:'command', fn, label, seed }    — one ATOMIC command (ADR-0019)
 * A command is ADR-0019's broadcast unit made concrete: a whole console input, a
 * button command — `fn` is `async (api) => any`, run per-session against a LOCAL
 * inner API (session.js's buildLocalApi) so every read/write/ls/... it issues is
 * real, animated, and costs simulated time on THAT filesystem, returning THAT
 * filesystem's real data. broadcast() appends one command at the frontier
 * ("present"); every session replays it — atomically, never interleaved with the
 * next command — when its cursor reaches it. Focus is a pure view concern the
 * manager owns; nothing here knows or cares which FS is on screen.
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
// Per-command seeds are drawn from their OWN stream (CMD_SEED), never from the
// churn generator's PRNG — broadcasting a command must not shift the auto-
// workload's gc/op interleave, or the canonical churn sequence would stop being
// reproducible the moment a user hand-issued one (ADR-0016/0019).
const CMD_SEED = 0x900d5eed;

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

// snapshots().opsPerSec (ADR-0020): WORKLOAD ops/sec (sequence steps consumed),
// smoothed with a ~2s time constant. Workload ops arrive coarsely (one whole
// step at a time, so the raw per-tick rate is spiky: 0 on most ticks, a burst on
// the tick a step lands). A longer tau averages those into a steady bar instead
// of a twitchy one, while still decaying visibly to 0 once the dies go idle.
const OPS_EMA_TAU_MS = 2000;

// Race-stall (snapshots().stalled): a race FS whose simNs sits more than this
// above the running frontier (the min simNs the shared clock is serving) is
// waiting for raceClock to climb to it, not just overshooting the clock by one
// op. 50ms of flash time is far above any single-step overshoot and far below a
// real Pace→Race divergence.
const STALL_GAP_NS = 50 * 1e6;

// ---- Pace's op-level rendezvous: a DYNAMIC-MEMBERSHIP phased barrier (ADR-0019) ----
// Phase k releases when every session STILL ACTIVE in this command has arrived at
// its k-th awaited op — not when arrivals match a fixed snapshot. A session that
// reaches quiescence calls leave(), dropping out of the active set; that departure
// re-evaluates the pending phase, releasing anyone still waiting on it. This is what
// lets a state-dependent script that runs a different op count per filesystem avoid
// deadlock — a naive fixed-membership barrier would hang forever on the session
// that's already done. For a fixed-count script every participant runs the same
// op count and this degrades to a trivial 1:1 rendezvous each phase.
function createPhaser(participants) {
  let active = new Set(participants);
  let arrivals = new Set();
  let waiters = [];   // resolve fns parked on the CURRENT phase
  function tryRelease() {
    for (const s of active) if (!arrivals.has(s)) return;   // not everyone still active has arrived
    const w = waiters; waiters = [];
    arrivals = new Set();
    for (const fn of w) fn();
  }
  return {
    arrive(session) {
      return new Promise((resolve) => {
        arrivals.add(session);
        waiters.push(resolve);
        tryRelease();
      });
    },
    leave(session) {
      active.delete(session);
      arrivals.delete(session);
      tryRelease();       // a departure can itself satisfy a pending phase
    },
  };
}

export function createLockstep({ churn, gcRatio = 0.5 }) {
  let sessions = [];              // participating sessions, coordinator-owned list
  const cursors = new Map();      // session -> next unconsumed index into `sequence`
  const sequence = [];            // canonical step log, generated lazily, ever-growing
  let rnd = mulberry32(GEN_SEED);
  let cmdRng = mulberry32(CMD_SEED);     // separate stream for per-command seeds (see CMD_SEED)
  let ratio = gcRatio;
  let mode = 'pace';               // 'race' | 'pace' — Pace is the default (ADR-0017/0018 boot in Pace)
  let running = false;
  let scale = 20000;                // sim-ns per real-ms — the SAME scale the players use; numeric copy for the race clock
  let atMax = false;                // no-delay flag — set by setSpeed(Infinity)
  let paceBusy = false;             // guards against overlapping paceStep() calls
  // Race is clocked by SIMULATED flash time, not animation: a shared raceClock
  // (sim-ns) advances by real-elapsed × scale, and every session runs until its
  // own device.stats.simNs catches up to it. So all participants spend the SAME
  // active flash time (simNs ≈ raceClock across FS), and a cheaper-per-op driver
  // simply completes MORE workload steps in that budget — the step cursors
  // diverge, the active-time totals stay level. (ADR-0016.)
  let raceClock = 0;                // shared simulated-time budget (sim-ns)
  let lastTickNow = 0;              // performance.now() of the previous running tick; 0 = re-baseline needed
  const busy = new Map();           // session -> true while a Race command is in flight for it
  let raceWaiters = [];             // [{ session, resolve }] parked on the shared clock/backlog gate
  // ---- snapshot readouts (ADR-0020) ----
  const opsEma = new Map();         // session -> EMA-smoothed completed-ops/sec (opsPerSec)
  const lastOps = new Map();        // session -> ops count at the previous rate sample
  let lastSampleNow = 0;            // performance.now() of the previous rate sample; 0 = re-baseline
  // Pace "holding": due sessions that have finished the LIVE command's ops and
  // are parked in the phaser waiting on a slower peer (the cursor-lead case — a
  // session ahead of the shared min after a Race→Pace switch — is derived from
  // cursors directly in snapshots(), so it needs no bookkeeping here).
  let paceArrived = new Set();
  // Pace "waiting" (the instantaneous per-frame signal, snapshots().waiting /
  // waitStates()): sessions that have RESOLVED their own barrier()/phaser for the
  // current Pace round while a peer has not, i.e. parked waiting on the slower FS.
  // Populated by a per-session barrier .then and each command's completion (see
  // paceStep), cleared when the round advances. A session still executing or
  // draining its op's animation has an UNRESOLVED barrier and is NOT in here, so
  // "still animating" never reads as waiting (the naive "simNs didn't move" bug).
  let paceWaiting = new Set();

  // ---- Stop/abort (ADR-0019 Consequences): every command execution captures the
  // token active when it STARTS. stop() flips it aborted and resolves its promise
  // (unblocking any coordinator-level Promise.race that abandoned an in-flight
  // round) and installs a fresh one for the next run. Individual op pacing
  // (guarded(), below) uses the SAME token to make every outstanding/subsequent
  // inner-API await hang — never settle, never reject — so a runaway
  // `while(true){ try{await x}catch{} }` parks at its first post-Stop await
  // instead of spinning. ----
  function makeStopToken() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { aborted: false, promise, resolve };
  }
  let stopToken = makeStopToken();
  // Wrap a pacing promise so it never resolves/rejects once `tok` is aborted —
  // checked both at issue time (already aborted) and at the real promise's own
  // settle time (aborted while waiting), since a resolver the tick loop stops
  // driving (Race's gate) or one an independent rAF loop still drives on its own
  // (Pace's viz.barrier()) must BOTH end up hanging once stopped.
  function guarded(tok, factory) {
    if (tok.aborted) return new Promise(() => {});
    return new Promise((resolve, reject) => {
      factory().then(
        (v) => { if (!tok.aborted) resolve(v); },
        (e) => { if (!tok.aborted) reject(e); },
      );
    });
  }

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

  // ---- opsPerSec sampling (ADR-0020): EMA of WORKLOAD ops/sec per FS —
  // "ops" here is the paced/raced unit: sequence steps consumed (each a churn
  // event, a GC step, or an issued command), i.e. stepCursor. NOT flash ops
  // (reads+programs+erases): a chatty FS doing thousands of tiny reads would
  // post a huge flash-ops/sec while getting *less* real work done, the wrong
  // signal for a throughput/efficiency comparison. Flash ops are the cost view
  // (the die + Flash Stats), never the "ops" the compare modes measure.
  // Resampled every coordinator tick (~16ms) so the rate is stable and decays
  // to 0 when the dies fall idle. ----
  const opsOf = (s) => cursors.get(s) ?? 0;
  function sampleRates(now) {
    if (!lastSampleNow) { lastSampleNow = now; for (const s of sessions) lastOps.set(s, opsOf(s)); return; }
    const dt = now - lastSampleNow;
    if (dt <= 0) return;
    lastSampleNow = now;
    const alpha = 1 - Math.exp(-dt / OPS_EMA_TAU_MS);
    for (const s of sessions) {
      const cur = opsOf(s);
      const inst = Math.max(0, cur - (lastOps.get(s) ?? cur)) / (dt / 1000);   // ops/sec this interval
      lastOps.set(s, cur);
      const ema = opsEma.get(s) ?? 0;
      opsEma.set(s, ema + alpha * (inst - ema));
    }
  }

  // Churn/GC entries are simple, synchronous, single-op steps — they don't need
  // the async command machinery below (ADR-0019's Alternatives-considered).
  function runEntry(session, entry) {
    try {
      if (entry.kind === 'gc') session.runGcStep();
      else session.runChurnEvent(entry.ev);
    } catch { /* logged by the session's own timed() */ }
  }
  function advanceSync(s) {
    const i = cursors.get(s) ?? 0;
    ensure(i + 1);
    runEntry(s, sequence[i]);
    cursors.set(s, i + 1);
  }

  // Run a COMMAND entry on one session: flips its per-session tape line
  // queued→live (fn starts) →done (quiescence) — ADR-0018's tape lifecycle
  // falling directly out of the execution seam — then awaits quiescence
  // (session.runCommand never rejects; see session.js).
  async function runCommandOnSession(session, entry, pace) {
    const je = entry.journalEntries?.get(session);
    if (je) session.setJournalState(je, 'live');
    await session.runCommand(entry.fn, entry.seed, pace);
    if (je) session.setJournalState(je, 'done');
  }

  // ---- Race pacing: gate each awaited inner op on the SHARED sim-time clock +
  // this session's own animation backlog (ADR-0019) — no cross-session
  // rendezvous, so a slow filesystem never blocks a fast one. `raceGateOpen`
  // mirrors the old raceTick while-condition, just evaluated per op instead of
  // per synchronous loop iteration; a closed gate parks in `raceWaiters` and is
  // re-checked every coordinator tick (raceTick, below). ----
  function raceGateOpen(s) { return s.device.stats.simNs < raceClock && s.pending() < BACKLOG_CAP; }
  function raceGate(session) {
    // Once we've left Race, the shared clock stops advancing — so a Race command
    // still draining across a mode switch must NOT re-park here or it would hang
    // forever (its clock is gone). Treat the gate as open when mode !== 'race';
    // setMode also frees any already-parked waiter. Its remaining ops then finish
    // ungated (one in-flight command's tail runs fast during the transition —
    // bounded, and far better than a wedged, half-executed command).
    if (mode !== 'race' || raceGateOpen(session)) return Promise.resolve();
    return new Promise((resolve) => raceWaiters.push({ session, resolve }));
  }
  function releaseRaceWaiters() {
    if (!raceWaiters.length) return;
    const still = [];
    for (const w of raceWaiters) (raceGateOpen(w.session) ? w.resolve() : still.push(w));
    raceWaiters = still;
  }
  function racePace(session, tok) {
    return {
      before: () => guarded(tok, () => raceGate(session)),
      // No drain wait in Race — only the backlog CAP (already in the gate)
      // bounds animation lag; drain-to-zero would frame-quantize sub-frame
      // commands and break "equal active time" for cheap/read-heavy workloads
      // (ADR-0019 Consequences).
      after: () => guarded(tok, () => Promise.resolve()),
    };
  }

  // ---- Pace pacing: op-level phaser (cross-session join) + this session's own
  // drain (viz.barrier()) — "drain and join" (ADR-0019). No before-gate: Pace
  // doesn't bound entry into an op, only synchronizes exit from one. ----
  function pacePace(session, phaser, tok) {
    return {
      before: () => guarded(tok, () => Promise.resolve()),
      after: () => guarded(tok, () => Promise.all([session.barrier(), phaser.arrive(session)])),
    };
  }

  // ---- Race: advance one shared SIMULATED-time clock, then run every session up
  // to it. Non-command entries (gc/event) still run in the old tight synchronous
  // while-loop (same guard/backlog-cap bounds, same numeric behavior — this is
  // what keeps the closed-loop "equal active time" property intact for the
  // auto-workload). A COMMAND entry can't be stepped synchronously — its ops pace
  // one at a time, possibly over many ticks — so hitting one kicks off a detached
  // per-session async runner (`busy` marks the session so this loop skips it
  // until the command quiesces) rather than blocking the other sessions' loops
  // in this same tick. ----
  function raceTick(now) {
    // Consumer runs EVERY tick (ADR-0020) — a command enqueued while paused still
    // drains. But the SHARED clock must advance only on ticks that have work: were
    // it to free-run while idle (paused with nothing queued and no command in
    // flight), the next command after an idle stretch would find simNs far below
    // raceClock, the gate wide open, and burst flat-out instead of pacing at Speed.
    // So while idle we re-baseline (drop lastTickNow, the same mechanism the pause
    // path used) and leave raceClock put; when work arrives raceClock ≈ simNs and
    // it paces op-by-op. `running` counts as work: the producer will generate churn.
    const hasWork = (running && sessions.length > 0)      // FIX 5: no sessions ⇒ nothing consumes the clock, don't free-run it
      || raceWaiters.length > 0
      || sessions.some((s) => busy.get(s) || (cursors.get(s) ?? 0) < sequence.length);
    if (!hasWork) {
      // Idle: re-baseline AND re-seat the clock down to the lowest participant
      // simNs (FIX 3). Dropping lastTickNow alone froze raceClock wherever the
      // last working tick's `+= dt·scale` left it — up to one tick ABOVE simNs,
      // since sessions drain to the frontier without spending that budget. Frozen
      // there, the next command's first raceGate sees simNs < raceClock, the gate
      // open, and bursts ops until simNs catches the stale clock. Clamping to
      // min(simNs) leaves NO session's gate open (every simNs ≥ raceClock), so the
      // post-idle command paces from its first op — the guarantee ADR-0020 makes.
      lastTickNow = 0;
      if (sessions.length) raceClock = Math.min(...sessions.map((s) => s.device.stats.simNs));
      return;
    }
    if (!lastTickNow) { lastTickNow = now; return; }      // first working tick: just baseline, no jump
    let dt = now - lastTickNow; lastTickNow = now;
    if (dt > 100) dt = 100;                              // clamp a stall (same ceiling viz uses) so the clock can't balloon
    raceClock += atMax ? NO_DELAY_STEP_NS : dt * scale;
    for (const s of sessions) {
      if (busy.get(s)) continue;                         // a command is already running for this session
      let guard = RACE_STEP_GUARD;
      while (guard-- > 0) {
        const i = cursors.get(s) ?? 0;
        if (i >= sequence.length) {                      // at the frontier: only the running/step producer extends it
          if (!running) break;                           // paused: don't manufacture new auto-workload (ADR-0020)
          ensure(i + 1);
        }
        const entry = sequence[i];
        if (entry.kind === 'command') {
          busy.set(s, true);
          // Clear the busy lock on EVERY exit (FIX A): fulfil advances the cursor;
          // reject (e.g. a throwing journal subscriber in runCommandOnSession)
          // clears the lock and leaves the cursor at i (rewind, mirroring the
          // abort model) so the FS stays recoverable instead of frozen. Guard
          // against a late settle for a session setSessions() already removed —
          // don't resurrect its cursor/busy Map entries (minor leak fix).
          const settle = (advance) => {
            if (!sessions.includes(s)) { busy.delete(s); return; }
            if (advance) cursors.set(s, i + 1);
            busy.set(s, false);
          };
          runCommandOnSession(s, entry, racePace(s, stopToken)).then(() => settle(true), () => settle(false));
          break;                                         // this session's turn resumes once it quiesces
        }
        if (!raceGateOpen(s)) break;
        advanceSync(s);
      }
    }
    releaseRaceWaiters();
  }

  // ---- Pace: issue step N to every session that hasn't already consumed it,
  // wait for it to fully resolve on every session, then move on. `i` is the MIN
  // cursor — normally everyone's cursor, so "every session" gets step N. Right
  // after a race→pace switch, though, a session that raced ahead already
  // executed step i for real — re-issuing it would redo that op. So only
  // sessions AT i get it; a session ahead of i just sits in this round's final
  // barrier with nothing new queued, and simply doesn't advance until the
  // laggards reach it. A COMMAND entry gets its own phaser (scoped to exactly
  // `due` — the active set that starts together) so its ops stay visually
  // locked op-by-op across every session running it; a non-command entry keeps
  // the old direct dispatch. Either way, stop() can abandon a stuck round via
  // `tok.promise` without the coordinator hanging forever on a hung command. ----
  // `produce` gates generation of the next auto-workload step at the frontier
  // (ADR-0020): the 16ms tick passes `running` (paused ⇒ don't manufacture churn,
  // only drain what's already queued), step() passes true (one forced nudge).
  // Draining an already-present entry — a queued command, or churn generated
  // earlier while running — never keys off it.
  async function paceStep(produce = running) {
    if (!sessions.length) return;
    const i = Math.min(...sessions.map((s) => cursors.get(s) ?? 0));
    if (i >= sequence.length) {                         // at the frontier: only produce when allowed
      if (!produce) return;                             // paused, queue drained: idle, nothing to consume
      ensure(i + 1);
    }
    const entry = sequence[i];
    // `due` = sessions AT the shared index whose entry no OTHER driver is already
    // executing. `busy` is the universal re-entry lock (FIX 1): raceTick sets it
    // for a Race command it kicks off; excluding those sessions here stops a
    // Race→Pace switch from re-running sequence[i] on a session mid-command. We
    // then claim `busy` on our OWN due set for the WHOLE round (command ops and
    // the non-command barrier await alike), so a Pace→Race switch mid-round makes
    // raceTick skip exactly these sessions until we advance them — no path ever
    // executes sequence[i] for a session whose cursor is still i more than once.
    const due = sessions.filter((s) => (cursors.get(s) ?? 0) === i && !busy.get(s));
    if (!due.length) return;                            // every min-cursor session is mid-execution elsewhere — retry next tick
    for (const s of due) busy.set(s, true);
    const releaseBusy = () => { for (const s of due) busy.set(s, false); };
    const tok = stopToken;
    if (entry.kind === 'command') {
      paceArrived = new Set();
      paceWaiting = new Set();
      const phaser = createPhaser(due);
      // A due session marks itself "holding" the moment its own ops quiesce (it
      // has left the phaser) — so if a slower peer is still issuing ops, this one
      // reads as parked-waiting until the whole round's barrier releases below.
      // On a per-session REJECT (a throwing journal subscriber, say) still LEAVE
      // the phase so peers don't hang on the dead session, then re-throw so `run`
      // rejects and the catch below clears the lock.
      const run = Promise.all(due.map((s) =>
        runCommandOnSession(s, entry, pacePace(s, phaser, tok)).then(
          () => { phaser.leave(s); paceArrived.add(s); paceWaiting.add(s); },
          (e) => { phaser.leave(s); throw e; })));
      try {
        await Promise.race([run, tok.promise]);
      } catch {
        // REJECT exit (FIX A): guarantee busy clears even when the throw skips the
        // abort/advance branches below. Rewind (cursor stays at i), mirroring the
        // command-abort model — the FS is recoverable, not frozen.
        releaseBusy(); paceArrived = new Set(); paceWaiting = new Set(); return;
      }
      if (tok.aborted) { releaseBusy(); paceArrived = new Set(); paceWaiting = new Set(); return; }   // abandoned mid-flight — cursors stay at i, lock released
    } else {
      for (const s of due) runEntry(s, entry);
    }
    // Instrument the round's drain barrier for the `waiting` signal: a session
    // that resolves its OWN barrier() while a peer has not is parked waiting on the
    // slower peer (paceWaiting). A session still draining its op animation has an
    // UNRESOLVED barrier -> not added -> not "waiting". `roundDone`/`tok.aborted`
    // guard a late resolve after the round advanced or aborted from re-flagging.
    let roundDone = false;
    const barriers = sessions.map((s) =>
      s.barrier().then(() => { if (!roundDone && !tok.aborted) paceWaiting.add(s); }));
    await Promise.race([Promise.all(barriers), tok.promise]);
    roundDone = true;
    paceArrived = new Set();
    paceWaiting = new Set();
    if (tok.aborted) {
      // FIX B: a NON-command entry's runEntry already applied its device op
      // synchronously above — the write/delete genuinely happened, so a Pause
      // (stop) landing in this barrier-drain window must ADVANCE the cursor to
      // match, or resume re-applies the same churn op (double simNs/wear/WA,
      // divergence from the canonical sequence). A COMMAND aborted here keeps the
      // ADR-0019 rewind (cursor stays at i) — its abort semantics are untouched.
      if (entry.kind !== 'command') for (const s of due) cursors.set(s, i + 1);
      releaseBusy();
      return;
    }
    for (const s of due) { cursors.set(s, i + 1); busy.set(s, false); }
  }

  // The consumer runs UNCONDITIONALLY (ADR-0020): Run/Pause/Step gate stimulus
  // GENERATION (the producer, inside raceTick/paceStep), never execution. So a
  // command enqueued while paused drains at Speed as soon as it reaches the front
  // of the queue — right away when the auto-workload isn't producing behind it.
  // raceTick self-manages the shared-clock baseline (idle re-baseline), so there's
  // no `!running` skip here anymore.
  setInterval(() => {
    const now = performance.now();
    if (mode === 'race') raceTick(now);
    else if (!paceBusy) { paceBusy = true; paceStep().finally(() => { paceBusy = false; }); }
    sampleRates(now);
  }, 16);

  // ---- `waiting`: the instantaneous "this FS sim is paused" signal (per-frame
  // counterpart to the coarse holding/stalled card readouts). True ONLY when a
  // session WANTS to dispatch its next sequence step but a cross-FS / clock gate
  // won't let it. Evaluated FRESH from current gate state (no tick-delayed
  // sample), so a per-rAF poll sees a pause the instant it begins and clears.
  // FALSE while executing OR animating an op, FALSE when idle at the frontier,
  // FALSE when stopped with nothing to run. Backs both snapshots().waiting and the
  // cheap waitStates(). ----
  function isWaiting(s) {
    if (mode === 'race') {
      // Race: it has a next op to run AND its simNs has caught the shared raceClock,
      // so the op can't dispatch until the clock advances. `simNs >= raceClock` is
      // the CLOCK reason (paused). The pure animation-backlog reason (`simNs <
      // raceClock` but `pending() >= BACKLOG_CAP`, i.e. animation catching up) is
      // still-active and is excluded automatically by requiring simNs >= raceClock.
      // hasWork: a queued step, or `running` (the producer will extend the frontier)
      // — false at an idle frontier and when stopped with nothing queued.
      const hasWork = (cursors.get(s) ?? 0) < sequence.length || running;
      return hasWork && s.device.stats.simNs >= raceClock;
    }
    // Pace: this session resolved its own barrier()/phaser for the round while a
    // peer has not (paceWaiting). A session still executing or draining its op's
    // animation has an unresolved barrier and is NOT in the set -> not waiting. The
    // size guard drops the flag the instant everyone has arrived (round advancing).
    return paceWaiting.has(s) && paceWaiting.size < sessions.length;
  }

  return {
    /** Replace the participating set. Cursors for any brand-new session start at
     *  0 — callers reset() right after adding/removing a participant (ADR-0016)
     *  so "start at 0" always means a genuinely fresh chip, never a mid-run join.
     *  Drop cursor/busy entries and stale race-gate waiters for departed sessions
     *  too, so a removed (torn-down) session object isn't kept alive as a live
     *  Map key or a permanently-unresolved waiter. */
    setSessions(list) {
      const next = new Set(list);
      for (const s of cursors.keys()) if (!next.has(s)) { cursors.delete(s); busy.delete(s); opsEma.delete(s); lastOps.delete(s); }
      raceWaiters = raceWaiters.filter((w) => next.has(w.session));
      paceArrived = new Set([...paceArrived].filter((s) => next.has(s)));
      paceWaiting = new Set([...paceWaiting].filter((s) => next.has(s)));
      sessions = list.slice();
      for (const s of sessions) if (!cursors.has(s)) cursors.set(s, 0);
    },
    setGcRatio(v) { ratio = v; },
    /** m: 'race' | 'pace'. Reconcile the transition so no op is redone and the
     *  shared clock never bursts (ADR-0020). The no-double-execute guarantee is
     *  carried by the universal `busy` lock, NOT by this method: an entry a
     *  paceStep round or a raceTick command is mid-executing keeps its session
     *  `busy`, so whichever driver the flipped mode selects skips that session
     *  until its cursor advances — the in-flight round finishes exactly once under
     *  the pacing it started with, never re-run concurrently. This method only
     *  handles the shared clock.
     *
     *  Race→Pace: re-seat nothing (Pace uses no clock), but FREE any op parked on
     *  the race gate — Pace won't advance raceClock, so a parked-mid-op Race
     *  command draining across the switch would hang; raceGate() also treats the
     *  gate as open while mode !== 'race' so its later ops don't re-park. Cursor
     *  divergence Race left behind is caught up incrementally by paceStep()'s
     *  min-cursor `due` filter, redoing nothing.
     *
     *  Pace→Race is the defect the clock re-seat fixes. In Pace the shared
     *  raceClock is frozen — left at 0 on a first-ever switch, or stale-high from
     *  an earlier Race burst — while each session's simNs diverges freely. A
     *  stale-HIGH clock sits far above every simNs, opens the gate wide, and the
     *  next tick bursts sessions flat-out (a clock burst); a LOW/zero clock jams
     *  the gate shut and stalls until raceClock climbs back at Speed. Re-seat
     *  raceClock at the LOWEST participant simNs: no session's gate is open (every
     *  simNs ≥ raceClock), so nothing bursts. This does NOT avoid a stall — the
     *  above-min (faster-spent) sessions correctly wait as the clock climbs and
     *  overtakes each simNs in turn; that wait is Race convergence, not a defect.
     *  Drop lastTickNow too, so the first race tick only re-baselines instead of
     *  jumping by the whole switch gap. */
    setMode(m) {
      if (m === mode) return;
      if (m === 'race') {
        raceClock = sessions.length ? Math.min(...sessions.map((s) => s.device.stats.simNs)) : 0;
        lastTickNow = 0;
      } else {
        for (const w of raceWaiters) w.resolve();       // let any parked Race command drain out — its clock is gone
        raceWaiters = [];
      }
      mode = m;
    },
    get mode() { return mode; },
    /** scale: sim-ns per real-ms (Infinity ⇒ no delay), fanned to every session.
     *  Kept as a numeric field too — the Race clock advances by this same scale,
     *  so the sim-time budget and the die animation share one rate. */
    setSpeed(next) { scale = next; atMax = !isFinite(next); for (const s of sessions) s.setScale(next); },
    start() { running = true; },
    /** Pause the auto-tick AND abandon any in-flight command (ADR-0019): flips
     *  the current stop token so every outstanding/subsequent inner-API await it
     *  guards HANGS (never settles, never rejects — a rejecting abort would be
     *  swallowed by a `try/catch` retry loop), resolves the token's promise so a
     *  coordinator-level `Promise.race` waiting on a stuck paceStep()/raceTick
     *  round can abandon it instead of hanging the coordinator itself, then
     *  re-baselines: a fresh token for the next run, Race `busy` flags cleared
     *  (their sessions' cursors never advanced past the abandoned command, so
     *  resuming just re-issues it fresh), and any parked race-gate waiters
     *  dropped. What stays unrecoverable is a command that never yields to the
     *  macrotask queue at all (a synchronous `while(true)`, or a microtask-only
     *  spin) — same as it starves anything else on the one JS thread. */
    stop() {
      running = false;
      stopToken.aborted = true;
      stopToken.resolve();
      stopToken = makeStopToken();
      busy.clear();
      raceWaiters = [];
      paceWaiting = new Set();
    },
    get running() { return running; },
    /** Manual single nudge: every session gets its own next step in Race
     *  (ignoring the pending()/clock gate — same as the old single-FS Step
     *  button — and running a command entry to full quiescence unpaced, since
     *  there's no meaningful "half a command" to show); one shared canonical
     *  step, phaser+barrier-awaited, in Pace. The Pace path shares the SAME
     *  paceBusy gate the 16ms interval uses — otherwise a manual Step (double-
     *  click, or Step while running) could overlap an in-flight paceStep():
     *  both read the same not-yet-advanced min cursor and re-issue sequence[i]
     *  to the due sessions, duplicating a device write on every FS and silently
     *  breaking Pace's byte-comparability. Skipping the manual step while one is
     *  in flight is fine — the interval (or the next click) carries on. */
    async step() {
      if (mode === 'pace') {
        if (paceBusy) return;
        paceBusy = true;
        try { await paceStep(true); } finally { paceBusy = false; }   // force one produced step even while paused (ADR-0020)
        return;
      }
      await Promise.all(sessions.map(async (s) => {
        // FIX 2: the 16ms raceTick now drains queued commands EVERY tick (even
        // paused), so a manual Step must not also grab a session raceTick is
        // already executing. `busy` is the shared re-entry lock — skip a session
        // another driver holds, else claim it (synchronously, before the first
        // await) so a concurrent raceTick skips it. Either driver runs sequence[i]
        // exactly once; the other no-ops for that session.
        if (busy.get(s)) return;
        const i = cursors.get(s) ?? 0;
        ensure(i + 1);
        const entry = sequence[i];
        busy.set(s, true);
        try {
          if (entry.kind === 'command') await runCommandOnSession(s, entry, { before: () => Promise.resolve(), after: () => Promise.resolve() });
          else runEntry(s, entry);
          cursors.set(s, i + 1);
        } finally { busy.set(s, false); }
      }));
      // Keep the shared clock at/above every session's simNs so a subsequent Run
      // doesn't have to wait for raceClock to climb back up to what the manual
      // step already spent.
      for (const s of sessions) raceClock = Math.max(raceClock, s.device.stats.simNs);
    },
    /** Fresh, empty chip on every participant, generator restarted from its seed,
     *  sequence and cursors cleared. Called whenever the participant set changes
     *  (ADR-0015's "no carryover" rule extended to N sessions). Clearing `sequence`
     *  drops any queued commands along with the churn steps, and re-seeding
     *  cmdRng makes a fresh run's broadcast content reproducible. Also zeroes the
     *  shared Race clock and re-baselines Stop/abort bookkeeping. */
    reset() {
      for (const s of sessions) s.freshFormat();
      churn.reset();
      sequence.length = 0;
      rnd = mulberry32(GEN_SEED);
      cmdRng = mulberry32(CMD_SEED);
      for (const s of sessions) cursors.set(s, 0);
      raceClock = 0;
      lastTickNow = 0;
      busy.clear();
      raceWaiters = [];
      stopToken = makeStopToken();
      opsEma.clear();
      lastOps.clear();
      lastSampleNow = 0;
      paceArrived = new Set();
      paceWaiting = new Set();
    },
    /** Append one ATOMIC COMMAND at the sequence frontier ("present"), so the
     *  leader hits it next and each follower hits it when its cursor arrives —
     *  one broadcast, replayed identically on every FS (ADR-0019). `fn` is
     *  `async (api) => any`, compiled by the caller (the console/button layer);
     *  `label` is the echoed source text for the tape. A per-command seed is
     *  drawn ONCE here (its own PRNG stream — never the churn PRNG) so a no-arg
     *  random draw inside `fn` (a random name/size) is identical call-for-call
     *  across every session that runs it (session.js seeds its own local
     *  generator from it). Also appends a '⧗ queued' tape line to every
     *  CURRENTLY participating session's journal (ADR-0018) — flipped to 'live'
     *  when that session's cursor reaches it and 'done' at quiescence
     *  (runCommandOnSession). Returns `{ index, entry }` — the entry's position
     *  in the canonical sequence and the entry object itself. */
    broadcast(fn, label) {
      const seed = (cmdRng() * 0x100000000) >>> 0;
      const entry = { kind: 'command', fn, label, seed, journalEntries: new Map() };
      for (const s of sessions) entry.journalEntries.set(s, s.appendJournal(`> ${label}`, 'cmd', 'queued'));
      const index = sequence.length;
      sequence.push(entry);
      return { index, entry };
    },
    /** What a session still has queued ahead of it: `gap` is how far its cursor
     *  sits behind the frontier (sequence.length — 0 once it's caught up to
     *  everything appended so far), `entries` are the not-yet-executed COMMAND
     *  entries in that span (each as `{ index, entry }`, same shape broadcast()
     *  returns, for the tape to render as ⧗ queued — ADR-0018; churn/gc steps in
     *  the gap count toward `gap` but are omitted from `entries`, since they're
     *  the auto-workload, not injected commands), and `behind` is GENUINE
     *  cross-session lag — this session's cursor strictly behind some OTHER
     *  session's — not merely "sequence.length ran ahead of me because ensure()
     *  pre-generated the step I'm currently mid-executing". In steady Pace every
     *  cursor is always equal (paceStep only ever advances the whole `due` set
     *  together), so `behind` is false throughout normal Pace lockstep,
     *  including while a command is live — exactly the fix for the old "always
     *  shows 1 behind" bug, which came from comparing against the lookahead-
     *  inflated `sequence.length` instead of against peer cursors. It's true
     *  only for an actual Race follower gap or a Race→Pace catch-up window,
     *  where cursors are genuinely diverged. */
    pendingFor(session) {
      const c = cursors.get(session) ?? 0;
      const frontier = sequence.length;
      const entries = [];
      for (let i = c; i < frontier; i++) if (sequence[i].kind === 'command') entries.push({ index: i, entry: sequence[i] });
      const maxCursor = sessions.length ? Math.max(...sessions.map((s) => cursors.get(s) ?? 0)) : c;
      return { entries, gap: frontier - c, behind: c < maxCursor };
    },
    /** Per-session comparison readout for the UI's compare strip. Garbage% comes
     *  from session.livenessCounts() (ADR-0015 accessor) — cached behind that
     *  session's own mapDirty gate and pure (no viz mutation), so this readout
     *  neither re-walks the live map itself nor mutates the die from a getter. */
    snapshots() {
      const minCursor = sessions.length ? Math.min(...sessions.map((s) => cursors.get(s) ?? 0)) : 0;
      const minSim = sessions.length ? Math.min(...sessions.map((s) => s.device.stats.simNs)) : 0;
      return sessions.map((s) => {
        const info = s.runner.fsinfo();
        const stats = s.device.stats;
        const wa = s.runner.hostBytes ? stats.programBytes / s.runner.hostBytes : 1;
        const c = s.livenessCounts();
        const programmed = c.live + c.obsolete + c.metadata;
        const garbagePct = programmed ? c.obsolete / programmed : 0;
        const cursor = cursors.get(s) ?? 0;
        // opsPerSec: EMA of WORKLOAD ops/sec (sequence steps consumed), sampled
        // on the tick; ≥ 0 always, 0 when idle (ADR-0020). The Race throughput
        // bar rates this; "ops done" is stepCursor, the cumulative same unit.
        const opsPerSec = Math.max(0, opsEma.get(s) ?? 0);
        // holding: this FS reached the Pace frontier and is blocked on the
        // laggard — either its cursor leads the shared min (a Race→Pace catch-up
        // leftover: nothing queued for it, sitting in the round's barrier) or it
        // finished the live command's ops and is parked in the phaser waiting on a
        // slower peer (paceArrived). Never true in Race, nor when not waiting.
        const holding = mode === 'pace' && (cursor > minCursor || paceArrived.has(s));
        // stalled: the Race analog of pace holding. After a Pace→Race switch the
        // ahead FS sits above the reseated clock and can't advance until raceClock
        // climbs to it, while the FS at the frontier races on. Flag it when it is
        // meaningfully ahead of the running frontier (min simNs) — a normal race
        // overshoot is one op (< STALL_GAP_NS), a real stall is the whole divergence
        // — and only while the race clock is actively advancing (lastTickNow set),
        // so a paused/idle race doesn't read as waiting. Bursty pacing (run to the
        // clock, wait, jump) is why we key on the simNs gap, not on frozen ticks.
        const stalled = mode === 'race' && lastTickNow !== 0 && (stats.simNs - minSim) > STALL_GAP_NS;
        // waiting: instantaneous "the FS sim is paused" (see isWaiting), the
        // per-frame counterpart to holding/stalled, IN ADDITION to them (unchanged).
        const waiting = isWaiting(s);
        return { fsId: s.fsId, name: s.name, stepCursor: cursor, simNs: stats.simNs, wa, files: info.files, garbagePct, opsPerSec, holding, stalled, waiting };
      });
    },
    /** Cheap per-fsId `waiting` map (the same signal snapshots().waiting carries),
     *  with NO fsinfo()/liveness walk, so it is light enough to poll every animation
     *  frame (the CS "sim paused" pin). Reads the SAME underlying gate state as
     *  snapshots().waiting. Returns `{ [fsId]: boolean }`. */
    waitStates() {
      const out = {};
      for (const s of sessions) out[s.fsId] = isWaiting(s);
      return out;
    },
  };
}
