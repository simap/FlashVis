# ADR 0017: Multi-FS by default — every operation broadcasts through one timeline; the view focuses one FS

- **Status:** Superseded by [ADR-0019](0019-atomic-command-broadcast.md) — the broadcast/focus stance holds; the op-level granularity and completion model do not.
- **Date:** 2026-07-09
- **Deciders:** —

> Superseded by [ADR-0019](0019-atomic-command-broadcast.md): building on op-level broadcast
> exposed three failures — a read's bytes had nowhere to go (the coordinator discarded the
> executor's return), a multi-call console line either multiplied N×N or didn't broadcast, and
> op-level entries interleaved two queued lines into an unreadable timeline. 0019 keeps this ADR's
> stance but moves the broadcast unit up from the op to the atomic command.

## Stance that still holds (carried into 0019)

- **Multi-FS by default.** FLASHVIS is a comparison instrument, not a single-FS dashboard you
  switch: every active filesystem runs the same workload at once, and you *focus* one to inspect it.
- **Every filesystem action broadcasts through one shared, replayed timeline** — appended to the
  canonical `sequence[]` at the frontier and executed per-session when each cursor reaches that
  index ([ADR-0016](0016-lockstep-coordinator.md)). Two filesystems consuming the same index are by
  construction fed the identical operation. This is what makes the comparison trustworthy even
  across Race's deliberate desync: execute-on-all-N-now cannot work, because "now" is a different
  logical position on each.
- **Reads/`ls`/queries are broadcast and simulated too**, never answered out-of-band: their device
  traffic is precisely what the tool visualizes, so they cost sim time. "No free inspection"
  constrains *timing* only; a true inspect-without-simulating side-channel stays deferred.
- **Focus is a pure view property**: the die, tape, telemetry, and legend follow the focused FS;
  switching focus changes no state, appends nothing to the sequence, and is not logged
  ([ADR-0018](0018-console-tape-and-scoreboard.md)).

The **op-level granularity and completion model** are what 0019 replaced; see there.
