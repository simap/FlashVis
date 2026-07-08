# ADR 0002: Model the device as a log-structured filesystem on NOR

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** Ben

> Superseded: a real filesystem (FASTFFS et al.) now provides the log structure, GC, and
> allocation. This ADR documented the throwaway JS prototype that established the visual
> language. Retained as history.

## Context

NOR flash has one asymmetry that governs everything above it:

- **Program** clears bits `1 → 0` at fine (byte) granularity — see [ADR-0003](0003-byte-programming-granularity.md).
- **Erase** sets bits back to `1` (`0xFF`) only over a whole **sector** (4 KB here), and is the
  slow, wearing operation.

Because you cannot rewrite a byte in place to a `1`, a filesystem on raw NOR cannot update
data where it sits. The dominant answer — used by SPIFFS, LittleFS, and the target FASTFFS —
is to treat the device as an append-only **log**: write new data forward, mark superseded
data stale, and reclaim space by erasing whole sectors. The visualizer's job is to make that
loop legible.

## Decision

We will simulate a log-structured filesystem over a modelled NOR device:

- Geometry: **64 sectors × 4 KB**, each sector = **16 pages × 256 B** = a 256 KB region.
- A **circular write frontier** ("head") allocates the next erased page, sweeping the die and
  wrapping — this is the log append, and it is drawn as a moving cursor.
- **Updates never overwrite.** Rewriting a file appends fresh copies and marks the old pages
  `stale`. Deleting marks pages `stale`.
- A page is in exactly one of: `erased` (`0xFF`), `valid`, `stale`, or `worn`.
- Reclamation is garbage collection at sector granularity — see
  [ADR-0004](0004-gc-wear-and-endurance.md).

## Consequences

- The core mechanic to teach — append, invalidate, reclaim — falls straight out of the model.
- **Write amplification** (flash bytes programmed ÷ host bytes requested) is a natural derived
  metric. Note: under greedy GC on a churning workload the frontier usually finds fully-stale
  sectors, so WA hovers near 1× until the device is under real space pressure. It is kept as an
  honest readout, not oversold as the headline.
- The log frontier plus GC is enough to reach steady state and run indefinitely, which is what
  makes the demo "breathe."
- We deliberately do **not** model directory structure, metadata blocks, CRCs, or power-loss
  recovery. Those matter to a real FS but would clutter the visual thesis.

## Alternatives considered

- **Block-mapped FTL (like NAND + FTL).** Rejected: NOR filesystems are typically log/record
  structured directly on the raw device; an FTL abstraction would hide the very mechanics we
  want to show.
- **In-place update with copy-on-erase.** Rejected: doesn't reflect how NOR filesystems
  actually behave and would misteach the erase-before-rewrite constraint.
