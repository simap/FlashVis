# ADR 0013: Fixed WASM memory footprint (no `ALLOW_MEMORY_GROWTH`)

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

`-sALLOW_MEMORY_GROWTH=1` makes the WASM heap's backing store a *resizable* `ArrayBuffer`, which bit
us twice: browser `TextDecoder` (and emscripten's `UTF8ToString`) refuses to decode a view onto a
resizable buffer — breaking `ls()` in Chrome while passing every headless guard (Node's `TextDecoder`
is lax) — and a cached `HEAPU8` view silently *detaches* after any grow. The domain doesn't need
growth: microcontroller filesystems are RAM-bounded, and the flash chip is emulated in JS
(ADR-0005), not in WASM memory. The heap holds only the emscripten
runtime, the FS's static state, and short-lived buffers.

## Decision

Build every FS shim with **fixed, non-resizable** memory: explicit `-sINITIAL_MEMORY`, no
`ALLOW_MEMORY_GROWTH`, `-sABORTING_MALLOC=1` (an over-budget allocation aborts loudly instead of
returning `NULL`). Use a **single shared 16 MB budget** — the need is the same for every filesystem.

The number is unrelated to any FS's own RAM (tiny — FASTFFS wants tens of KB). **It is sized for the
shim's whole-file scratch buffers**: `read()` allocates `sectorSize*sectorCount` (the whole device
capacity, 256 KiB at current geometry), `list()` 64 KiB. **So the budget tracks geometry, not the
filesystem**, and 16 MB holds a whole-file read of the largest realistic SPI-NOR chip (a handful of
MB) without a rebuild. Only a geometry beyond that needs it raised; adding a driver never touches it.

Fixed memory makes `HEAPU8.buffer` a plain `ArrayBuffer` so browser decode works; `runner.js` still
decodes from `slice()` copies as defensive hygiene. The **floor is test-guarded**: the integrity
churn test (3000 ops + GC, a full `read()` buffer per read-back) aborts if the budget can't fit the
working set — empirically it crashes below ~384 KiB and won't link below ~288 KiB for 256 KiB
geometry (the read cache dominates). 16 MB is ~40× that.

## Consequences

- Eliminates the resizable-buffer decode failure *and* the post-grow view-detach footgun; simpler
  build; a footprint faithful to embedded RAM.
- The ceiling is a hard cap: an over-budget workload aborts rather than grows, but it's driven by
  geometry, not by which FS is loaded, so only a far-larger geometry would need a bigger number.
- Reserved upfront per module instance, so lockstep running N filesystems reserves N × 16 MB — still
  trivial in a browser, and the shared budget can drop given the ~40× headroom.

## Alternatives considered

- **Keep `ALLOW_MEMORY_GROWTH` and always decode from copies.** Rejected: leaves the view-detach
  footgun and resizable-buffer surprises for no benefit on a bounded working set.
- **Compute an exact per-geometry budget.** Rejected as premature: a generous fixed number is
  simpler and the churn test guards the floor.
