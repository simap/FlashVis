# ADR 0012: Per-FS liveness via native inspect hooks

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

FASTFFS colors the die per page (erased / metadata / obsolete / live-data) via
`fffs_inspect_live_map`, reusing its index reachability walk (upstreamed to FASTFFS `main`,
[ADR-0008](0008-live-map-and-background-gc.md)). LittleFS and every later filesystem has no
equivalent. Under the OPTIONAL-capability contract of [ADR-0011](0011-uniform-fs-driver-abi.md) we
must decide *how* a new filesystem earns per-page coloring. A spike was run first, since "native
hook if feasible" is only a decision once feasibility is known.

## Decision

Each filesystem earns per-page coloring the way FASTFFS did: by **extending the filesystem itself to
expose its internals** — a native inspect hook exporting `ff_live_map` (and/or `ff_sector_classes`).
**Coupling that hook to FS internals is not a risk to minimize — it is the whole point of the
project, which exists to visualize those internals.** A filesystem whose hook isn't built advertises
the capability *off* and the viz degrades ([ADR-0011](0011-uniform-fs-driver-abi.md)); **it is never
faked.** Every hook provides the shared baseline (erased / metadata / obsolete / live) and each FS
may classify *beyond* it in its own terms, so the map is a **per-FS taxonomy, not one fixed enum**.

For LittleFS the spike confirmed a native hook is feasible and small (~70–110 LOC): a companion TU
(`lfs_inspect.c` that `#include`s `lfs.c`, or a direct patch) reproducing the metadata-pair / CTZ
traversal (`lfs_fs_traverse_`) with per-phase tagging, reaching the static helpers it needs. The
live set comes from the traverse; obsolete-vs-erased splits by blank-scanning non-live blocks
(non-`0xFF` ⇒ obsolete), the same heuristic `ff_sector_classes` uses — obsolete *is* recoverable in
LittleFS because it erases just-in-time at write, never on garbage-creation, so a superseded block
keeps its stale content until reallocated. The walk runs under the shim's `g_quiet` flag (no device
traffic). This ADR commits only to the baseline hook; the finer structure below is deliberately not
designed now, only not foreclosed.

## Consequences

- LittleFS gets at least the same erased / metadata / obsolete / live coloring as FASTFFS, so the
  two dies are directly comparable — the point of the multi-FS UI.
- The per-page classification is a **baseline, deliberately not frozen.** Richer signals worth
  surfacing later (not designed away now): metadata-pair ping-pong (active generation of a pair);
  metadata vs CTZ data blocks as distinct roles; liveness *within* a metadata block (superseded
  tags/generations, not just whole orphaned pairs); inline small files stored in metadata.
- The single-class-per-page contract will need to grow finer — not only for LittleFS: FASTFFS's v2
  fragment-log (WIP) carves a sector into odd-sized ~252-byte "pages". **The page stays the primary,
  human-legible unit — not ditched** — but the inspect API likely grows sub-page spans and per-FS
  class detail. Future iteration.
- Rough edge: the blank-scan can false-positive when an obsolete *data* block's stale bytes are all
  `0xFF` (reads as erased). Cosmetic; metadata blocks always begin with a non-`0xFF` revision count,
  so they never misfire.

## Alternatives considered

- **Reconstruct liveness from device program/erase events** (FS-agnostic, zero per-FS code).
  Rejected as primary: it sees *written* vs *erased* but not *reachable* vs *obsolete* without
  re-implementing the FS walk anyway. Kept as the strictly-inferior fallback where a native hook is
  genuinely infeasible.
- **Coarse sector-level coloring only.** Rejected: visibly poorer than FASTFFS and defeats the
  side-by-side comparison.
