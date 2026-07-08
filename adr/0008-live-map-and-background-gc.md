# ADR 0008: Per-page liveness via upstream inspect, and background-GC modeling

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Ben

## Context

Sector-level classification ([ADR-0007](0007-timing-and-inspect.md)) under-showed obsolete
data: FASTFFS packs new file versions alongside old ones and marks individual *records*
obsolete, leaving old versions as valid-but-orphaned — only the index reachability walk knows
they're dead. Separately, FASTFFS is designed to run GC as small background steps; starved of
those, it degrades into inline (foreground) GC during writes — less efficient, and it makes
individual op times unpredictable (the failure mode most other filesystems exhibit). Neither
was visible.

## Decision

**Liveness.** Add `fffs_inspect_live_map()` to FASTFFS (on submodule branch
`flashvis-live-map`), reusing the existing `inspect_index` + `mark_live_chains` +
`record_reachable_for_slot` walk to emit a **per-page** map: erased / metadata / obsolete /
live-data. The shim exposes it via silent reads; the die tints each programmed page and the
live·garbage·free bar and Garbage% are computed from it. This is the authoritative source —
orphaned old versions are correctly obsolete — chosen over a brute-force read probe or an
op-stream side-channel, both of which are approximations that degrade under GC (see ROADMAP).

**Background GC.** The auto-workload is split into foreground file ops and background GC steps,
governed by a **BG GC** slider (share of steps spent on `fffs_gc_step`). At a healthy ratio,
writes stay fast and garbage is reclaimed steadily; turned down, FASTFFS falls back to inline
GC and the timing log shows individual `write()` times spike while obsolete data accumulates.

## Consequences

- The die now shows obsolete data truthfully, at page granularity, straight from FASTFFS.
- The background-GC tradeoff — FASTFFS's central design point — is demonstrable and visible in
  the op-timing log, tying the timing work ([ADR-0007](0007-timing-and-inspect.md)) to a real
  filesystem-design lesson.
- We now carry a FASTFFS change on a branch; it should be reviewed and upstreamed. The addition
  is additive (no change to existing inspect behavior).
- `fffs_inspect_live_map` runs the full reachability walk (heap `calloc`, many silent reads) a
  few times per second; fine for a demo, but it's real work — revisit cadence if it bites.

## Alternatives considered

- **Brute-force read probe / op-stream side-channel.** No FASTFFS change, but approximate and
  GC-fragile. Rejected in favor of the authoritative walk; kept in ROADMAP as fallbacks.
