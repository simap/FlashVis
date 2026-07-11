# ADR 0021: A filesystem advertises FF_CAP_GC only if its GC is incremental

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** —

## Context

The churn model (ADR-0010) emits a `{kind:'gc'}` step for a share `gcRatio` of all
workload steps (0.5 by default), and the lockstep coordinator broadcasts each step to every
participant. A participant runs the step through `runGcStep()`, which the runner (ADR-0011)
gates on the filesystem's advertised `FF_CAP_GC`: a driver that sets the bit and exports
`ff_gc_step` runs it, one that doesn't degrades to a no-op.

This design carries an unstated assumption: **one `ff_gc_step` call is a small, bounded unit
of progress.** FASTFFS satisfies it — its GC is a state machine that advances the smallest
amount possible per call, so calling it at `gcRatio` frequency interleaves cheap background
reclamation with the workload and makes FASTFFS *faster*, which is the whole point of a
tunable background-GC knob.

The LittleFS shim broke that assumption. LittleFS is copy-on-write and reclaims space inline
during writes; it has no log-structured GC pass. Its native `lfs_fs_gc()` is, per upstream,
an *idle-loop* hint — "Calling `lfs_fs_gc` in your idle loop should move high latency tasks
there as much as is currently possible" — and it is **not incremental**: with no progress
guard, every call redoes the entire `mkconsistent` + metadata-compact + allocator scan.
Because the shim advertised `FF_CAP_GC` (wiring `ff_gc_step` straight to `lfs_fs_gc`), the
churn model called that full scan on roughly every other step. Each call burned hundreds of
milliseconds and thousands of reads doing the same work over again — the visible symptom was
a tape line like `littlefs: gc() -> 226 ms · 3464 read`, and it also inflated the per-FS
flash-op counts, making a filesystem that does no GC look like a read-heavy GC engine.

## Decision

We will advertise `FF_CAP_GC` from a shim **only when that filesystem's `ff_gc_step` is a
genuinely incremental, bounded unit of GC progress** — safe to call repeatedly at churn
frequency. A filesystem whose only "GC" primitive does unbounded work per call, or that has
no GC pass at all, advertises no GC capability, and its churn `gc` steps become no-ops.

The LittleFS shim therefore drops `FF_CAP_GC` (caps `0xd` -> `0xc`, `APPEND|LIVE_MAP`) and
its `ff_gc_step` is a no-op. The ABI symbol stays for uniformity; the runner's capability
gate means it is never called. FASTFFS keeps `FF_CAP_GC` — its state-machine GC is exactly
the incremental primitive the churn model assumes.

## Consequences

- A `gc` churn step now models FASTFFS doing a small unit of real reclamation while LittleFS
  does nothing — the honest comparison: FASTFFS pays a periodic GC tax, LittleFS folds
  reclamation into its writes. The spurious LittleFS scan reads are gone, and the workload-op
  and flash-op telemetry (ADR-0020) reflect real work.
- The background-GC slider (`gcRatio`) has no direct effect on LittleFS, because LittleFS has
  no GC step. This is correct but can read as a dead control when LittleFS is focused; the
  slider governs the shared churn's GC share, which only GC-capable filesystems act on. It
  still shifts the gc/event mix of the shared sequence, so at a high ratio every participant
  spends more steps on gc (LittleFS idling through them) and fewer on file events.
- The capability bit now encodes a stronger contract than "this FS can do GC": it means "this
  FS's GC is incremental and churn-safe." Future drivers must judge their GC primitive
  against that bar, not merely whether a GC function exists.

## Alternatives considered

- **Keep the cap, call `lfs_fs_gc` rarely instead of never.** Rejected: there is no
  churn-safe rate for a non-incremental full scan, and LittleFS gains nothing from proactive
  GC in this model; "rarely" is just a smaller footgun.
- **Make `ff_gc_step` do a fraction of the work per call.** Rejected: `lfs_fs_gc` exposes no
  partial-progress entry point, so "incremental" would mean reimplementing LittleFS internals
  in the shim — far outside a driver's remit.
- **Drop the shared `gc` step and model GC as per-FS background overhead.** A cleaner long-run
  model, but a larger change to ADR-0010/0016 than this problem warrants; deferred.
