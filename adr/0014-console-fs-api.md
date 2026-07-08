# ADR 0014: Console FS API — friendly pokes + raw handles over a static pool

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Ben

## Context

The JS console is the main way to poke the filesystem by hand and to script quick tests. Today it
exposes a thin paced facade — `fs.write/read/cat/remove/exists/list/fsinfo`, plus `ls`/`cat`/`gc` —
which is **whole-file only**. It can't express partial or positioned I/O, prefix-filtered listing,
per-file stat, or more than one open handle, even though FASTFFS's own API supports all of them
(`fffs_open`/`read`/`seek`/`write`/`fstat`/`close`, `fffs_dir_open(prefix)`, `fffs_stat`).

This matters *now*, before LittleFS. The shim ABI ([ADR-0011](0011-uniform-fs-driver-abi.md)) should
reach its richer, final shape first, so the second driver is built against it rather than retrofitted
once it's already landed. Separately, scripting a workload in the console today needs the internal
`runner.names()` tracked-set backdoor to pick a victim to delete — we'd rather the public API return
enough for a script to track its own set.

## Decision

Two tiers, **both paced and animated by default** (that pacing is the console's whole point), and
both borrowing FASTFFS's API shape.

**Tier 1 — friendly top-level pokes.** Optional args, data-agnostic — for quick tests where the
bytes don't matter:

- `writeFile(name?, size?) → {name, size}` — writes `size` random bytes (random name / stock size
  when omitted).
- `readFile(name?) → {name, size}` — whole-file read; `size` is the byte count read, never the
  bytes themselves. Same shape as `writeFile`/`deleteFile`, and tells you which file a no-arg read
  landed on.
- `deleteFile(name?) → {name, size}` — stats then deletes, so a caller learns the size too.
- `mkdir(path) → status` — `mkdir -p` (creates any missing parents); real on hierarchical FSs, a
  no-op on flat ones. `mkdir` first, then write under it, for portable directory use.
- `ls(prefix?)` — paced streaming print.
- `getFiles(prefix?) → [{name, size}]` — paced scan returning an array.

Returning descriptors from `writeFile`/`deleteFile` lets a script maintain its own file set with no
silent backdoor — the internal workload's `runner.names()` peek stops being special:

```js
const mine = [];
for (let i = 0; i < 100; i++) {
  if (mine.length && Math.random() < 0.3) {
    const { name } = await deleteFile(mine[rnd(mine.length)]);
    mine.splice(mine.indexOf(name), 1);
  } else { mine.push((await writeFile()).name); }
}
```

**Tier 2 — raw `fs.` on real data, handle-based** (POSIX-shaped — the FASTFFS/LittleFS intersection,
not a FASTFFS-branded contract):

- `fs.stat(name) → {name,size}|null`; `fs.list()`; `fs.mkdir(name)` (single level — the friendly
  top-level `mkdir` does `-p` over it); lifecycle `fs.format/mount/unmount`; introspection
  `fs.sectorClasses()` / `fs.liveMap()`.
- `fs.openDir(prefix?) → { read() → {name,size}|null, close() }` — `read()` yields **regular files
  only**: the shim skips `.`/`..` and directory entries (LittleFS surfaces those); empty/absent
  prefix → root. Directory-scoped, per the Namespace note.
- `fs.open(name, mode) → { read(n) → bytes, write(bytes), seek(off, whence), stat(), close() }` —
  `'r'` and `'w'` are the mandatory core; **`'a'` (append) is optional / driver-advertised**
  (FASTFFS has no append flag, LittleFS does). `whence` `'set'|'cur'|'end'` is uniform (`0/1/2` on
  both). The open-flag and whence enums are **FS-neutral** names, each shim mapping them to its own
  (`FFFS_O_*` / `LFS_O_*`, `FFFS_SEEK_*` / `LFS_SEEK_*`).

Existing `fs.write/read/cat/remove/exists/fsinfo` stay as the whole-file raw ops.

**Namespace — path-shaped names, kept simple.** Names are path-shaped (`foo/bar`) and passed to the
driver as-is — no normalization layer. Directories are bridged by **`mkdir`**: the friendly
top-level `mkdir(path)` is **`mkdir -p`** — it creates any missing parents by looping the
single-level shim primitive (`fs.mkdir` → `ff_mkdir`, idempotent: already-exists counts as success).
That is real on LittleFS (`lfs_mkdir` per component) and a no-op on the flat FSs (FASTFFS/SPIFFS,
where the path *is* the name). So `mkdir('a/b'); writeFile('a/b/c')` behaves the same on every
driver — one portable idiom, and you still get to watch flat vs. hierarchical layouts differ in the
die.

We accept divergence at the edges rather than build a compatibility layer:

- **Skip `mkdir` and you diverge.** Writing `foo/bar` without `mkdir('foo')` first works on the flat
  FSs (the path is just a name) but fails on LittleFS (the parent must exist). `mkdir`-then-write is
  the portable pattern — and the difference is itself instructive.
- **Non-canonical paths** (`/foo/./x/..//bar`) pass through unnormalized, so they can name different
  files on different drivers. Stick to clean relative paths.
- **`prefix`** on `ls`/`getFiles`/`fs.openDir` is directory-scoped, returns absolute paths, and
  matches across drivers at a single level; deeper listings may differ (each FS lists its own way).
  Empty/absent prefix lists the whole FS.

**Handle model — a static pool in the shim.** Each shim keeps a fixed pool of its native file/dir
handle structs (`files[N]` / `dirs[N]`) with a used-bitmap; `ff_open` / `ff_dir_open` return a small
integer handle (negative on exhaustion) and the per-handle ops
(`ff_file_read`/`seek`/`write`/`fstat`/`close`, `ff_dir_read`/`close`) index it — the pattern the
FASTFFS benchmark adapters already use (`files[MAX_OPEN_FILES]` + `file_used[]`). Where a driver's
file handle carries a cache, the pool also holds a **static per-file buffer**: LittleFS needs
`LFS_NO_MALLOC` + `lfs_file_opencfg` with a `file_bufs[N][cache_size]` (and static mount
read/prog/lookahead buffers), the analog of FASTFFS's static `g_scratch`/`g_index_cache`; open dirs
need only the struct. Pool reuse must `close` a slot before freeing it (uncommitted writes live in
the handle until close). `ff_dir_open` gains a `prefix` arg and the current single global `g_dir` is
replaced by the pool; the new exports extend the ABI
([ADR-0011](0011-uniform-fs-driver-abi.md), which already anticipated `ff_seek`).

**Setup mode — `prep(enable)`**, a global boolean toggle. Runs console ops at full speed with **no
animation and no await-pacing**, while **still logging** each op (so a script author gets feedback
and can reason about their code) and keeping the die's state current (the ops are real). For bulk
setup / framework code that shouldn't crawl op-by-op; `prep(false)` resumes paced, animated
interaction. "Silent" would be the wrong name — logging stays; `prep` names the setup/seed intent.
A scoped/callback form (`prep(async () => …)`) can be added later if the bare toggle proves leaky.

## Consequences

- The console can express everything the FS does — partial/seeked I/O, prefix scans, per-file stat,
  concurrent handles — and LittleFS is built against the final ABI shape, not a retrofit.
- Preflighted against LittleFS twice before locking; the handle-based core maps 1:1. The shared
  interface is deliberately **simple** — path-shaped names passed through as-is, a friendly
  `mkdir -p` (a no-op on flat FSs) as the one portable directory idiom, and `prefix`/listing that
  agree at a single level. No normalization layer and no auto-`mkdir`: skipping `mkdir`, deeper
  listings, and non-canonical paths are allowed to diverge (and illustrate flat vs. hierarchical) —
  more than a visualizer script needs.
- Directories cost metadata blocks on LittleFS, so its `liveMap`/block usage won't be
  pixel-identical to FASTFFS for the same file set — cosmetic, worth knowing.
- Scripts self-track from return values; the `runner.names()` backdoor is no longer needed publicly
  (kept internal to the auto-workload, or dropped).
- New shim surface + the static pool is **C that needs simulation-correctness tests** — byte-exact
  partial/seeked reads, short-read `&got` semantics, pool exhaustion/reuse — an integrity-style
  guard. (No UI-interaction tests; simulation correctness is the focus.)
- Downsides: more ABI surface every future shim implements (mitigated — the pool is trivial and the
  whole-file ops can wrap the handle ops); and the setup-mode toggle is global state to reason about.

## Alternatives considered

- **Keep whole-file only, no handles.** Rejected: can't show partial or positioned I/O — a core FS
  behavior — and forces LittleFS to be retrofitted to a wider ABI later.
- **Expose the `runner.names()` tracked set for scripts.** Rejected: returning descriptors from
  `writeFile`/`deleteFile` is cleaner and keeps the public API honest, with no silent state.
- **Dynamic / per-instance handle allocation.** Rejected: a fixed static pool matches embedded
  reality and the benchmark adapters — bounded, no malloc, trivial to reason about.
- **A normalization + auto-`mkdir` + recursive-descent listing layer for full nested / odd-path
  uniformity across drivers.** Rejected: too much machinery for a visualizer. `mkdir -p` plus
  single-level uniformity is enough; edge divergence is an accepted — and instructive — limit of
  the simple interface.
