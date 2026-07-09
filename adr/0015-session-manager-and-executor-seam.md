# ADR 0015: A session abstraction, split from a manager, for the FS picker (and later lockstep)

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

The roadmap's next UI feature is a control that switches which filesystem drives the die, with
fresh state on switch — no cross-FS carryover. `playground.js` today bakes in exactly ONE runner +
ONE viz + ONE churn model as module-closure state (`boot()`), so there is nothing to "switch" —
runner, viz, the die DOM, the op-log capture, and the console scope are all one singleton wired
together at boot.

A later roadmap item runs several filesystems *side by side in lockstep* — the same churn stream
driving two or three drivers at once so their die renders can be compared frame-for-frame. If we
solve only the picker (one FS at a time) with a single-instance refactor, that second feature would
require reworking `runner`/`viz`/`playground` again to make instances plural. ADR-0011 already
flagged exactly this trap when it rejected a "generalize once two shims exist" approach for the FS
ABI: it would rework `runner.js` and the viz twice. The same argument applies one layer up, to the
thing that *owns* a runner+viz pair.

## Decision

Split `playground.js` into two layers.

**`session.js` — a pure executor for one filesystem instance.** `createSession(fsId, { geometry,
container, onLog, name })` owns everything needed to run one FS end-to-end: its own `runner`
(ADR-0011), `device`, `viz`, a `.die` element it creates and appends into `container` (so N
sessions can coexist in the DOM — inactive ones are hidden via a `.hidden` class, never removed
except on `teardown()`), its own `timed()` op-log capture, and its own liveness `mapDirty` flag.
Per-session capture matters as soon as more than one session can exist: without it, switching (or
later, running two at once) would let one session's device events bleed into another's op log or
liveness walk.

A session executes what it's handed and nothing more. Its two op-executing primitives —
`runChurnEvent(ev)` and `runGcStep()` — take a fully-formed churn event or "do one GC step" and
run it, timed and logged. A session never decides *what* to run next: it has no churn model, no
gc-vs-write ratio, no workload loop. That decision-making stays one layer up, in whatever owns the
session. This is the seam a future lockstep coordinator drives through: replace the manager's
single `activeSession` with an array, replace the coordinator's `Math.random() < gcRatio` +
`churn.next()` step with one that fans the *same* event out to every session (or a per-session GC
decision), and call the identical `runChurnEvent`/`runGcStep` on each. Nothing inside `session.js`
changes to support that.

Write content is deterministic from the churn event's `writeSeed` (a small seeded PRNG fill, not
`crypto.getRandomValues`) rather than the caller supplying random bytes — so the *same* event
produces byte-identical file content on every driver. That is not needed for the picker (one FS at
a time, nothing to compare against), but a lockstep coordinator's whole value is comparing what
different filesystems do with the same input; retrofitting determinism after the fact would touch
every churn call site again. It costs nothing to build now, so it's built into the executor
primitive from the start, not bolted on later.

**`playground.js` — the manager.** Owns the FS registry (`fastffs` → `FASTFFS`, `littlefs` →
`LittleFS`), the shared shell (transport controls, HUD, console, the FS picker), one `churn` model,
and the auto-workload's gc-vs-churn decision loop. For this feature there is exactly one
`activeSession`; every control and the console scope read it through a live `let` binding rather
than closing over a specific instance, so switching FS is just reassigning the variable — no
control rewiring, no console-scope reconstruction. On switch: tear down the old session, create the
new one, reset the shared churn model and re-format (fresh state, no carryover), re-apply the
sticky UI settings (SPEED, heatmap, granule, prep), and re-run caps-gating.

**Caps-gated UI.** The manager reads the new session's `caps` bitmask (ADR-0011) and toggles a
`.hidden` class on the BG-GC slider, the Garbage stat, and the live·garbage bar when the active FS
disclaims `FF_CAP_GC` / `FF_CAP_LIVE_MAP` respectively — off the *runtime* bitmask, never assumed
from the fsId, matching how `runner.js` already gates the underlying calls to null/no-op.

## Consequences

- Adding a third driver to the picker is: one `FS_REGISTRY` entry, one picker button in
  `index.html`, `dist/<fsId>.mjs` built. Neither `session.js` nor the manager's control-wiring
  changes.
- A future lockstep coordinator is additive: it replaces the manager's *single-session* bookkeeping
  with N-session bookkeeping and drives the same `runChurnEvent`/`runGcStep` seam — it does not
  touch `session.js`, `runner.js`, or `viz.js`. This is the payoff for designing the executor
  primitives against N up front, per the ADR-0011 lesson above.
- Downsides: `session.js` now carries some machinery (deterministic byte-fill, per-session
  `mapDirty`) that only pays for itself once the lockstep feature lands — a small amount of
  speculative surface accepted deliberately, not incidentally.
- The manager's console-scope objects (`pfs`, `pacedFile`, `pacedDir`, `scope`) read `activeSession`
  live via closures/getters rather than being rebuilt per switch; this keeps the switch path small
  but means every console primitive is one indirection away from the session it actually runs
  against — worth remembering when tracing a bug through the console layer.
- Each session keeps its die mounted (hidden, not destroyed) only while active; `teardown()` removes
  it from the DOM entirely on switch, since this feature only ever needs one live at a time. A
  lockstep coordinator that keeps several sessions alive concurrently would rely on `setActive()`
  instead of tearing down the losing side each time.

## Alternatives considered

- **Refactor `playground.js` minimally just to add a picker (single mutable runner/viz/churn
  in place, re-pointed on switch).** Rejected for the same reason ADR-0011 rejected the minimal FS
  ABI: it solves today's feature and guarantees a second rework when lockstep lands, this time
  across `playground.js`'s control wiring and console scope as well as the runner.
- **Have `session.js` own the churn model too (one model per session).** Rejected: lockstep's
  entire premise is *one* churn stream driving multiple filesystems identically, so the generator
  has to live above whatever's plural — inside a session it could never be shared.
- **Random (non-deterministic) write content, add determinism later when lockstep needs it.**
  Rejected: every churn-driven write call site would need to change again, and the seeded fill is
  a few lines now versus a second pass through the same code.
