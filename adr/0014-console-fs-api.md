# ADR 0014: Console FS API — friendly pokes + raw handles over a static pool

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

The console is the main way to poke the FS by hand and script tests, but its facade is **whole-file
only** — no partial/positioned I/O, prefix-filtered listing, per-file stat, or multiple handles, even
though FASTFFS supports all of them. This matters *now*, before LittleFS: the shim ABI
(ADR-0011) should reach its final shape first so the second driver
is built against it, not retrofitted. Scripting also needs the internal `runner.names()` backdoor to
pick a delete victim; the public API should return enough for a script to track its own set.

## Decision

Two tiers, **both paced and animated by default** (that pacing is the console's whole point), both
borrowing FASTFFS's API shape.

**Tier 1 — friendly top-level pokes** (optional args, data-agnostic):
`writeFile(name?, size?) → {name, size}` (random name / stock size when omitted);
`readFile(name?) → {name, size}` (size = bytes read, never the bytes); `deleteFile(name?) → {name,
size}` (stats then deletes); `mkdir(path)` = **`mkdir -p`** (real on hierarchical FSs, no-op on
flat); `ls(prefix?)` streaming print; `getFiles(prefix?) → [{name, size}]`. Returning descriptors
lets a script self-track its file set, so the `runner.names()` peek stops being special.

**Tier 2 — raw `fs.` handle-based** (POSIX-shaped, the FASTFFS/LittleFS intersection, not
FASTFFS-branded): `fs.stat`/`list`/`mkdir` (single-level), lifecycle `fs.format/mount/unmount`,
introspection `fs.sectorClasses()`/`liveMap()`; `fs.openDir(prefix?) → {read()→{name,size}|null,
close()}` (regular files only — the shim skips `.`/`..` and dir entries); `fs.open(name, mode) →
{read(n), write(bytes), seek(off, whence), stat(), close()}` where `'r'`/`'w'` are mandatory and
**`'a'` append is optional/driver-advertised** (FASTFFS lacks it, LittleFS has it). `whence`
`'set'|'cur'|'end'` uniform; **open-flag/whence enums are FS-neutral names**, each shim mapping to
its own (`FFFS_O_*`/`LFS_O_*`). Existing `fs.write/read/cat/remove/exists/fsinfo` stay as whole-file
raw ops.

**Namespace — path-shaped names, no normalization layer.** Names pass to the driver as-is;
directories are bridged only by `mkdir -p` (loops the idempotent single-level `ff_mkdir`), real on
LittleFS and a no-op on flat FSs, so `mkdir('a/b'); writeFile('a/b/c')` behaves the same everywhere.
**Divergence at the edges is accepted, not papered over** (and is instructive): skipping `mkdir`
works flat but fails on LittleFS (parent must exist); non-canonical paths pass through unnormalized;
`prefix` matches at a single level, deeper listings may differ per FS.

**Handle model — a fixed static pool in the shim** (`files[N]`/`dirs[N]` + used-bitmap; `ff_open`/
`ff_dir_open` return a small int handle, negative on exhaustion; per-handle ops index it) — the
pattern the FASTFFS benchmark adapters use, bounded and malloc-free. Where a driver's file handle
carries a cache, the pool also holds a **static per-file buffer** (LittleFS: `LFS_NO_MALLOC` +
`lfs_file_opencfg` with `file_bufs[N][cache_size]` and static mount buffers). Pool reuse must `close`
a slot before freeing (uncommitted writes live in the handle until close).

**Setup mode — `prep(enable)`**, a global toggle: runs console ops full-speed with **no animation
and no await-pacing** while **still logging** each op and keeping die state current (the ops are
real). For bulk setup that shouldn't crawl op-by-op; "silent" would be the wrong name since logging
stays.

## Consequences

- The console can express everything the FS does, and LittleFS is built against the final ABI shape.
  Preflighted against LittleFS twice; the handle-based core maps 1:1.
- The shared interface is deliberately **simple** (no normalization, no auto-`mkdir`, no
  recursive-descent listing) — edge divergence illustrates flat vs. hierarchical and is more than a
  visualizer script needs.
- Directories cost metadata blocks on LittleFS, so its `liveMap`/block usage won't be pixel-identical
  to FASTFFS for the same file set — cosmetic.
- New shim surface + static pool is **C that needs simulation-correctness tests** (byte-exact
  partial/seeked reads, short-read `&got` semantics, pool exhaustion/reuse). Downsides: more ABI
  surface per shim (the whole-file ops can wrap the handle ops); `prep` is global state.

## Alternatives considered

- **Keep whole-file only, no handles.** Rejected: can't show partial/positioned I/O and forces a
  LittleFS retrofit later.
- **Expose the `runner.names()` tracked set for scripts.** Rejected: returning descriptors is cleaner
  and keeps the public API honest, with no silent state.
- **Dynamic / per-instance handle allocation.** Rejected: a fixed static pool matches embedded
  reality and the benchmark adapters.
- **A normalization + auto-`mkdir` + recursive-descent listing layer.** Rejected: too much machinery;
  `mkdir -p` plus single-level uniformity is enough, and edge divergence is an instructive limit.
