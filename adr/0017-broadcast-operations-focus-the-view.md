# ADR 0017: Multi-FS by default — every operation broadcasts through one timeline; the view focuses one FS

- **Status:** Superseded by ADR-0019 — the broadcast/focus stance holds; the op-level granularity and completion model do not.
- **Date:** 2026-07-09
- **Deciders:** —

> Superseded by ADR-0019: the broadcast-through-one-timeline
> and focus-is-a-view stance holds, but the broadcast unit moves up from the individual op to the
> atomic command.

## Context (still relevant)

The lockstep coordinator (ADR-0016) made it *possible* to run several
filesystems against one churn stream; this ADR makes that the product. FLASHVIS becomes a comparison instrument: every active
filesystem runs the same workload at once, and you *focus* one at a time to inspect it. Both drivers
are live from page load.

For the comparison to
mean anything, every filesystem must receive **identical** operations in an identical order. But Race
mode (ADR-0016) *intentionally* desyncs their progress — the whole
point is to watch a cheaper-per-op driver pull ahead. So "apply this to all filesystems" cannot mean
"execute it on all N right now": right now they are at different points in the workload. We need a
model where an operation lands at the same *logical* point on every filesystem regardless of how far
apart their cursors have drifted — and a definition of what "switching filesystem" actually does.

## Decision (broadcast/focus stance holds; op-level granularity superseded)

~~Every filesystem operation — mutations **and** queries alike (`write`, `delete`, `format`, `gc`, `read`, `ls`, `stat`, `mkdir`) — is a **broadcast action appended to the single canonical `sequence[]` at the frontier ("present"), and executed by each session when its own cursor reaches that index**.~~
This is exactly the sequence-plus-per-session-cursor machinery (ADR-0016)
that already drives churn steps; a manual poke is just another entry in that one timeline, of a new
`kind`. Because there is one shared, replayed sequence, two filesystems consuming the same index are
by construction fed the identical operation — the same guarantee churn already relied on, now
extended to hand-issued commands.

Reads and `ls` are broadcast and simulated too, **not** answered out-of-band. Their device traffic
(the read blips, the directory scan) is precisely what the tool exists to visualize, so they cost
simulated time and animate on every filesystem like any other op. A focus-only "tell me what's in
this FS right now without simulating it" would have to be a deliberately side-channeled inspection
mode — off the timeline, not counted toward timing, its own explicit switch — and we are **not**
building it now (perhaps not ever); the default is that everything you do is a simulated, broadcast
filesystem action.

**Focus is a property of the view, never of the workload.** The die, the tape (op log), the
telemetry, and the legend all reflect the one focused filesystem. **Switching focus is a pure view
operation** — it changes nothing about state, appends nothing to the sequence, and is not logged
(ADR-0018 turns the old "switched to X" log line into simply
re-pointing the view).
