# ADR 0013: Fixed WASM memory footprint (no `ALLOW_MEMORY_GROWTH`)

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Ben

## Context

The shim was built with `-sALLOW_MEMORY_GROWTH=1`, which makes the WASM heap's backing store a
*resizable* `ArrayBuffer`. That bit us twice: browser `TextDecoder` (and emscripten's `UTF8ToString`,
which uses it) refuses to decode a view onto a resizable buffer — breaking `ls()` in Chrome while
passing every headless guard, since Node's `TextDecoder` is lax — and, more generally, a cached
`HEAPU8` view silently *detaches* after any grow.

The domain doesn't need growth. These are microcontroller filesystems, RAM-bounded by design, and
the flash chip is emulated in JS ([ADR-0005](0005-real-fs-to-wasm.md)) rather than living in WASM
memory. So the heap holds only the emscripten runtime, the FS's static state, and short-lived
buffers — the largest being a whole-file `read()` at `sectorSize*sectorCount` (256 KiB for the
current geometry). Growth buys nothing for a working set this bounded.

## Decision

Build every FS shim with a **fixed, non-resizable** memory: an explicit `-sINITIAL_MEMORY`, no
`ALLOW_MEMORY_GROWTH`, and `-sABORTING_MALLOC=1` so an over-budget allocation aborts loudly instead
of returning `NULL`. Use a **single shared 16 MB budget** — the need is the same for every
filesystem, so a per-FS budget would buy nothing.

The number has nothing to do with any FS's own RAM, which is tiny — even 1 MB would be overkill for
the hungriest (FASTFFS wants tens of KB at normal geometries). It is sized for the shim's whole-file
scratch buffers: `read()` allocates `sectorSize*sectorCount`, i.e. the **whole device capacity**
(256 KiB at the current geometry), and `list()` 64 KiB. So the budget tracks **geometry**, not the
filesystem, and 16 MB is chosen to hold a whole-file read of the largest realistic flash chip we'd
simulate (SPI-NOR tops out around a handful of MB) without a rebuild. Only a geometry beyond that
would need it raised; adding a driver never touches it.

Fixed memory makes `HEAPU8.buffer` a plain `ArrayBuffer`, so browser string decode works; `runner.js`
still decodes from `slice()` copies as defensive hygiene in case growth ever returns.

The floor is **test-guarded**: the integrity churn test (3000 ops + GC, and the heaviest allocator —
a full `read()` buffer per read-back) aborts if the budget can't fit the working set. Verified
empirically: it crashes below ~384 KiB and fails to even link below ~288 KiB for the default
256 KiB geometry (the read cache dominates the floor). 16 MB is ~40× that — nothing in a browser,
and headroom for far larger simulated chips.

## Consequences

- Eliminates the resizable-buffer decode failure *and* the post-grow view-detach footgun.
- Simpler build; a footprint faithful to embedded RAM (and a candidate stat to surface later).
- The ceiling is a hard cap — an over-budget workload aborts rather than growing. But it's driven
  by geometry, not by which FS is loaded, so only a geometry far larger than the tests exercise
  (huge sectors blowing up the whole-file read cache) would need a bigger number; adding a
  filesystem never does. The integrity test guards the floor for the standard geometry.
- Fixed memory is reserved upfront per module instance, so lockstep ([ROADMAP](../ROADMAP.md))
  running N filesystems at once reserves N × 16 MB — still trivial in a browser (tens of MB for a
  handful), and if it ever mattered the shared budget can drop, since there's ~40× headroom over
  the floor.

## Alternatives considered

- **Keep `ALLOW_MEMORY_GROWTH` and always decode from copies.** Rejected: leaves the view-detach
  footgun and the resizable-buffer surprises in place for no benefit on a bounded working set.
- **Compute an exact per-geometry budget.** Rejected as premature: a generous fixed number is
  simpler, and the churn test already guards the floor.
