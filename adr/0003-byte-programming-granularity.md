# ADR 0003: Byte-level programming with a configurable granule

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** —

> Superseded for the *filesystem* model, but the NOR device semantics decided here carry forward
> into the JS device emulator.

## Carried forward (still live in `device.js`)

NOR parts program a **single byte**, and can keep programming more bytes into a region still at
`0xFF` without erasing first, because programming only clears `1 → 0` and writing `0xFF` clears
nothing. This is NOR's distinctive capability: partial-page, append-in-place programming. The
256 B page stays the visual quantum, rendered as a fractional fill (`used ÷ 256`) with the `0xFF`
remainder shown as erased slack.

## Prototype-only (not in the build)

- A **configurable program granule** `G ∈ {1, 4, 16, 64, 256}` bytes (writes rounded up to a
  multiple of `G`, padded with `0xFF`) and its padding-waste metric were prototype tunables. The
  program-granule UI control was later **dropped** ([ADR-0018](0018-console-tape-and-scoreboard.md)).
- Records were page-aligned per file (finest *invalidation* unit = page, finest *program* unit =
  byte), a simplification of the fake FS; the real driver owns record layout now.

*A fully byte-addressed log with multi-file page packing was deferred, not rejected: more faithful,
but partial-stale-within-a-page rendering and a byte-range allocator were too large a jump then.*
