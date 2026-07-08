# ADR 0005: Compile real filesystems to WASM; JS emulates the NOR device

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Ben

## Context

The goal is to run *real* flash filesystems — FASTFFS first, then LittleFS / SPIFFS — in the
browser, and to visualize the actual device traffic each one issues: every `read`, `program`,
and `erase` against an emulated NOR chip. ADRs [0001](0001-single-static-page.md)–[0004](0004-gc-wear-and-endurance.md)
built a hand-rolled JS *simulation* of a log-structured filesystem. That was the right way to
discover the visual language, but it models a fake filesystem — it cannot show how a specific
real driver actually behaves, which is the whole point.

## Decision

We will restructure into four components with a clear boundary at the WASM edge:

1. **Filesystem-under-test → WASM.** Each filesystem is compiled to a WASM module that
   *exports* a small, uniform C API (`ff_format`, `ff_mount`, `ff_write`, `ff_read`,
   `ff_remove`, `ff_ls`, …) and *imports* a flash HAL (`flash_read`, `flash_prog`,
   `flash_erase`, `flash_sync`). A thin per-filesystem C **shim** maps that filesystem's
   native block-device callbacks onto the HAL. See [ADR-0006](0006-emscripten-toolchain.md)
   for the toolchain.

2. **JS owns the emulated NOR chip** (`device.js`). The flash is a `Uint8Array`. The HAL
   imports mutate it under NOR rules — `program` may only clear bits (`byte &= in`), `erase`
   sets a whole sector to `0xFF` — while maintaining per-sector wear counts and **emitting an
   event per operation**. This keeps NOR-semantics enforcement and event generation on the JS
   side, for free.

3. **The visualizer renders real device state** (`viz.js`, evolved from the prototype). Page
   fills come from the actual bytes; animations fire from the event stream. Write
   amplification, fragmentation, and wear hotspots become *emergent measurements of the real
   driver*, not fabricated numbers.

4. **A playground drives the exported FS API** (`playground.js`): a control panel for common
   operations plus a JS console for scripted workloads.

This supersedes ADRs 0001–0004.

## Consequences

- We show true driver behavior, and the same device + visualizer serve any filesystem that
  implements the shim — the comparison across filesystems is apples-to-apples.
- The "model" shrinks to an honest device emulator, which is simpler and less opinionated than
  the prototype's fake FS.
- New costs: a build step, a cross-language ABI (pointer/length marshalling over WASM memory),
  and per-filesystem shim work. The dev loop needs a static server (WASM won't load over
  `file://`).
- Device semantics (byte program, sector erase, wear, scaled endurance) carried over from
  ADR-0003/0004 will be pinned down in a dedicated device-emulator ADR once `device.js` exists.

## Alternatives considered

- **Keep the JS simulation.** Rejected: it can't run real filesystems, which is the objective.
- **Put the device model in WASM too.** Rejected for now: a JS-owned device gives free event
  emission, trivial NOR-semantics enforcement, and direct inspection from the visualizer with
  no extra ABI surface.
- **One WASM module linking all filesystems.** Rejected: separate modules keep each
  filesystem's symbols and config isolated and let us load/compare them independently.
