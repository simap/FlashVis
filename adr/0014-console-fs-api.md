# ADR 0014: Console FS API — friendly pokes + raw handles over a static pool

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

The console — the main way to poke the FS by hand and script tests — is **whole-file only**: no
partial/positioned I/O, prefix listing, per-file stat, or multiple handles, though FASTFFS has all
of them. Finalize the shim ABI (ADR-0011) before LittleFS: the second driver builds against it,
not a retrofit. Scripts need the internal `runner.names()` backdoor to pick delete victims; the
public API should let them self-track.

## Decision

Two tiers, **both paced and animated by default** (the console's whole point), both FASTFFS-shaped.

**Tier 1 — friendly top-level pokes** (optional args, data-agnostic):
`writeFile(name?, size?) → {name, size}` (random name/stock size defaults);
`readFile(name?) → {name, size}` (size = bytes read, never the bytes); `deleteFile(name?) → {name,
size}` (stats then deletes); `mkdir(path)` = **`mkdir -p`**; `ls(prefix?)` streaming print;
`getFiles(prefix?) → [{name, size}]`.

**Tier 2 — raw `fs.` handle-based** (POSIX-shaped FASTFFS/LittleFS intersection, not
FASTFFS-branded): `fs.stat`/`list`/`mkdir` (single-level), `fs.format/mount/unmount`,
`fs.sectorClasses()`/`liveMap()`; `fs.openDir(prefix?) → {read()→{name,size}|null, close()}`
(regular files only); `fs.open(name, mode) → {read(n), write(bytes), seek(off, whence), stat(),
close()}` — `'r'`/`'w'` mandatory, **`'a'` optional, driver-advertised** (FASTFFS lacks it,
LittleFS has it), `whence` `'set'|'cur'|'end'` uniform, **enums FS-neutral**, mapped per shim
(`FFFS_O_*`/`LFS_O_*`). Existing `fs.write/read/cat/remove/exists/fsinfo` stay whole-file.

**Namespace — path-shaped names, no normalization.** Names hit the driver as-is; the only
directory bridge is `mkdir -p` (looped idempotent single-level `ff_mkdir`; real on LittleFS, no-op
flat), giving identical behavior everywhere. **Edge divergence is accepted, instructive**: skipping `mkdir` fails only on LittleFS; non-canonical paths pass through;
`prefix` is single-level.

**Handle model — fixed static pool in the shim** (`files[N]`/`dirs[N]` + used-bitmap;
`ff_open`/`ff_dir_open` → small int handle, negative on exhaustion) — the FASTFFS
benchmark-adapter pattern: bounded, malloc-free. Cache-carrying drivers get **static per-file
buffers** (LittleFS: `LFS_NO_MALLOC`, `lfs_file_opencfg`, `file_bufs[N][cache_size]`, static mount
buffers). `close` before slot reuse — uncommitted writes live in the handle.

**Setup mode — `prep(enable)`**, global: full-speed, **no animation/await-pacing**, still logged,
die state current (real ops). For bulk setup.

## Consequences

- The console expresses everything the FS does; LittleFS gets the final ABI shape.
- The shared interface is deliberately **simple**.
- LittleFS directories cost metadata blocks — `liveMap`/block usage won't match FASTFFS exactly;
  cosmetic.
- New shim C needs simulation-correctness tests: byte-exact partial/seeked reads, short-read
  `&got` semantics, pool exhaustion/reuse. Downsides: more ABI per shim; `prep` is global state.

## Alternatives considered

- **Whole-file only, no handles.** No partial/positioned I/O; LittleFS retrofit later.
- **Expose the `runner.names()` tracked set.** Returned descriptors are cleaner; no silent state.
- **Dynamic / per-instance handle allocation.** Static pool matches embedded reality.
- **Normalization + auto-`mkdir` + recursive-descent listing.** Too much machinery; single-level
  uniformity suffices.
