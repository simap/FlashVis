# Architecture Decision Records

This directory records the significant decisions behind **flashvis** — what we chose, why,
and what we traded away. The point is that a reader (or a future us) can reconstruct the
reasoning without archaeology through diffs.

## Format

Lightweight [Nygard-style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
records. One file per decision, `NNNN-kebab-title.md`, numbered in order. Copy
[`template.md`](template.md) to start a new one.

Each record has a **Status**: `Proposed`, `Accepted`, `Superseded by ADR-XXXX`, or `Deprecated`.
Supersede rather than edit: once an ADR is `Accepted`, changing the decision means writing a
new ADR that supersedes it, so the trail of *why it changed* survives.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-single-static-page.md) | Ship as a single dependency-free static page | Superseded by [0005](0005-real-fs-to-wasm.md) |
| [0002](0002-log-structured-nor-model.md) | Model the device as a log-structured FS on NOR | Superseded by [0005](0005-real-fs-to-wasm.md) |
| [0003](0003-byte-programming-granularity.md) | Byte-level programming with a configurable granule | Superseded by [0005](0005-real-fs-to-wasm.md) |
| [0004](0004-gc-wear-and-endurance.md) | Greedy GC, page-aligned records, scaled endurance | Superseded by [0005](0005-real-fs-to-wasm.md) |
| [0005](0005-real-fs-to-wasm.md) | Compile real filesystems to WASM; JS emulates the NOR device | Accepted |
| [0006](0006-emscripten-toolchain.md) | Emscripten as the WASM build toolchain | Accepted |
| [0007](0007-timing-and-inspect.md) | Simulated flash timing (ESP32-S3) and inspect-driven coloring | Accepted |
| [0008](0008-live-map-and-background-gc.md) | Per-page liveness via upstream inspect; background-GC modeling | Accepted |
| [0009](0009-timed-playback-and-pacing.md) | Two-layer playback: instant execution, timed animation, await-pacing | Accepted |

ADRs 0001–0004 document the throwaway JS prototype that established the visual language.
They're kept as history; the live architecture starts at 0005.
