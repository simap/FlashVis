# ADR 0008: Per-page liveness via upstream inspect, and background-GC modeling

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** —

## Context

Sector-level classification ([ADR-0007](0007-timing-and-inspect.md)) under-showed obsolete data:
FASTFFS packs new file versions alongside old ones and marks individual *records* obsolete, leaving
old versions valid-but-orphaned; only the index reachability walk knows they're dead. Separately,
FASTFFS runs GC as small background steps; starved of those it degrades into inline (foreground) GC
during writes, making op times unpredictable (the failure mode most filesystems exhibit). Neither
was visible.

## Decision

**Liveness.** Add `fffs_inspect_live_map()` to FASTFFS, reusing its existing `inspect_index` +
`mark_live_chains` + `record_reachable_for_slot` walk to emit a **per-page** map: erased / metadata
/ obsolete / live-data. The shim exposes it via silent reads; the die tints each programmed page and
the live·garbage·free bar / Garbage% derive from it. This is the **authoritative** source (orphaned
old versions correctly obsolete), chosen over a brute-force read probe or op-stream side-channel,
both approximations that degrade under GC.

**Background GC.** The auto-workload splits into foreground file ops and background GC steps,
governed by a **BG GC** slider (share of steps on `fffs_gc_step`). At a healthy ratio writes stay
fast and garbage is reclaimed steadily; turned down, FASTFFS falls back to inline GC and the timing
log shows `write()` times spike while obsolete data accumulates. This makes FASTFFS's central design
tradeoff demonstrable.

## Consequences

- The die shows obsolete data truthfully at page granularity, straight from FASTFFS.
- We carry a FASTFFS change (additive, no change to existing inspect behavior); later upstreamed to
  FASTFFS `main` ([ADR-0012](0012-per-fs-liveness-inspect.md)).
- `fffs_inspect_live_map` runs the full reachability walk (heap `calloc`, many silent reads) a few
  times per second; real work, revisit cadence if it bites.

## Alternatives considered

- **Brute-force read probe / op-stream side-channel.** No FASTFFS change, but approximate and
  GC-fragile. Rejected in favor of the authoritative walk.
