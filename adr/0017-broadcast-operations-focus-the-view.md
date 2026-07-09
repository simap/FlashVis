# ADR 0017: Multi-FS by default — every operation broadcasts through one timeline; the view focuses one FS

- **Status:** Superseded by [ADR-0019](0019-atomic-command-broadcast.md) — the broadcast/focus stance holds; the op-level granularity and completion model do not.
- **Date:** 2026-07-09
- **Deciders:** —

## Context

The lockstep coordinator ([ADR-0016](0016-lockstep-coordinator.md)) made it *possible* to run several
filesystems against one churn stream; this ADR makes that the product. FLASHVIS stops being a
single-filesystem dashboard you *switch* between and becomes a comparison instrument: every active
filesystem runs the same workload at once, and you *focus* one at a time to inspect it. Both drivers
are live from page load.

That reframing forces a consistency question the picker never had to answer. For the comparison to
mean anything, every filesystem must receive **identical** operations in an identical order. But Race
mode ([ADR-0016](0016-lockstep-coordinator.md)) *intentionally* desyncs their progress — the whole
point is to watch a cheaper-per-op driver pull ahead. So "apply this to all filesystems" cannot mean
"execute it on all N right now": right now they are at different points in the workload. We need a
model where an operation lands at the same *logical* point on every filesystem regardless of how far
apart their cursors have drifted — and a definition of what "switching filesystem" actually does.

## Decision

Every filesystem operation — mutations **and** queries alike (`write`, `delete`, `format`, `gc`,
`read`, `ls`, `stat`, `mkdir`) — is a **broadcast action appended to the single canonical `sequence[]`
at the frontier ("present"), and executed by each session when its own cursor reaches that index**.
This is exactly the sequence-plus-per-session-cursor machinery ([ADR-0016](0016-lockstep-coordinator.md))
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
([ADR-0018](0018-console-tape-and-scoreboard.md) turns the old "switched to X" log line into simply
re-pointing the view).

## Consequences

- **Replay is identical by construction.** "Run for a while, pause, hand-queue a few operations, run
  again" produces the same event stream on every filesystem — even the one you were *not* looking at
  when you queued them — because the operations live in the one shared sequence, not in N independent
  calls. This is the property that makes the whole comparison trustworthy.
- **Under Race, a focused follower shows appended operations as *pending*.** Its cursor hasn't reached
  the frontier yet, so an op you issue sits queued until the leader's progress pulls this filesystem
  forward to it. That is legible state, not breakage — [ADR-0018](0018-console-tape-and-scoreboard.md)
  gives it a visual language and a **"Catch up by switching to Pace mode"** escape hatch (Pace drains
  a laggard to present, reusing the Race→Pace reconciliation already built).
- **No free inspection.** Every `read`/`ls` consumes simulated flash time on every filesystem, and a
  genuine "just read FASTFFS out of band" is unavailable until the deferred side-channel exists. We
  accept this: the cost *is* the visualization.
- The manual-write byte content is generated once and broadcast identically (deriving from a seed, as
  churn already does per [ADR-0015](0015-session-manager-and-executor-seam.md)), so a hand-issued
  `write` is byte-comparable across filesystems just like a churn write.

## Alternatives considered

- **Execute a poke directly on all N sessions the moment it's issued.** Rejected: it breaks the
  instant Race desyncs — the sessions are at different points, so "now" means a different logical
  position on each, and identical ordering can't be guaranteed. The shared sequence is the only place
  consistency survives deliberate desync.
- **Split queries from mutations — answer `read`/`ls` only on the focused filesystem, off-timeline.**
  Rejected: it hides the device traffic that reads and scans exist to show, and an off-timeline query
  desyncs from the simulated clock. Reads are filesystem actions worth simulating and comparing, not
  a convenience shortcut.
