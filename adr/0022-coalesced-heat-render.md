# ADR 0022: Render read/prog op glows as a coalesced per-cell heat field, not one animation per op

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** —

## Context

The visualizer glows each flash op on the die: a read tints its page, a program flares it, an
erase sweeps its sector. The first implementation — the one the roadmap's "Next" recorded as
the op animations having been "replaced by the Web Animations API" — created one
`Element.animate()` per op, i.e. a live animation object per page touched. That cost scales
with op count, and the op counts here are not modest: a single LittleFS compaction at no-delay
speed replays on the order of 30 000 reads in one burst. Each became its own animation, and
the browser's servicing of tens of thousands of concurrent Web Animations froze the main
thread for roughly a second. A captured trace put the [3.87–4.88 s] freeze at ~90% Web
Animations servicing and only ~3% GC. The freeze scaled with ops, so the faster the sim ran
the worse it got — precisely when the visualization should be liveliest.

The obvious fixes all degrade the thing the tool exists to show. Capping the concurrent
animation count, sampling or rate-limiting the per-op glow, or batching a burst to a single
final-state repaint each buy frame budget by throwing away per-op visual — and the per-flash
glow *is* the product, not chrome.

## Decision

We will represent read and program glow as a **per-cell heat field**, not per-op animation
objects, and we will **never buy frame budget by dropping or throttling the per-op glow.**

Concretely (`web/src/viz.js`):

- Each page carries additive heat in `readHeat` / `progHeat` `Float32Array`s. `glow(p, kind)`
  bumps the right channel by a fixed amount in O(1) with no allocation and records the page in
  a small `glowHot` `Set`. Every op still contributes its glow — nothing is dropped or sampled;
  the coalescence is in the *representation*, not the visual.
- One `requestAnimationFrame` loop decays live heat (`heat *= 0.5^(dt/halfLife)`) and repaints
  only the `glowHot` pages, two box-shadow writes each (the ring on the cell body, the bloom on
  a sibling `.glow` layer). Render cost is **O(active cells) per frame, independent of how many
  ops were drained** — a 100-op and a 30 000-op burst on the same cells render identically. A
  cell leaves `glowHot` only once both channels decay below a floor. (Overlapping read+program
  on one cell blend toward a designed per-theme mix instead of overwriting — the two separate
  channels are what make that possible.)
- The erase sweep keeps its single `Element.animate()`: one animation per *sector* erase, a
  low-frequency, deliberately theatrical event, not a per-page storm.
- `MAX_OPS_PER_FRAME` (currently 500) caps how many low-level ops are drained per animation
  frame, **carrying the remainder forward** to later frames. This paces a burst across time so a
  sector stays visibly lit instead of collapsing into one mushed decay flash — it paces the
  *drain*, dropping nothing. That is categorically different from limiting the animation: no
  op's glow is skipped, only spread.

## Consequences

- The main thread stays free at max sim speed: the freeze is gone and per-frame cost no longer
  tracks op rate. The die is liveliest exactly when the workload is busiest.
- The render path is now a fixed, cheap per-frame sweep over a bounded hot set, not an unbounded
  pile of animation objects the browser must service and later garbage-collect.
- **A hard constraint is now on the record: performance work on the die must not cap the
  concurrent-animation count, rate-limit or sample the per-op glow, or coalesce ops to a final
  state that drops the per-flash visual.** This was an explicit product veto, and it is easy to
  violate in good faith while "optimizing." The only acceptable levers are a cheaper
  *representation* that preserves every op's contribution (this heat field) and pacing the sim
  *drain* across frames with carry-forward (`MAX_OPS_PER_FRAME`) — never dropping, throttling,
  or degrading the glow itself.
- Read/prog and erase now animate by two different mechanisms (heat field vs. Web Animations).
  The split is intentional, but it means "how the die animates" is no longer a single answer;
  the roadmap note that once claimed every op animation was replaced by the Web Animations API
  is corrected to say so.
- Heat is per-page state that lives for the glow's visible lifetime; it resets on device reset
  and is bounded by page count, so it does not accumulate.

## Alternatives considered

- **Cap concurrent animations / sample the glow / batch to a final repaint.** Rejected: each
  buys frame budget by discarding per-op visual, which is the product. Vetoed explicitly.
- **Keep one `Element.animate()` per op, only fewer or cheaper.** Rejected: any per-op-object
  approach scales with op count, and the op count is the problem (tens of thousands in a burst);
  no per-op tuning survives no-delay speed.
- **Offload the die to Canvas/WebGL.** A cheaper substrate could also work, but it discards the
  DOM/CSS die and everything riding on it (sector clicks, wear heatmap, selection, resting
  rings) for a far larger change than the freeze warranted. The heat field solved it inside the
  existing DOM. Left open as a future option if the die grows.
- **Drop `MAX_OPS_PER_FRAME` and let each frame drain everything.** Rejected: a huge burst then
  decays in a single frame, mushing a long, legible sector-lit event into one flash; paced
  carry-forward draining reads better and still drops nothing.
