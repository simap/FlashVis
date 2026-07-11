# ADR 0006: Emscripten as the WASM build toolchain

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** —

## Context

The [pivot](0005-real-fs-to-wasm.md) needs a C→WASM toolchain (Apple clang can't target wasm). Real
FS sources use libc (`memcpy`, `memset`, sometimes `malloc`), marshal strings/buffers across the
boundary, and need the flash HAL to resolve to JS. Choice delegated with a lean-toward-velocity steer.

## Decision

Use **Emscripten** (Homebrew) as the primary toolchain.

- It supplies libc and `malloc`, so vendoring a filesystem is low-friction.
- The flash HAL imports resolve to JS via an Emscripten **JS library**
  (`mergeInto(LibraryManager.library, …)`) calling straight into `device.js`.
- Build one `*.mjs` + `*.wasm` per FS with a minimal explicit surface (exports `ff_*` plus
  `malloc`/`free`; imports the four HAL functions), the **contract identical across filesystems** so
  `runner.js` is FS-agnostic.

## Consequences

- Shortest path to a working playground; larger/opaquer glue than a freestanding build, accepted for
  a browser demo.
- If a target-fidelity build must be **freestanding / no-libc** to match on-device behavior, that is
  the trigger to add a **wasi-sdk + clang** variant producing a bare `.wasm` with our own
  `memcpy`/`memset`/allocator and the HAL as plain `extern` imports. The JS side is unaffected (same
  imports, same exports).

## Alternatives considered

- **wasi-sdk + clang (freestanding).** Leaner and closer to target but more manual and slower to
  first light. Kept as a documented fallback / second variant, not the default.
