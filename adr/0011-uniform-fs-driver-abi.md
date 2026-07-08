# ADR 0011: A uniform FS-driver ABI behind the WASM shim

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Ben

## Context

`runner.js` hard-binds `dist/fastffs.mjs` and calls the `_ff_*` symbols by literal name,
*unconditionally* — a module that omits an optional export like `_ff_live_map` doesn't degrade,
it throws (a latent crash waiting for the second driver). The roadmap adds LittleFS, then SPIFFS
and JesFS, behind the same JS runner and visualizer. We need one contract every shim conforms to,
and a way for the viz to adapt when a filesystem can't provide an optional capability.

The analogous "one harness, many filesystems" problem is already solved in the FASTFFS benchmark
suite: `benchfs_ops_t`, a function-pointer table whose *optional* entries the runner null-checks
before calling. That is the model to mine — including its hard lesson that liveness introspection
is not a filesystem primitive.

## Decision

Define a uniform WASM shim ABI, split into REQUIRED core ops and OPTIONAL introspection, mirroring
`benchfs_ops_t`'s null-checked-pointer capability pattern.

- **REQUIRED** (a shim missing any is not loadable): `ff_config`, `ff_format`, `ff_mount`,
  `ff_unmount`, `ff_write`, `ff_read`, `ff_seek`, `ff_delete`, `ff_exists`, `ff_dir_open` /
  `ff_dir_read` / `ff_dir_close`, `ff_committed_files`, `ff_committed_bytes`, plus **`ff_caps()`**
  and **`ff_abi_version()`**.
- **OPTIONAL** (present only when advertised): `ff_gc_step`, `ff_sector_classes`, `ff_live_map`.

Whole-file `ff_write`/`ff_read` are the path the workload uses today, but the ABI also exposes
`ff_seek` and positioned (handle-based) reads/writes as **first-class primitives** — partial I/O
has its own device traffic worth visualizing, so seek is in the contract even though the churn
workload doesn't exercise it yet. A filesystem that can only emulate seek (e.g. JesFS rewinds and
re-reads) still implements the primitive; native-vs-emulated is a quality detail, not a capability
gate.

The inspect exports return a *per-FS* classification over a shared live/obsolete baseline — every
filesystem lays out its storage differently, with its own metadata kinds and sector roles — so the
class set is not a fixed universal enum, and its granularity (one class per page today) is expected
to get finer as filesystems with sub-page structure land. This is deliberately left open; see
[ADR-0012](0012-per-fs-liveness-inspect.md) for what that means concretely and why we don't freeze it now.

Capability discovery is two-layer: structural symbol-presence detection
(`typeof M['_' + name] === 'function'`) **plus** a runtime `ff_caps()` bitmask — the analog of
`benchfs_info_t`'s `*_valid` flags, able to report finer fidelity than mere presence (e.g.
"exports `ff_live_map` but never fills the obsolete class").

`runner.js` becomes filesystem-agnostic: dynamic `import(\`../../dist/${fsId}.mjs\`)`,
capability-gated optional calls that degrade to `null`/no-op instead of throwing, an
`ff_abi_version()` assertion on load, and `caps`/`name` surfaced on the returned `api` so the UI
can hide the obsolete% / live·garbage bar and the GC slider for a filesystem that lacks them.

`device.js` and `flash_hal.js` are unchanged: the HAL bottom-half (`read` / `prog` / `erase` /
`read_quiet`) is already FS-agnostic, and **wear is measured at the device**, so every future
filesystem gets a wear map for free regardless of its introspection support.

## Consequences

- Adding a driver becomes mechanical: write a shim exporting the required set (plus whatever
  optional hooks it can support) and a `build-<fs>.sh`; the viz adapts to the advertised
  capabilities instead of assuming FASTFFS's.
- Fixes the latent unconditional-call crash in today's `runner.js`.
- Downsides: an ABI version to maintain and bump; capability-gating spreads a handful of
  conditionals through `runner` / `playground` / `viz`; and this is a *first* cut — expect
  further refactors as the second and third real drivers and more inspect hooks land, so the
  contract is a starting point, not frozen.
- What the benchmark adapters teach about the line between "the FS hands you this" and "you build
  it": directory iteration, the fd table, and the POSIX path namespace were VFS conveniences — a
  bare WASM embedding implements them itself (our bare dir iterator already does). Two things the
  research surfaced, though, need the *opposite* framing from how a benchmark harness saw them:
  - **Liveness/obsolete introspection is not an FS freebie and not FASTFFS-privileged.** It's
    something we *add* to each filesystem by extending it, exactly as FASTFFS got
    `fffs_inspect_live_map` ([ADR-0012](0012-per-fs-liveness-inspect.md)). `live_map` is OPTIONAL
    only because a given driver may not have its hook built yet — never because the FS can't give it.
  - **Seek is a first-class FS primitive, exposed, not sidestepped.** The whole-file
    `ff_write`/`ff_read` are a convenience over it, but `ff_seek` and positioned I/O are in the
    contract regardless of whether the current workload uses them.

## Alternatives considered

- **Minimal — bind LittleFS with the least refactor, generalize once two shims exist.** Rejected
  it would rework `runner.js` and the viz twice; define the contract up front instead.
- **One monolithic op-struct marshalled across the WASM boundary.** Rejected: emscripten's
  per-symbol exports plus a `ff_caps()` bitmask is simpler and matches how the module already
  surfaces functions.
