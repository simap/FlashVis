# ADR 0005: Compile real filesystems to WASM; JS emulates the NOR device

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** —

## Context

The goal is to run *real* flash filesystems (FASTFFS first, then LittleFS / SPIFFS) in the browser
and visualize the actual device traffic each issues. ADRs [0001](0001-single-static-page.md)–[0004](0004-gc-wear-and-endurance.md)
built a hand-rolled JS *simulation* of a log-structured filesystem: right for discovering the visual
language, but it models a fake filesystem and can't show how a specific real driver behaves, which
is the whole point.

## Decision

Restructure into four components with a clear boundary at the WASM edge (supersedes 0001–0004):

1. **Filesystem-under-test → WASM.** Each FS compiles to a module that *exports* a uniform C API
   (`ff_format`, `ff_mount`, `ff_write`, `ff_read`, `ff_remove`, `ff_ls`, …) and *imports* a flash
   HAL (`flash_read`, `flash_prog`, `flash_erase`, `flash_sync`). A thin per-FS C **shim** maps the
   filesystem's native block-device callbacks onto the HAL ([ADR-0006](0006-emscripten-toolchain.md)).
2. **JS owns the emulated NOR chip** (`device.js`). Flash is a `Uint8Array`; HAL imports mutate it
   under NOR rules (`program` may only clear bits `byte &= in`, `erase` sets a whole sector to
   `0xFF`), maintain per-sector wear counts, and **emit an event per operation**. This keeps
   NOR-semantics enforcement and event generation on the JS side, for free.
3. **The visualizer renders real device state** (`viz.js`). Page fills come from actual bytes;
   animations fire from the event stream; write amplification, fragmentation, and wear hotspots
   become *emergent measurements of the real driver*, not fabricated numbers.
4. **A playground drives the exported FS API** (`playground.js`): control panel plus a JS console.

## Consequences

- True driver behavior, and the same device + visualizer serve any FS implementing the shim, so
  cross-filesystem comparison is apples-to-apples.
- New costs: a build step, a cross-language ABI (pointer/length marshalling over WASM memory),
  per-FS shim work, and a static server (WASM won't load over `file://`).
- Device semantics carried over from ADR-0003/0004 get pinned down once `device.js` exists.

## Alternatives considered

- **Put the device model in WASM too.** Rejected: a JS-owned device gives free event emission,
  trivial NOR-semantics enforcement, and direct inspection with no extra ABI surface.
- **One WASM module linking all filesystems.** Rejected: separate modules keep each FS's symbols and
  config isolated and loadable/comparable independently.
