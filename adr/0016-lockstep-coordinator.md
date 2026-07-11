# ADR 0016: A lockstep coordinator drives N sessions off one canonical step sequence

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

ADR-0015 split `playground.js` into a manager (shared shell, one churn generator, the gc-vs-churn
decision) and `session.js` (a pure per-FS executor) so this feature would be additive. The roadmap
wants the same deterministic churn stream driving two or three drivers at once, in two comparison
modes: **Race** (every FS races the same simulated-flash-time budget — active time level, workload
progress diverges) and **Pace** (every FS held to the same workload step, dies directly comparable,
each FS's own active flash time tracked separately).

The single-session loop doesn't survive going to N unchanged. `Math.random()` for the gc-vs-churn
coin makes the decision non-reproducible — but Pace's whole value is that filesystems handed *the
same* decisions are comparable. And the loop's per-session drain gate (`pending()===0`) generalizes
to neither mode: Pace needs *everybody's* player drained before anyone advances; Race must pace
against a shared *simulated-time* budget, not each session's own animation, or the expensive-per-op
FS just accrues more active time and the comparison lands on the wrong axis.

## Decision

Add `web/src/lockstep.js`, owning *what runs next and when* for however many sessions participate.
Neither `session.js` nor `churn.js` changes.

**Canonical sequence, per-session cursor.** The coordinator holds one churn model (manager-owned,
never session-owned — ADR-0015's split holds) and grows a `sequence` array lazily: `{kind:'gc'}` or
`{kind:'event', ev}`, decided by a **seeded PRNG (mulberry32), not `Math.random()`**. Every session
has its own `cursor` into that one shared array, so **two sessions consuming the same indices are by
construction fed identical decisions and events**; `runChurnEvent`'s `writeSeed`-derived content
(ADR-0015) makes the bytes identical too. Forward generation is idempotent and cached (computed once
by whichever session asks first).

**Race:** all participants race ONE shared simulated-flash-time clock. Each 16ms tick `raceClock`
(sim-ns) advances by real time elapsed × the current SPEED scale, and each session executes steps
`while device.stats.simNs < raceClock` (bounded by a per-tick step guard and a `pending()` backlog
cap). Every FS ends each tick at ≈ the same active time; a cheaper-per-op driver fits more steps in.
**Active time stays level, step cursors diverge** — "who gets more of the same workload done in the
same flash time." (An earlier cut gated on each session's own `pending()===0`, pacing by animation —
made active time diverge and step counts level, backwards; corrected to the shared clock. At no-delay
`raceClock` jumps a fixed sim-ns chunk per tick so participants run flat-out but stay sim-synced.)

**Pace:** the coordinator computes ONE shared index (`Math.min` over cursors), issues that step to
every session, then `await Promise.all(sessions.map(s => s.barrier()))` before the next. Cursors move
together; each session's `simNs` accrues independently, so "on the same step" and "flash time to get
here" are two both-visible numbers.

**Sessions stay dumb executors.** The coordinator is the only thing deciding what runs next; it calls
the same `runChurnEvent`/`runGcStep`/`barrier`/`pending`/`setScale` surface a single-session manager
would. ADR-0015 already paid for that isolation.

**Mode-switch reconciliation is `paceStep()`'s job.** Race leaves cursors diverged; a naive Pace step
re-issuing the shared index would redo an op a raced-ahead session already executed. `paceStep()`
runs the step only on sessions whose cursor equals the shared index (`due`); a session past it sits in
that round's barrier with nothing queued and doesn't advance until laggards reach it. Each call closes
the gap by one step per laggard. (The first cut had `setMode('pace')` synchronously replay a lagging
session's entire missing range up front; under a Race burst that range hits tens of thousands of
steps, and replaying that many WASM calls with no yield point hung the tab — caught by dom-smoke,
which now exercises this Race→Pace transition. The `due`-filtered version shipped: bounded,
incremental, no burst.)

**Manager wiring.** `activeSession` is now "the DISPLAYED session," reassigned by `setDisplayed(fsId)`
instead of an exclusive switch. The picker becomes multi-select (at least one always selected); a
Compare row per participant doubles as the display-switch tab and the always-visible progress strip
(`coordinator.snapshots()`). Run/Pause/Step/Format/SPEED/BG-GC call the coordinator once, fanned to
the whole participating set.

## Consequences

- Adding a third driver stays mechanical: `FS_REGISTRY` entry, picker button, one static Compare row,
  `dist/<fsId>.mjs`. Nothing in `lockstep.js` assumes two.
- A session that loses the display keeps running (both modes need every participant executing), but
  its `attachInspector` is cleared to `null` on hand-off or its still-running rAF loop overwrites the
  shared `#insp` panel with stale data. Uses viz's existing `attachInspector(el)`; no viz change.
- **Any participant-set change resets every participant to a fresh chip** (mid-run join rejected, see
  below), so there is no partial-history state.
- The compare strip's garbage% reads `session.livenessCounts()` — a cached accessor that re-walks
  `runner.liveMap()` only when `mapDirty` is set, shares the walk with `refreshLiveness`, never
  mutates viz. (An earlier `snapshots()` re-walked every participant every ~250ms and repainted as a
  getter side effect, defeating the short-circuit; the accessor removes both.)
- **Teardown invariant:** a torn-down participant must resolve its pending player barriers as it stops
  (`viz.stop()`), or a session removed mid-`paceStep()` leaves the coordinator's `Promise.all(barrier)`
  hanging and wedges `paceBusy`, freezing Pace. The always-animating player (needed for Pace barriers)
  makes this the one real teardown invariant.
- Beyond that accessor, didn't need to touch `runner.js`, `device.js`, or `churn.js` — the ADR-0015
  seam and the ADR-0010 deterministic model sufficed as published.

## Alternatives considered

- **Per-session churn model with the same seed.** Rejected: two independently-advancing instances
  would still need every decision in the same order to stay byte-comparable — exactly what one shared
  generator + lazily-extended sequence guarantees for free, without the drift risk.
- **Mid-run join replaying from index 0 while others run live.** Rejected this pass: it needs a third
  scheduling mode (bounded catch-up) for a small payoff. A participant-set change resets everyone,
  consistent with ADR-0015's "FS switch ⇒ fresh chip".
- **Keep `Math.random()` for the coin (Race doesn't need reproducibility).** Rejected: Pace's whole
  value is a decision-identical workload; no reason to have two generators for the two modes.
