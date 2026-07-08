# ADR 0007: Simulated flash timing and inspect-driven coloring

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Ben

## Context

Two gaps in the live visualizer: (1) every op animated at an arbitrary rate, so the *cost*
of operations wasn't legible — you couldn't see why `ls()` is slow or how expensive an erase
is; and (2) the die showed erased-vs-programmed but not FASTFFS's live-vs-obsolete structure,
which is the whole point of a log-structured filesystem.

## Decision

**Timing.** Every device op carries a simulated flash-time cost, using FASTFFS's
**ESP32-S3 measured preset** (`verify_flash.c`): read `64522 + 120·bytes` ns, program
`5937·bytes` ns, erase `21_269_000` ns/sector. The visualizer is a **timed player**: device
ops queue with their `ns`, and each animation frame spends a real-time budget
(`dtRealMs · scale`) advancing through the queue, so a 21 ms erase visibly holds while
sub-millisecond reads tick past. The SPEED slider sets `scale` (sim-ns per real-ms) — the
sim's rate relative to real flash time, from ~real-time to ~140× slow-mo. Each filesystem
call logs its true simulated cost (`ls() → 3.1 ms · 31 read`).

**Inspect.** A shim export `ff_sector_classes` reads each sector's footer (via silent reads
that don't show as device traffic) and classifies it: erased / live / obsolete / index /
other, using FASTFFS's own `fffs_decode_sector_footer` + `fffs_lifecycle_is_live`. The die
colors sectors by role — index sectors and live data are now visible.

Obsolete *data* mostly hides inside live sectors as dead records (FASTFFS packs new versions
alongside old and tombstones per record, not per sector), so sector color alone under-shows
it. We surface it as a **live · garbage · free** utilization bar and a **Garbage %** readout,
derived from committed bytes vs currently-programmed bytes.

## Consequences

- The cost model is now honest and legible: erases dominate, `ls()`/mount read-storms are
  visible, and write amplification has teeth.
- Sector roles (index/live) are truthful, read straight from FASTFFS's footers.
- The garbage bar approximates obsolete data as `programmed − committed`, which folds in
  metadata overhead — good enough to watch garbage grow under churn and drop after GC, but
  not a precise per-record measure.
- Timing constants are ESP32-S3-specific; other parts would use a different preset.

## Alternatives considered

- **Per-record obsolete coloring** (walk each sector's records with `decode_md` + reachability,
  tint the exact dead byte-ranges). The faithful way to show obsolete data on the die, but a
  substantial reimplementation of `fffs_inspect.c`'s walk. Deferred — the natural next step.
- **`fffs_inspect_check` aggregate** (record-level `md_live` / `md_obsolete_orphaned` counts).
  Callable (it uses `calloc`, not stack), and more precise than the byte approximation. A cheap
  follow-up if the garbage readout proves too coarse.
- **Real-time-only playback.** Rejected: erases (21 ms) and reads (0.1 ms) span 200×, so a
  fixed rate either blurs reads or makes erases imperceptible; time-scaled playback is the point.
