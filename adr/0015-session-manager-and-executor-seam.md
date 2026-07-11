# ADR 0015: A session abstraction, split from a manager, for the FS picker (and later lockstep)

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

The next UI feature switches which filesystem drives the die, with fresh state on switch (no cross-FS
carryover). `playground.js` bakes in ONE runner + ONE viz + ONE churn model as module-closure state,
so there is nothing to switch. A later item runs several filesystems *side by side in lockstep*. If
we solve only the picker with a single-instance refactor, that second feature reworks
`runner`/`viz`/`playground` again to make instances plural — the same trap ADR-0011 flagged rejecting
"generalize once two shims exist", one layer up at the thing that *owns* a runner+viz pair.

## Decision

Split `playground.js` into two layers.

**`session.js` — a pure executor for one filesystem instance.** `createSession(fsId, {geometry,
container, onLog, name})` owns everything to run one FS end-to-end: its own `runner`, `device`, `viz`,
a `.die` element appended into `container` (N sessions coexist in the DOM, inactive ones `.hidden`,
removed only on `teardown()`), **its own `timed()` op-log capture and `mapDirty` liveness flag**.
Per-session capture matters as soon as more than one session exists: without it, one session's device
events bleed into another's op log or liveness walk.

**A session executes what it's handed and nothing more.** Its two primitives — `runChurnEvent(ev)`
and `runGcStep()` — take a fully-formed churn event or "do one GC step" and run it, timed and logged.
A session **never decides what runs next**: no churn model, no gc-vs-write ratio, no workload loop.
That stays one layer up. **This is the seam a future lockstep coordinator drives through:** replace
the single `activeSession` with an array, replace the `Math.random() < gcRatio` + `churn.next()` step
with one that fans the *same* event to every session, and call the identical primitives on each —
nothing inside `session.js` changes.

**Write content is deterministic from the event's `writeSeed`** (a small seeded PRNG fill, not
`crypto.getRandomValues`), so the same event produces byte-identical content on every driver. Not
needed for the picker, but lockstep's whole value is comparing what filesystems do with the same
input; retrofitting determinism later would touch every churn call site. Costs nothing now, so it's
built into the executor primitive from the start.

**`playground.js` — the manager.** Owns the FS registry, the shared shell (transport, HUD, console,
picker), **one** `churn` model, and the gc-vs-churn decision loop. Exactly one `activeSession`; every
control and the console scope read it through a live `let` binding, so switching FS is just
reassigning the variable (no control rewiring, no console-scope reconstruction). On switch: tear down
old, create new, reset the churn model and re-format (fresh state), re-apply sticky UI, re-run
caps-gating.

**Caps-gated UI.** The manager reads the session's `caps` bitmask (ADR-0011) and toggles `.hidden` on
the BG-GC slider / Garbage stat / live·garbage bar when the FS disclaims `FF_CAP_GC` /
`FF_CAP_LIVE_MAP` — **off the runtime bitmask, never assumed from the fsId**, matching how `runner.js`
gates the underlying calls.

## Consequences

- Adding a third driver to the picker is: one `FS_REGISTRY` entry, one picker button, `dist/<fsId>.mjs`
  built. Neither `session.js` nor the control-wiring changes.
- A future lockstep coordinator is additive: N-session bookkeeping driving the same
  `runChurnEvent`/`runGcStep` seam, touching neither `session.js`, `runner.js`, nor `viz.js`.
- Downsides: `session.js` carries speculative machinery (deterministic byte-fill, `mapDirty`) that
  only pays off once lockstep lands, accepted deliberately. The console-scope objects read
  `activeSession` live via closures/getters, so every console primitive is one indirection from the
  session it runs against — worth remembering when tracing a bug.
- `teardown()` removes a die from the DOM on switch since this feature needs one live at a time; a
  lockstep coordinator keeping several alive would rely on `setActive()` instead.

## Alternatives considered

- **Minimal picker refactor (single mutable runner/viz/churn re-pointed on switch).** Rejected for
  the same reason ADR-0011 rejected the minimal FS ABI: it guarantees a second rework when lockstep
  lands, this time across control wiring and console scope too.
- **Have `session.js` own the churn model (one per session).** Rejected: lockstep's premise is *one*
  churn stream driving multiple filesystems identically, so the generator must live above whatever's
  plural.
- **Random write content, add determinism later.** Rejected: every churn write call site would change
  again; the seeded fill is a few lines now.
