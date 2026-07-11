# ADR 0004: Greedy GC, page-aligned records, and scaled endurance

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** —

> Superseded: garbage collection is now the real filesystem's job. Per-sector wear counting and
> the wear heatmap carry forward to the JS device emulator (`device.js`); wear leveling, if any,
> lives in the filesystem under test.

## Context (still relevant)

Given the log-structured model ([ADR-0002](0002-log-structured-nor-model.md)), the device
needs to reclaim space, and sectors wear out with erase cycles. How we choose GC victims and
how we scale endurance directly shapes what the demo teaches.

## Decision (prototype era)

Still live in `device.js`: **per-sector wear counting** (incremented on each erase, measured at
the device) and, from it, the **wear heatmap** with a peak-vs-average readout that surfaces
*uneven* wear — hot sectors erased far more than cold ones holding static data. **No wear
leveling (yet)**; if any, it lives in the filesystem under test.

- ~~**Garbage collection is greedy by stale count.** When free pages fall below a reserve (~1.6 sectors), GC picks the eligible sector with the most `stale` pages, **relocates any surviving `valid` pages** to the frontier, then erases the sector back to `0xFF` and increments its wear.~~
- ~~**Records are page-aligned per file.**~~
- ~~**Endurance is scaled down to `ENDURANCE = 200` erase cycles per sector** so wear-out is reachable within a viewing session. Real NOR sectors survive ~100k cycles.~~
