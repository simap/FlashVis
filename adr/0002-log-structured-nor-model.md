# ADR 0002: Model the device as a log-structured filesystem on NOR

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** —

> Superseded: a real filesystem (FASTFFS et al.) now provides the log structure, GC, and
> allocation. This ADR documented the throwaway JS prototype that established the visual
> language. Retained as history.

## Carried forward (still live in `device.js`)

The **NOR device semantics and geometry** decided here are authoritative and live on in the JS
device emulator:

- **Program** clears bits `1 → 0` at fine (byte) granularity, see [ADR-0003](0003-byte-programming-granularity.md).
- **Erase** sets a whole **sector** (4 KB) back to `1` (`0xFF`); it is the slow, wearing op.
- Geometry: **64 sectors × 4 KB = 256 KB**, each sector = **16 pages × 256 B**.

Because a byte cannot be rewritten in place to a `1`, a NOR filesystem cannot update data where it
sits; the dominant answer (SPIFFS, LittleFS, FASTFFS) is an append-only **log**: write forward,
mark superseded data stale, reclaim whole sectors. That mechanic, and the moving write frontier
that draws it, are the prototype's contribution.

## Prototype-only (not the live model)

The hand-rolled per-page state machine (`erased`/`valid`/`stale`/`worn`), the circular frontier,
and write-amplification as a derived metric modeled a **fake** filesystem. GC and allocation are
now the real driver's job ([ADR-0005](0005-real-fs-to-wasm.md)).
