# ADR 0003: Byte-level programming with a configurable granule

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** Ben

> Superseded for the *filesystem* model, but the NOR device semantics decided here —
> byte-granular program that only clears 1→0, configurable program alignment, 0xFF padding —
> carry forward into the JS device emulator and will get their own device-semantics ADR.

## Context

Most NOR parts (and the devices FASTFFS targets) can **program a single byte**, and can keep
programming *more* bytes into a region that is still `0xFF` without erasing it first — because
programming only ever clears `1 → 0`, and writing `0xFF` clears nothing, so unwritten bytes
are undisturbed. The minimum program granule is often configurable (align writes to 1, 4, 16…
bytes); anything short of the granule is padded with `0xFF`, which preserves whatever was —
or wasn't — already there.

The first cut of the visualizer treated a 256 B page as the atomic program unit. That is a
NAND-shaped simplification and hides NOR's most distinctive capability: partial-page,
append-in-place programming.

## Decision

We will track programming **in bytes** while keeping the 256 B page as the visual quantum:

- Each page carries a **used-bytes** count (`0…256`); a cell renders a **fractional fill**
  equal to `used ÷ 256`. The unfilled remainder is `0xFF` slack, shown as erased substrate.
- A **program granule** `G ∈ {1, 4, 16, 64, 256}` bytes is user-selectable. Every write rounds
  its byte length up to a multiple of `G`, and the pad is `0xFF`.
- An **append-in-place** operation grows a file by programming more bytes into its last page's
  `0xFF` remainder — **no erase, no new page** — until the page fills, then it spills to a new
  page at the frontier. This is drawn as the fill rising within the existing cell.
- A **padding-waste** metric surfaces internal fragmentation: `1 − liveData ÷ reservedPageBytes`.
  It climbs as `G` grows or as many small records are stored.

## Consequences

- The demo can now *show* byte programming: partial cells, `0xFF` slack, and growth-without-erase.
- Raising the granule visibly wastes space — the intended lesson about alignment cost.
- Write amplification and waste are computed in bytes, which is the honest unit.
- **Simplification we accept:** records are page-aligned per file (see
  [ADR-0004](0004-gc-wear-and-endurance.md)); we do not pack multiple files' bytes into one
  page. So the finest *invalidation* unit remains the page even though the finest *program*
  unit is a byte. This keeps single-owner pages (simple GC, simple rendering) while still
  demonstrating byte-granular programming within a page. If we later want to show record
  packing and byte-level tombstoning, that is a new ADR.

## Alternatives considered

- **Fully byte-addressed log with multi-file page packing.** More faithful to how a real log
  packs records, but partial-stale-within-a-page rendering and a byte-range allocator are a
  large jump in complexity for the current teaching goal. Deferred, not rejected.
- **Keep page-atomic programming.** Rejected: it misrepresents NOR, per the context above.
