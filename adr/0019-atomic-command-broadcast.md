# ADR 0019: Broadcast the atomic command, not the op; a local inner API; complete on quiescence

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** —

Supersedes [ADR-0017](0017-broadcast-operations-focus-the-view.md): keeps its one-timeline-broadcast +
focus-is-view stance, replaces the op-level granularity and completion model.

## Context

Op-level broadcast ([ADR-0017](0017-broadcast-operations-focus-the-view.md)) was too small a unit and equated completion
with "the JS returned": a read's bytes had nowhere to go (killing the raw handle layer), multi-call
console lines multiplied or didn't broadcast, and ops from different lines interleaved.

## Decision

- **Broadcast unit = one atomic COMMAND** (console input / button / churn step), not an op. A command is
  composite (`writeFile`=open+write+close) and **no command's ops interleave with another's.** Two queues:
  **command queue** = shared `sequence[]`+per-session cursor ([ADR-0016](0016-lockstep-coordinator.md));
  **resolve queue** = each session's own player ([ADR-0009](0009-timed-playback-and-pacing.md)).
- **Completion = execution QUIESCENCE = function settled AND in-flight-op counter (++issue/--resolve)
  at zero** — not "function returned" (misses ops issued by chains the wrapper doesn't `await`), not
  "resolve queue empty."
- **Quiescence re-check runs at a MACROTASK/tick boundary**, **never synchronously at a decrement** (a
  chain's momentary counter-zero between two ops would misfire). So microtask-chained ops are **caught**;
  a chain that yields to a macrotask between two ops sits at counter-zero across the re-check and
  **escapes into the next command's window** — accepted footgun, awaited scripts never hit it.
- **A command runs per-session against a LOCAL inner API returning THAT session's real data**, queued
  into its own resolve queue (animates, costs sim time). **Broadcast happens once, at the command
  boundary**; nothing inside re-broadcasts. Hence **no cross-FS handle proxy, no result-routing bridge** —
  the raw handle layer ([ADR-0014](0014-console-fs-api.md)) is reused locally.
- **Reads/`ls`/queries broadcast, animate, cost sim time, return real bytes.** "No free inspection" =
  timing only.
- **Pace** = two-level cross-session join: op-level **dynamic-membership phaser** (each awaited op a phase
  releasing when every session *still in this command* has arrived; a session reaching quiescence LEAVES
  the set and unblocks longer runners — a fixed-snapshot barrier would deadlock) + command-boundary
  `Promise.all` join. **Pace drains the resolve queue to zero.**
- **Race** = all sessions meter on one shared `raceClock`; each awaited op gates on `simNs < raceClock &&
  pending < BACKLOG_CAP`, **at the low-level op, not the whole command**; **no cross-FS rendezvous**
  (desynced by design; animation is a cosmetic backlog). Yields **equal active time, divergent step
  counts.** A purely SYNCHRONOUS burst can't yield, so it **bypasses `BACKLOG_CAP`** — one atomic jump
  vaulting `simNs` past `raceClock`, then an idle stall (mitigation UI-only; accepted).
- **Determinism by construction:** `writeFile` content = `deterministicBytes(hash(name,size))` (keyed by
  args, so a count-divergent script can't desync a shared draw-stream); random
  params from a **seeded poke PRNG separate from churn** — known-at-issue params baked into the entry,
  drawn-at-execution params via a per-command seed each session re-derives; **`getFiles`/`ls` sorted by
  name at the JS boundary** (drivers return storage order; the *animated* dir-scan stays driver order).
  A command written to diverge (`Math.random`) diverges — accepted.
- **Per-session sandbox scope** so undeclared vars stay session-local (not leaked to a shared global):
  a Proxy whose **`has` trap returns true for every name**, `set`→per-session bag, `get`→api→bag→
  `globalThis`; forces a **sloppy** compile (`with` legal), while `let`/`const`/`var` stay proper locals.
- **Friendly-API deltas vs [ADR-0014](0014-console-fs-api.md):** omitted `size` now random; content is `deterministicBytes(hash)`;
  mutators accept a descriptor OR a name.
- **Tape `queued → live → done`** ([ADR-0018](0018-console-tape-and-scoreboard.md)) falls out of the seam. **Focus stays a view property**
  (from [ADR-0017](0017-broadcast-operations-focus-the-view.md)): switching focus changes no state, isn't logged.

## Consequences

- New cost is the async coordinator: in-flight counter + macrotask-boundary quiescence + per-session
  async drain loops. **Race keeps a bounded backlog; only Pace drains to zero** — a backlogged player
  lets `raceClock` meter active time; drain-to-zero in Race would frame-quantize sub-frame commands.
- **Stop must HANG inner-API awaits, not reject** (a rejecting abort is swallowed by a `catch` loop and
  respins). Gate/phaser/counter waiters are coordinator-level (not in `viz.queue`), each needing its own
  hang path. **Unrecoverable only if the command never yields to the macrotask queue** (sync or
  microtask-only infinite loop); no per-command timeout.

## Alternatives considered

- **Op-level broadcast + result-routing bridge.** Rejected: still needs cross-FS handle proxies, and a
  multi-call line still multiplies.
- **Non-atomic interleaved execution.** Rejected: unreadable timeline.
- **Drain resolve queue to zero in both modes.** Rejected: frame-quantizes Race's sub-frame commands;
  queue-empty is a Pace-only property.
- **Everything is a script, churn included.** Rejected: churn is auto-generated and needs none of the
  async-function machinery.
