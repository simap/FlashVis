# ADR 0004: Greedy GC, page-aligned records, and scaled endurance

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** Ben

> Superseded: garbage collection is now the real filesystem's job, not ours. The device-side
> concepts — per-sector wear counting and scaled endurance for visibility — carry forward to
> the JS device emulator. Wear leveling, if any, lives in the filesystem under test.

## Context

Given the log-structured model ([ADR-0002](0002-log-structured-nor-model.md)), the device
needs to reclaim space, and sectors wear out with erase cycles. How we choose GC victims and
how we scale endurance directly shapes what the demo teaches.

## Decision

- **Garbage collection is greedy by stale count.** When free pages fall below a reserve
  (~1.6 sectors), GC picks the eligible sector with the most `stale` pages, **relocates any
  surviving `valid` pages** to the frontier (a real cost — this is where relocation write
  amplification comes from), then erases the sector back to `0xFF` and increments its wear.
- **Records are page-aligned per file.** A file owns whole pages; its last page may be
  partially programmed. GC therefore relocates and invalidates at page granularity, even
  though programming is byte-granular ([ADR-0003](0003-byte-programming-granularity.md)).
- **Endurance is scaled down to `ENDURANCE = 200` erase cycles per sector** so wear-out is
  reachable within a viewing session. Real NOR sectors survive ~100k cycles; the UI says so.
  A sector past its limit becomes `worn` and is excluded from allocation.
- **No wear leveling (yet).** Greedy GC plus a circular frontier produces *uneven* wear —
  hot sectors erased far more than cold ones holding static data. We surface this honestly via
  the **wear heatmap** and a peak-vs-average wear readout; it is a feature to observe, not a
  bug to hide.

## Consequences

- The heatmap tells a true story: naive greedy GC without wear leveling creates hotspots
  (peak wear can run ~8× the average in simulation). That is a compelling thing to *see*, and
  a natural setup for a future "enable wear leveling" toggle.
- Because greedy GC usually finds fully-stale victims, relocation — and thus write
  amplification — stays low until the device is genuinely full of live data. Accepted; WA is
  presented as an honest readout (see ADR-0002), not the hero metric.
- The scaled endurance means the "worn sectors" count is dramatized, not realistic. The UI
  discloses the scaling so no one mistakes 200 for a real datasheet figure.

## Alternatives considered

- **Cost-benefit GC (age-weighted victim selection).** More realistic, reduces relocation of
  hot-but-live data. Deferred: greedy is simpler to explain and the difference isn't the
  current lesson.
- **Static + dynamic wear leveling.** The natural next feature and a good toggle to contrast
  against today's hotspots — deferred to its own ADR so the "before" is visible first.
- **Realistic 100k endurance.** Rejected for the default: wear-out would never be observable
  in a demo. Left as a tunable.
