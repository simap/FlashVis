# ADR 0021: A filesystem advertises FF_CAP_GC only if its GC is incremental

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** —

## Context

The churn model (ADR-0010) emits a `{kind:'gc'}` step for a share `gcRatio` (0.5 default) of workload
steps, broadcast to every participant and run through `runGcStep()`, which the runner (ADR-0011) gates
on `FF_CAP_GC` (set + `ff_gc_step` exported ⇒ runs, else no-op). This carries an unstated assumption:
**one `ff_gc_step` call is a small, bounded unit of progress.** FASTFFS satisfies it — its GC is a
state machine advancing the smallest amount per call, so calling it at `gcRatio` frequency interleaves
cheap background reclamation and makes FASTFFS *faster*, the whole point of a tunable background-GC
knob.

The LittleFS shim broke it. LittleFS is copy-on-write and reclaims inline during writes; it has no
log-structured GC pass. Its native `lfs_fs_gc()` is, per upstream, an *idle-loop hint* and is **not
incremental** — with no progress guard, every call redoes the entire `mkconsistent` + metadata-compact
+ allocator scan. Because the shim advertised `FF_CAP_GC` (wiring `ff_gc_step` straight to
`lfs_fs_gc`), the churn model called that full scan on roughly every other step: hundreds of ms and
thousands of reads redoing the same work (`littlefs: gc() -> 226 ms · 3464 read`), inflating flash-op
counts so a filesystem that does no GC looked like a read-heavy GC engine.

## Decision

**Advertise `FF_CAP_GC` only when that filesystem's `ff_gc_step` is a genuinely incremental, bounded
unit of GC progress** — safe to call repeatedly at churn frequency. A filesystem whose only GC
primitive does unbounded work per call, or that has no GC pass, advertises no GC capability and its
churn `gc` steps become no-ops.

The LittleFS shim drops `FF_CAP_GC` (caps `0xd` -> `0xc`, `APPEND|LIVE_MAP`) and its `ff_gc_step` is a
no-op (the ABI symbol stays for uniformity; the gate means it's never called). FASTFFS keeps
`FF_CAP_GC` — its state-machine GC is exactly the incremental primitive the churn model assumes.

## Consequences

- A `gc` churn step now models FASTFFS doing real reclamation while LittleFS does nothing — the honest
  comparison (FASTFFS pays a periodic GC tax, LittleFS folds reclamation into its writes). The
  spurious scan reads are gone and telemetry reflects real work.
- The BG-GC slider (`gcRatio`) has no direct effect on LittleFS (no GC step), which can read as a dead
  control when LittleFS is focused; it still shifts the shared sequence's gc/event mix, so at a high
  ratio every participant spends more steps on gc (LittleFS idling through them) and fewer on files.
- **The capability bit now encodes a stronger contract than "this FS can do GC": "this FS's GC is
  incremental and churn-safe."** Future drivers must judge their GC primitive against that bar, not
  merely whether a GC function exists.

## Alternatives considered

- **Keep the cap, call `lfs_fs_gc` rarely instead of never.** Rejected: there is no churn-safe rate
  for a non-incremental full scan, and LittleFS gains nothing from proactive GC here; "rarely" is a
  smaller footgun.
- **Make `ff_gc_step` do a fraction of the work per call.** Rejected: `lfs_fs_gc` exposes no
  partial-progress entry point, so "incremental" would mean reimplementing LittleFS internals in the
  shim.
- **Drop the shared `gc` step and model GC as per-FS background overhead.** Cleaner long-run, but a
  larger change to ADR-0010/0016 than this problem warrants; deferred.
