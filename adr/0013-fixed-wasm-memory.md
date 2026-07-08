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

Build each FS shim with a **fixed, non-resizable** memory: an explicit `-sINITIAL_MEMORY`, no
`ALLOW_MEMORY_GROWTH`, and `-sABORTING_MALLOC=1` so an over-budget allocation aborts loudly instead
of returning `NULL`. FASTFFS is built at **16 MB** — it is the memory-hungry driver, trading RAM for
speed via its index cache. Other filesystems are small-footprint by design and set their own,
smaller budget in their `build-<fs>.sh` (per-shim, [ADR-0011](0011-uniform-fs-driver-abi.md)).

Fixed memory makes `HEAPU8.buffer` a plain `ArrayBuffer`, so browser string decode works; `runner.js`
still decodes from `slice()` copies as defensive hygiene in case growth ever returns.

The floor is **test-guarded**: the integrity churn test (3000 ops + GC, and the heaviest allocator —
a full `read()` buffer per read-back) aborts if the budget can't fit the working set. Verified
empirically: it crashes below ~384 KiB and fails to even link below ~288 KiB for the default
geometry. 16 MB is ~40× the floor — generous headroom for larger file counts (FASTFFS index RAM
scales with them) while being nothing in a browser.

## Consequences

- Eliminates the resizable-buffer decode failure *and* the post-grow view-detach footgun.
- Simpler build; a footprint faithful to embedded RAM (and a candidate stat to surface later).
- The ceiling must be sized per FS with headroom — an over-budget workload aborts rather than
  growing, so a geometry or file count well beyond what the tests exercise could need a bigger
  number. The integrity test guards the floor for the standard config, not for an arbitrary one.
- Fixed memory is reserved upfront per module instance, so lockstep ([ROADMAP](../ROADMAP.md))
  running N filesystems at once costs N × the ceiling — another reason to keep per-FS budgets
  modest and treat FASTFFS's 16 MB as the outlier, not the default.

## Alternatives considered

- **Keep `ALLOW_MEMORY_GROWTH` and always decode from copies.** Rejected: leaves the view-detach
  footgun and the resizable-buffer surprises in place for no benefit on a bounded working set.
- **Compute an exact per-geometry budget.** Rejected as premature: a generous fixed number is
  simpler, and the churn test already guards the floor.
