# ADR 0011: A uniform FS-driver ABI behind the WASM shim

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

`runner.js` hard-binds `dist/fastffs.mjs` and calls `_ff_*` symbols by literal name
*unconditionally* — a module omitting an optional export like `_ff_live_map` doesn't degrade, it
throws (a latent crash waiting for the second driver). The roadmap adds LittleFS, then SPIFFS/JesFS
behind the same runner and viz. We need one contract every shim conforms to and a way for the viz to
adapt when a filesystem lacks an optional capability. The FASTFFS benchmark suite already solves the
"one harness, many filesystems" problem with `benchfs_ops_t`, a function-pointer table whose optional
entries the runner null-checks before calling — the model to mine, including its lesson that liveness
introspection is not a filesystem primitive.

## Decision

Define a uniform WASM shim ABI, split into REQUIRED core ops and OPTIONAL introspection, mirroring
`benchfs_ops_t`'s null-checked-pointer capability pattern.

- **REQUIRED** (missing any ⇒ not loadable): `ff_config`, `ff_format`, `ff_mount`, `ff_unmount`,
  `ff_write`, `ff_read`, `ff_seek`, `ff_delete`, `ff_exists`, `ff_dir_open`/`ff_dir_read`/`ff_dir_close`,
  `ff_committed_files`, `ff_committed_bytes`, plus **`ff_caps()`** and **`ff_abi_version()`**.
- **OPTIONAL** (present only when advertised): `ff_gc_step`, `ff_sector_classes`, `ff_live_map`.

**Seek is a first-class primitive.** Whole-file `ff_write`/`ff_read` are the path the workload uses,
but `ff_seek` and positioned handle-based I/O are in the contract regardless — partial I/O has its
own device traffic worth visualizing. A filesystem that can only emulate seek (e.g. JesFS rewinds
and re-reads) still implements it; native-vs-emulated is a quality detail, not a capability gate.

**Per-FS inspect taxonomy.** The inspect exports return a *per-FS* classification over a shared
live/obsolete baseline; every filesystem lays out storage differently, so the class set is **not a
fixed universal enum**, and its granularity (one class per page today) is expected to get finer as
sub-page-structured filesystems land ([ADR-0012](0012-per-fs-liveness-inspect.md)). Deliberately
left open.

**Two-layer capability discovery:** structural symbol-presence (`typeof M['_'+name] === 'function'`)
**plus** a runtime `ff_caps()` bitmask (the analog of `benchfs_info_t`'s `*_valid` flags), able to
report finer fidelity than presence (e.g. exports `ff_live_map` but never fills the obsolete class).

`runner.js` becomes filesystem-agnostic: dynamic `import(\`../../dist/${fsId}.mjs\`)`,
**capability-gated optional calls that degrade to `null`/no-op instead of throwing**, an
`ff_abi_version()` assertion on load, and `caps`/`name` surfaced on the `api` so the UI hides the
obsolete% / live·garbage bar / GC slider for a filesystem that lacks them. `device.js` and
`flash_hal.js` are unchanged and FS-agnostic; **wear is measured at the device**, so every future FS
gets a wear map for free regardless of introspection support.

**Liveness/obsolete introspection is not an FS freebie and not FASTFFS-privileged** — it is *added*
to each filesystem by extending it, as FASTFFS got `fffs_inspect_live_map`
([ADR-0012](0012-per-fs-liveness-inspect.md)). `live_map` is OPTIONAL only because a driver's hook
may not be built yet, never because the FS can't give it.

## Consequences

- Adding a driver is mechanical: a shim exporting the required set (plus whatever optional hooks it
  supports) and a `build-<fs>.sh`; the viz adapts to advertised capabilities. Fixes the latent
  unconditional-call crash.
- Downsides: an ABI version to maintain/bump; gating spreads conditionals through
  `runner`/`playground`/`viz`; this is a *first* cut, not frozen — expect refactors as more drivers
  and inspect hooks land.

## Alternatives considered

- **Minimal: bind LittleFS with least refactor, generalize once two shims exist.** Rejected: reworks
  `runner.js` and the viz twice; define the contract up front.
- **One monolithic op-struct marshalled across the boundary.** Rejected: emscripten's per-symbol
  exports plus a `ff_caps()` bitmask is simpler and matches how the module already surfaces functions.
