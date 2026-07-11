# ADR 0002: Model the device as a log-structured filesystem on NOR

- **Status:** Superseded by ADR-0005
- **Date:** 2026-07-07
- **Deciders:** —

> Superseded: a real filesystem (FASTFFS et al.) now provides the log structure, GC, and
> allocation. The NOR device semantics and geometry below carry forward into the JS device
> emulator (`device.js`).

## Context (still relevant)

NOR flash has one asymmetry that governs everything above it:

- **Program** clears bits `1 → 0` at fine (byte) granularity — see ADR-0003.
- **Erase** sets bits back to `1` (`0xFF`) only over a whole **sector** (4 KB here), and is the
  slow, wearing operation.

Because you cannot rewrite a byte in place to a `1`, a filesystem on raw NOR cannot update
data where it sits. The dominant answer — used by SPIFFS, LittleFS, and the target FASTFFS —
is to treat the device as an append-only **log**: write new data forward, mark superseded
data stale, and reclaim space by erasing whole sectors. The visualizer's job is to make that
loop legible.

## Decision (prototype era)
~~We will simulate a log-structured filesystem~~ over a modelled NOR device:

- Geometry: **64 sectors × 4 KB**, each sector = **16 pages × 256 B** = a 256 KB region.
- ~~A **circular write frontier** ("head") allocates the next erased page, sweeping the die and
  wrapping — this is the log append, and it is drawn as a moving cursor.~~
- ~~**Updates never overwrite.** Rewriting a file appends fresh copies and marks the old pages
  `stale`. Deleting marks pages `stale`.~~
- ~~A page is in exactly one of: `erased` (`0xFF`), `valid`, `stale`, or `worn`.~~
- ~~Reclamation is garbage collection at sector granularity — see
  ADR-0004.~~