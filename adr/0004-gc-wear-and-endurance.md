# ADR 0004: Greedy GC, page-aligned records, and scaled endurance

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** —

> Superseded: garbage collection is now the real filesystem's job. The device-side wear concepts
> carry forward to the JS device emulator; wear leveling, if any, lives in the filesystem under test.

## Carried forward (still live in `device.js`)

- **Per-sector wear counting**, incremented on erase. **Wear is measured at the device**, so every
  filesystem gets a wear map for free regardless of its own introspection ([ADR-0011](0011-uniform-fs-driver-abi.md)).
- A wear **heatmap** and peak-vs-average readout: greedy GC plus a circular frontier produces
  uneven wear (hot sectors erased far more than cold ones), surfaced honestly rather than hidden.
  No wear leveling.

## Prototype-only (not in the build)

- **Greedy-by-stale-count GC** with a free-page reserve, relocating surviving `valid` pages to the
  frontier before erasing, modeled the fake FS's reclamation. GC is now the real driver's.
- **Scaled endurance `ENDURANCE = 200` erase cycles/sector** (real NOR survives ~100k) was a
  prototype dramatization to make wear-out reachable in a session. It is **not in the build**.
- Page-aligned records (GC relocated/invalidated at page granularity) were the fake FS's layout.

*Cost-benefit GC and static/dynamic wear leveling were deferred so the naive-GC hotspot "before" is
visible first.*
