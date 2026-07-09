# ADR 0016: A lockstep coordinator drives N sessions off one canonical step sequence

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

ADR-0015 split `playground.js` into a manager (owns the shared shell, one churn generator, the
gc-vs-churn decision) and `session.js` (a pure per-filesystem executor with no opinion about what
runs next), explicitly so a second feature — several filesystems running the *same* workload side
by side — would be additive instead of a second rework. That feature is next: the roadmap wants the
same deterministic churn stream driving two or three drivers at once, in two comparison modes —
**Race** (every FS races against the same simulated-flash-time budget — active time stays level
while workload progress diverges) and **Pace** (every FS is held to the same workload step, so their
dies are directly comparable, while each FS's own active flash time is tracked separately).

The manager already had a single-session auto-workload loop: a 16ms `setInterval` that, once
`running`, gated on `viz.pending()===0` and issued the next `Math.random() < gcRatio ? gc : churn`
decision to `activeSession`. Two things about that loop don't survive going from 1 session to N
unchanged. First, `Math.random()` for the gc-vs-churn coin makes the decision itself
non-reproducible — fine when there's only one session to feed it to, but the whole point of Pace
mode is that two filesystems handed *the same* sequence of decisions are comparable; a coin flip
that differs from run to run (or, worse, that could in principle differ between two sessions if the
coin were drawn per-session instead of once) would quietly break that guarantee. Second, the loop's
gate — advance when this session's player drains (`pending()===0`) — generalizes to neither mode.
Pace needs the opposite of per-session: nobody advances until *everybody's* player has drained. And
Race, though it does advance each participant independently, must pace them against a shared
*simulated-time* budget rather than each one's own animation — otherwise the expensive-per-op FS
just accrues more active time, and the comparison lands on the wrong axis (see Decision).

## Decision

Add one new module, `web/src/lockstep.js`, that owns everything about *what runs next and when* for
however many sessions currently participate. Neither `session.js` nor `churn.js` changes: a session
still only knows how to execute `runChurnEvent`/`runGcStep` (ADR-0015), and the churn model still
only knows how to generate the next write/delete against its own slot table — same as today, just
called from a different, plural place.

**Canonical sequence, per-session cursor.** The coordinator holds one churn model (passed in,
still owned by the manager, still never owned by a session — ADR-0015's split holds) and grows a
`sequence` array lazily: `{kind:'gc'}` or `{kind:'event', ev}`, decided by a **seeded PRNG**
(mulberry32, same idiom as `session.js`'s `deterministicBytes`) instead of `Math.random()`. Every
session gets its own `cursor` — an index into that one shared array — so two sessions consuming the
same indices are, by construction, being fed the identical decisions and events; `runChurnEvent`'s
existing `writeSeed`-derived content (ADR-0015) then makes the bytes identical too. Generating
forward is idempotent and shared: whichever session asks for index N first causes it to be computed
once, and it's cached for whoever asks next.

**Race**: all participants race against ONE shared simulated-flash-time clock. Each 16ms tick,
`raceClock` (sim-ns) advances by the real time elapsed × the current SPEED scale — the same scale
the players animate at — and each session executes steps `while device.stats.simNs < raceClock`
(bounded by a per-tick step guard and a `pending()` backlog cap). Every FS therefore ends each tick
at ≈ the same active time; a cheaper-per-op driver simply fits more workload steps into that budget.
So **active time stays level and step cursors diverge** — Race answers "who gets more of the same
workload done in the same flash time." (An earlier cut gated each session on its own
`viz.pending()===0`, pacing by animation instead of sim-time, which made *active time* diverge and
step counts stay level — backwards; corrected to the shared clock. At no-delay, `raceClock` jumps a
fixed sim-ns chunk per tick so participants run flat-out but stay sim-synced.)

**Pace**: the coordinator computes ONE shared index (`Math.min` over all cursors — normally already
equal), issues that step to every session, then `await Promise.all(sessions.map(s => s.barrier()))`
before anyone gets the next one. Cursors move forward together by construction. Each session's own
`device.stats.simNs` keeps accruing independently underneath the lockstep, so "on the same step" and
"how much flash time did it cost to get here" are two different, both-visible numbers.

**Sessions stay dumb executors.** The coordinator is the only thing that decides what runs next; it
calls the exact same `runChurnEvent`/`runGcStep`/`barrier`/`pending`/`setScale` surface a
single-session manager would. Nothing about a session's internals — its `timed()` capture, its
`mapDirty` liveness flag, its die — changes to support N of them running at once; ADR-0015 already
paid for that isolation.

**Mode-switch reconciliation is `paceStep()`'s job, not `setMode()`'s.** Race is allowed to leave
cursors diverged; a naive Pace step that re-issued the shared `Math.min` index to every session
would redo an op a session that raced ahead already executed for real. `paceStep()` instead only
runs the step on sessions whose cursor equals the shared index (`due`) — a session already past it
sits in that round's `Promise.all(barrier())` with nothing new queued, and simply doesn't advance
until the laggards reach it. Each `paceStep()` call closes the gap by exactly one step per laggard;
after enough calls every cursor reads the same index again and ordinary lockstep resumes. This was
not the first version: the first cut had `setMode('pace')` synchronously replay a lagging session's
entire missing range up front. Under a Race burst at max speed that range can reach tens of
thousands of steps, and replaying that many real WASM filesystem calls with no yield point hung the
tab (caught by the dom-smoke suite, which now exercises exactly this Race→Pace transition). The
`due`-filtered `paceStep()` above is what shipped instead — bounded, incremental, no burst.

**Manager wiring.** `playground.js` keeps exactly the shape ADR-0015 left it in — a live
`activeSession` binding that every control and the console scope read through — except
`activeSession` is now "the DISPLAYED session" and is reassigned by a `setDisplayed(fsId)` function
instead of an exclusive FS switch. The FS picker becomes a multi-select (toggle participation, at
least one always selected); a new Compare row per participant doubles as the display-switch tab
(click a row to display that session) and as the always-visible progress strip
(`coordinator.snapshots()` → step cursor, active time, write-amp, files, garbage%) that makes Race
drift and Pace parity legible without needing every die on screen at once. Run/Pause/Step/Format/
SPEED/BG-GC now call the coordinator once, fanned to the whole participating set, instead of the
manager driving one session directly.

## Consequences

- Adding a third driver to the lockstep set is still mechanical: `FS_REGISTRY` entry, picker
  button, one more static Compare row in `index.html`, `dist/<fsId>.mjs` built. Nothing in
  `lockstep.js` assumes two.
- A session that was previously displayed and then loses the display keeps running (Race and Pace
  both need every participant executing regardless of which die is on screen — ADR-0015 already
  made `runChurnEvent`/`setActive` independent for exactly this reason) — but its `attachInspector`
  is explicitly cleared to `null` on hand-off, otherwise its still-running per-session rAF loop would
  keep overwriting the shared `#insp` panel with stale data after it's no longer shown. This uses
  `viz.js`'s existing `attachInspector(el)` (any value, including `null`, is accepted) — no change
  to `viz.js` was needed once this was noticed.
- Any participant-set change (adding or removing an FS) resets every participant to a fresh chip.
  Mid-run joins (a new session catching up to whatever step the others are on) were considered and
  rejected — see below — so there is no partial-history state to reason about.
- The compare strip's garbage% reads through `session.livenessCounts()` — a cached page-count
  accessor (ADR-0015) that re-walks `runner.liveMap()` only when that session's own `mapDirty` is
  set, shares the one walk with `refreshLiveness`, and never mutates viz. An earlier cut had
  `snapshots()` re-walk every participant every ~250ms and repaint the die as a getter side effect,
  defeating that short-circuit; the accessor removes both.
- A torn-down participant must resolve its pending player barriers as it stops (`viz.stop()`),
  mirroring the reset intake: otherwise a session removed mid-`paceStep()` leaves the coordinator's
  `Promise.all(barrier)` awaiter hanging and wedges `paceBusy`, freezing Pace. The always-animating
  player (needed for Pace barriers) makes this the coordinator's one real teardown invariant.
- Beyond that accessor, didn't need to touch `runner.js`, `device.js`, or `churn.js` — the ADR-0015
  executor seam and the ADR-0010 deterministic churn model were sufficient as published.

## Alternatives considered

- **Per-session churn model with the same seed, instead of one shared generator + per-session
  cursor.** Rejected: two independently-advancing model instances fed the same seed would still
  need every *decision* (gc-vs-write, which slot, which size) to happen in the same order to stay
  byte-comparable — that's exactly what a single generator with a shared, lazily-extended sequence
  guarantees for free, and a per-session model reintroduces the risk of the two drifting apart from
  a bug in either copy.
- **Mid-run join: a newly-added participant replays the sequence from index 0 while others keep
  running live.** Rejected for this pass: replaying "as fast as possible" while live sessions
  continue would itself need a third scheduling mode (bounded catch-up), and the payoff — not
  re-formatting the sessions already running — is small next to the complexity. A participant-set
  change resets everyone; simple, and consistent with ADR-0015's existing "FS switch ⇒ fresh chip"
  precedent.
- **Keep `Math.random()` for the gc-vs-churn coin, accept that Race mode doesn't need
  reproducibility.** Rejected: Pace mode's whole value is a byte-identical, decision-identical
  workload across FSes; a coin flip that isn't seeded would make Pace non-reproducible even though
  Race wouldn't care, and there's no reason to have two different generators for the two modes.
