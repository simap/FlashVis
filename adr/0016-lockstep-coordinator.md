# ADR 0016: A lockstep coordinator drives N sessions off one canonical step sequence

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

ADR-0015 split `playground.js` into a manager (shared shell, one churn generator, the gc-vs-churn
decision) and `session.js` (a pure per-FS executor) so this feature would be additive. The roadmap
wants one deterministic churn stream driving two or three drivers at once, in two comparison modes:
**Race** (every FS races the same simulated-flash-time budget — active time level, workload progress
diverges) and **Pace** (every FS held to the same workload step, dies directly comparable, each FS's
own active flash time tracked separately).

The single-session loop doesn't survive to N: `Math.random()` for the gc-vs-churn coin makes the
decision non-reproducible, breaking Pace's decision-identical comparison; and the per-session drain
gate (`pending()===0`) fits neither mode — Pace needs *everybody's* player drained before anyone
advances, Race must pace against a shared *simulated-time* budget, not each session's own animation
(else the expensive-per-op FS just accrues more active time — the wrong axis).

## Decision

Add `web/src/lockstep.js`, owning *what runs next and when* for however many sessions participate.
Neither `session.js` nor `churn.js` changes.

**Canonical sequence, per-session cursor.** The coordinator holds one churn model (manager-owned,
never session-owned) and grows a `sequence` array lazily: `{kind:'gc'}` or `{kind:'event', ev}`,
decided by a **seeded PRNG (mulberry32), not `Math.random()`**. Every session has its own `cursor`
into that one shared array, so **two sessions consuming the same indices are fed identical decisions
and events**; `runChurnEvent`'s `writeSeed`-derived content (ADR-0015) makes the bytes identical too.
Forward generation is idempotent and cached (computed once by whichever session asks first).

**Race:** all participants race ONE shared simulated-flash-time clock. Each 16ms tick `raceClock`
(sim-ns) advances by real time elapsed × current SPEED scale, and each session executes steps `while
device.stats.simNs < raceClock` (bounded by a per-tick step guard and a `pending()` backlog cap).
**Active time stays level, step cursors diverge** — who does more of the same workload in the same
flash time. (Gating on each session's own `pending()===0` instead diverges active time and levels
step counts — backwards. At no-delay, `raceClock` jumps a fixed sim-ns chunk per tick so participants
run flat-out but stay sim-synced.)

**Pace:** the coordinator computes ONE shared index (`Math.min` over cursors), issues that step to
every session, then `await Promise.all(sessions.map(s => s.barrier()))` before the next. Cursors move
together; each session's `simNs` accrues independently, so "on the same step" and "flash time to get
here" are two both-visible numbers.

**Sessions stay dumb executors.** The coordinator alone decides what runs next; it calls the same
`runChurnEvent`/`runGcStep`/`barrier`/`pending`/`setScale` surface a single-session manager would.

**Mode-switch reconciliation is `paceStep()`'s job.** Race leaves cursors diverged; `paceStep()` runs
the shared index only on sessions whose cursor equals it (`due`) — a session past it sits in that
round's barrier with nothing queued until laggards reach it, closing the gap one step per laggard.
(A `setMode('pace')` that synchronously replayed a laggard's whole missing range hung the tab on a
Race burst of tens of thousands of WASM calls with no yield point — caught by dom-smoke, which now
exercises this Race→Pace transition.)

**Manager wiring.** `activeSession` is now "the DISPLAYED session," reassigned by `setDisplayed(fsId)`
instead of an exclusive switch. The picker becomes multi-select (at least one always selected); a
Compare row per participant doubles as the display-switch tab and the always-visible progress strip
(`coordinator.snapshots()`). Run/Pause/Step/Format/SPEED/BG-GC call the coordinator once, fanned to
the whole participating set.

## Consequences

- Adding a third driver stays mechanical: `FS_REGISTRY` entry, picker button, one static Compare row,
  `dist/<fsId>.mjs`. Nothing in `lockstep.js` assumes two.
- A session that loses the display keeps running (both modes need every participant executing), but its
  `attachInspector` is cleared to `null` on hand-off, else its still-running rAF loop overwrites the
  shared `#insp` panel with stale data.
- **Any participant-set change resets every participant to a fresh chip** (mid-run join rejected), so
  there is no partial-history state.
- The compare strip's garbage% reads `session.livenessCounts()` — a cached accessor that re-walks
  `runner.liveMap()` only when `mapDirty` is set and shares the walk with `refreshLiveness`, never
  mutating viz (an earlier getter re-walked and repainted every participant every ~250ms).
- **Teardown invariant:** a torn-down participant must resolve its pending player barriers as it stops
  (`viz.stop()`), or a session removed mid-`paceStep()` leaves the `Promise.all(barrier)` hanging and
  wedges `paceBusy`, freezing Pace.
- Beyond that accessor, didn't touch `runner.js`, `device.js`, or `churn.js` — the ADR-0015 seam and
  the ADR-0010 deterministic model sufficed as published.

## Alternatives considered

- **Per-session churn model with the same seed.** Rejected: two independently-advancing instances would
  still need every decision in the same order to stay byte-comparable — the drift risk one shared
  generator avoids for free.
- **Mid-run join replaying from index 0 while others run live.** Rejected: needs a third scheduling mode
  (bounded catch-up) for a small payoff; a participant-set change resets everyone instead.
- **Keep `Math.random()` for the coin.** Rejected: Pace needs a decision-identical workload; no reason
  to run two generators for the two modes.
