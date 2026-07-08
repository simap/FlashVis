# ADR 0006: Emscripten as the WASM build toolchain

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Ben (choice delegated to the build)

## Context

The [pivot](0005-real-fs-to-wasm.md) needs a C→WASM toolchain. The host had none (Apple clang
can't target wasm). Real filesystem sources use libc facilities (`memcpy`, `memset`, sometimes
`malloc`), pass strings and buffers across the boundary, and we want the flash HAL to resolve
to JS functions. The choice was delegated with a lean-toward-velocity steer.

## Decision

We will use **Emscripten** as the primary toolchain, installed via Homebrew.

- It supplies libc and `malloc`, so vendoring a filesystem is low-friction.
- The flash HAL imports (`flash_read` / `flash_prog` / `flash_erase` / `flash_sync`) are
  implemented as an Emscripten **JS library** (`mergeInto(LibraryManager.library, …)`), which
  resolves the C `extern` declarations at link time and calls straight into `device.js`.
- We build one `*.mjs` + `*.wasm` per filesystem with a minimal, explicit surface:
  - **Exports:** `ff_format`, `ff_mount`, `ff_write`, `ff_read`, `ff_remove`, `ff_ls`, plus
    `malloc`/`free` for buffer marshalling.
  - **Imports:** the four flash HAL functions.
- Keep the export/import contract identical across filesystems so `runner.js` is FS-agnostic.

## Consequences

- Shortest path to a working browser playground; the ABI plumbing is well-trodden.
- Emscripten's glue is larger and somewhat opaque compared to a freestanding build — accepted
  for a browser demo where size isn't critical.
- If FASTFFS (or a target-fidelity build) must be **freestanding / no-libc** to match how it
  runs on-device, that is the trigger to add a **wasi-sdk + clang** build variant producing a
  bare `.wasm` with our own `memcpy`/`memset`/allocator and the HAL as plain `extern` imports.
  The JS side is unaffected — same imports, same exports.

## Alternatives considered

- **wasi-sdk + clang (freestanding).** Leaner, closer to target, explicit imports — but more
  manual (allocator, string marshalling) and slower to first light. Kept as a documented
  fallback / second build variant, not the default.
- **emsdk directly (not Homebrew).** More version control, more setup. Homebrew was the fast
  path on this host; we can pin via emsdk later if reproducibility demands it.
