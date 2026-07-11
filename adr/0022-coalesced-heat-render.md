# ADR 0022: Render read/prog op glows as a coalesced per-cell heat field, not one animation per op

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** —

## Context

The visualizer glows each flash op: a read tints its page, a program flares it, an erase sweeps its
sector. The first implementation created one `Element.animate()` per op (a live animation object per
page touched). That cost scales with op count, and the counts aren't modest: a single LittleFS
compaction at no-delay speed replays ~30 000 reads in one burst. Each became its own animation, and
the browser's servicing of tens of thousands of concurrent Web Animations froze the main thread for
roughly a second (a captured trace: ~90% Web Animations servicing, ~3% GC). **The freeze scaled with
ops, so it was worst exactly when the visualization should be liveliest.** The obvious fixes —
capping concurrent animations, sampling/rate-limiting the per-op glow, batching a burst to a single
final-state repaint — each buy frame budget by throwing away per-op visual, and **the per-flash glow
is the product, not chrome.**

## Decision

Represent read and program glow as a **per-cell heat field**, not per-op animation objects, and
**never buy frame budget by dropping or throttling the per-op glow** (`web/src/viz.js`):

- Each page carries additive heat in `readHeat` / `progHeat` `Float32Array`s. `glow(p, kind)` bumps
  the channel by a fixed amount in O(1) with no allocation and records the page in a small `glowHot`
  `Set`. **Every op still contributes its glow — nothing dropped or sampled; the coalescence is in the
  representation, not the visual.**
- One `requestAnimationFrame` loop decays live heat (`heat *= 0.5^(dt/halfLife)`) and repaints only
  the `glowHot` pages (two box-shadow writes each). **Render cost is O(active cells) per frame,
  independent of how many ops were drained** — a 100-op and a 30 000-op burst on the same cells render
  identically. A cell leaves `glowHot` once both channels decay below a floor. (Two separate channels
  let overlapping read+program on one cell blend toward a designed per-theme mix instead of
  overwriting.)
- The **erase sweep keeps its single `Element.animate()`** — one animation per *sector* erase, a
  low-frequency, deliberately theatrical event, not a per-page storm.
- **`MAX_OPS_PER_FRAME` (currently 500) caps ops drained per frame, carrying the remainder forward.**
  This paces a burst across time so a sector stays visibly lit instead of collapsing into one mushed
  decay flash — it paces the *drain*, dropping nothing. Categorically different from limiting the
  animation.

## Consequences

- The main thread stays free at max sim speed; per-frame cost no longer tracks op rate. The die is
  liveliest exactly when the workload is busiest. The render path is a fixed, cheap per-frame sweep
  over a bounded hot set.
- **HARD CONSTRAINT on the record (explicit product veto): performance work on the die must not cap
  the concurrent-animation count, rate-limit or sample the per-op glow, or coalesce ops to a final
  state that drops the per-flash visual.** Easy to violate in good faith while "optimizing." The only
  acceptable levers are a cheaper *representation* that preserves every op's contribution (this heat
  field) and pacing the sim *drain* across frames with carry-forward (`MAX_OPS_PER_FRAME`) — never
  dropping, throttling, or degrading the glow itself.
- Read/prog and erase now animate by two mechanisms (heat field vs Web Animations); "how the die
  animates" is no longer one answer, and the roadmap note claiming every op animation was replaced by
  the Web Animations API is corrected.
- Heat is per-page state living for the glow's visible lifetime, reset on device reset and bounded by
  page count, so it does not accumulate.

## Alternatives considered

- **Cap concurrent animations / sample the glow / batch to a final repaint.** Rejected: each discards
  per-op visual, which is the product. Vetoed explicitly.
- **Keep one `Element.animate()` per op, only fewer or cheaper.** Rejected: any per-op-object approach
  scales with op count, and the op count is the problem; no per-op tuning survives no-delay speed.
- **Offload the die to Canvas/WebGL.** A cheaper substrate, but discards the DOM/CSS die and
  everything riding on it (sector clicks, wear heatmap, selection, resting rings) for a far larger
  change than the freeze warranted. Left open if the die grows.
- **Drop `MAX_OPS_PER_FRAME` and drain everything per frame.** Rejected: a huge burst decays in one
  frame, mushing a long legible sector-lit event into one flash.
