# ADR 0007: Simulated flash timing and inspect-driven coloring

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** —

## Context

Two gaps: every op animated at an arbitrary rate, so the *cost* of operations wasn't legible; and
the die showed erased-vs-programmed but not FASTFFS's live-vs-obsolete structure, the whole point of
a log-structured filesystem.

## Decision

**Timing.** Every device op carries a simulated flash-time cost using FASTFFS's **ESP32-S3 measured
preset** (`verify_flash.c`): read `64522 + 120·bytes` ns, program `5937·bytes` ns, erase
`21_269_000` ns/sector. The visualizer is a **timed player**: ops queue with their `ns`, and each
frame spends a real-time budget (`dtRealMs · scale`) advancing the queue, so a 21 ms erase visibly
holds while sub-ms reads tick past. The **SPEED slider sets `scale`** (sim-ns per real-ms). Each
call logs its true simulated cost (`ls() → 3.1 ms · 31 read`). Constants are ESP32-S3-specific;
other targets would use a different preset.

**Inspect.** Shim export `ff_sector_classes` reads each sector's footer via silent reads (no device
traffic) and classifies erased / live / obsolete / index / other, using FASTFFS's own
`fffs_decode_sector_footer` + `fffs_lifecycle_is_live`; the die colors sectors by role. Obsolete
*data* mostly hides inside live sectors as dead records (FASTFFS tombstones per record, not per
sector), so sector color under-shows it; a **live · garbage · free** bar and **Garbage %** readout
approximate it as `programmed − committed` (folds in metadata overhead, good enough to watch garbage
grow under churn and drop after GC, not a precise per-record measure).

## Consequences

- Cost model is honest and legible: erases dominate, `ls()`/mount read-storms are visible.
- Sector roles read straight from FASTFFS's footers.

## Alternatives considered

- **Real-time-only playback.** Rejected: erases (21 ms) and reads (0.1 ms) span ~200×, so a fixed
  rate either blurs reads or makes erases imperceptible; time-scaled playback is the point.
- **Per-record obsolete coloring** (tint exact dead byte-ranges). Deferred: a substantial
  reimplementation of `fffs_inspect.c`'s walk; the natural next step (superseded by the per-page
  live map in ADR-0008).
