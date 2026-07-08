# ADR 0012: Per-FS liveness via native inspect hooks

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Ben

## Context

FASTFFS colors the die per page — erased / metadata / obsolete / live-data — via
`fffs_inspect_live_map`, which reuses its index reachability walk (upstreamed to FASTFFS `main`,
see [ADR-0008](0008-live-map-and-background-gc.md)). LittleFS, and every later filesystem, has no
equivalent: in the FASTFFS benchmark suite no FS but FASTFFS exposes liveness at all. Under the
OPTIONAL-capability contract of [ADR-0011](0011-uniform-fs-driver-abi.md), we have to decide *how*
a new filesystem earns per-page coloring. The preference is a native hook; a spike was run before
committing, because "option a if feasible" is only a decision once feasibility is known.

## Decision

Each filesystem earns per-page coloring the way FASTFFS did: by **extending the filesystem itself
to expose its internals**. FASTFFS got `fffs_inspect_live_map` added and upstreamed
([ADR-0008](0008-live-map-and-background-gc.md)); every later FS gets the equivalent — a native
inspect hook exporting `ff_live_map` (and/or `ff_sector_classes`). Coupling that hook to FS
internals is not a risk to be minimized — it is the whole point of the project, which exists to
*visualize* those internals. A filesystem whose hook isn't built yet advertises the capability
*off* and the viz degrades ([ADR-0011](0011-uniform-fs-driver-abi.md)); it is never faked.

Every hook provides a shared baseline — erased / metadata / obsolete / live — and each FS is free
to classify *beyond* that in its own terms (different metadata kinds, different sector roles), so
the map is a per-FS taxonomy, not one fixed enum (ADR-0011).

For LittleFS, the spike confirmed a native hook is feasible and small (~70–110 LOC): a companion
translation unit (`lfs_inspect.c` that `#include`s `lfs.c`, or a direct patch — whichever stays
cleanest against upstream) reproducing the metadata-pair / CTZ traversal (`lfs_fs_traverse_`) with
per-phase tagging, reaching the static helpers (`lfs_dir_fetch`, `lfs_ctz_traverse`) it needs. The
live set comes from the traverse; obsolete-vs-erased splits by blank-scanning non-live blocks
(non-`0xFF` ⇒ obsolete), the same heuristic `ff_sector_classes` already uses — obsolete *is*
recoverable in LittleFS because it erases just-in-time at write, never on garbage-creation, so a
superseded block keeps its stale content until reallocated. The walk runs under the shim's
`g_quiet` flag so inspection emits no device traffic.

This ADR commits only to the baseline hook. The finer structure below is real and worth showing,
but we deliberately do **not** design it now — the goal is to not foreclose it.

## Consequences

- LittleFS gets at least the same erased / metadata / obsolete / live coloring as FASTFFS, so the
  two dies are directly comparable — the entire point of the multi-FS UI.
- The per-page classification is a **baseline, deliberately not frozen**. Richer LittleFS signals
  are worth surfacing in later iterations and shouldn't be designed away now:
  - metadata-pair **ping-pong** — which block of a pair is the active generation;
  - metadata blocks vs CTZ data blocks as distinct sector roles;
  - liveness **within** a metadata block — superseded tags/generations, not just whole-block —
    which the log structure should expose, not only whole orphaned pairs;
  - **inline small files** stored inside metadata, visible only with a finer-than-page map.
- The single-class-per-page contract will need to grow richer/finer — and not only for LittleFS:
  FASTFFS's v2 fragment-log (WIP) carves a sector into odd-sized ~252-byte "pages" after a footer,
  so a fixed page granule breaks down there too. The page stays the primary, human-legible unit of
  the visualization — **we are not ditching it** — but the inspect API likely grows to carry
  sub-page spans and per-FS class detail. That is future iteration; this ADR does not build it.
- (FASTFFS, later) sectors reserved for compaction or held as file reserves are also worth
  coloring — noted here, not scoped now.
- One rough edge to keep in mind: the blank-scan can false-positive when an obsolete *data* block's
  stale bytes happen to be all-`0xFF` (reads as erased). Cosmetic; metadata blocks always begin
  with a non-`0xFF` revision count, so they never misfire.

## Alternatives considered

- **Reconstruct liveness from device program/erase events** (FS-agnostic, zero per-FS code).
  Rejected as the primary approach: it can see *written* vs *erased* but not *reachable* vs
  *obsolete* without effectively re-implementing the FS walk anyway. Kept as the strictly-inferior
  fallback for any filesystem whose native hook is genuinely infeasible.
- **Coarse sector-level coloring only** (used/erased, no per-record liveness). Rejected: visibly
  poorer than FASTFFS and defeats the side-by-side comparison the multi-FS UI exists to show.
