# ADR 0019: Broadcast the atomic command, not the op; a local inner API; complete on quiescence

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** —

Supersedes [ADR-0017](0017-broadcast-operations-focus-the-view.md): keeps that ADR's stance — every
filesystem action broadcasts through one shared, replayed timeline while the *view* focuses one
filesystem — but replaces the *granularity* and completion model that turned out wrong in practice.

## Context

ADR-0017 broadcast at the **op** level (each `write`/`read`/… a single sequence entry executed
per-FS by cursor). Building the UI on it exposed three failures tracing to that granularity:

1. **Read data had nowhere to go.** Broadcast decouples *issue* (append, returns synchronously) from
   *execute* (cursor-driven, later); a read's bytes are produced at execute time, but the coordinator
   discarded the executor's return, so `await fs.read(name)` could only hand back a descriptor and the
   raw handle layer ([ADR-0014](0014-console-fs-api.md)) was deleted. Mis-justified by "no free
   inspection", which was only ever about *timing* (a read must animate and cost sim time), never
   about withholding bytes.
2. **Multi-call console lines don't fit.** `(await getFiles()).forEach(({name}) => readFile(name))`
   either multiplies (N×N executions) or doesn't broadcast.
3. **Op-level broadcast interleaves the timeline** (`getFiles, write×10, read×10` instead of one line
   resolving fully, then the next).

The fix moves the broadcast boundary up to the **command** and stops equating completion with "the
JS returned": a command's enqueued animation must be accounted for either way, so unawaited reads
still cost sim time and play out.

## Decision

**The broadcast unit is one atomic command — a whole console input, a button command, or a churn
step — not an individual op.** Every command is potentially composite (`writeFile` = open+write+close;
a churn step may be a burst of reads), and **no command's ops may interleave with another's.** Two
queues: the **command queue** (the shared canonical `sequence[]` + per-session cursor, ADR-0016; a
churn step or an async user function plus its echoed label) and each session's **resolve queue** (its
player, [ADR-0009](0009-timed-playback-and-pacing.md)).

**Atomicity is contiguous ordering; completion is execution *quiescence* — not the function merely
returning, and not the resolve queue emptying.** A console input is wrapped into one async function
with the local API injected (`async (api) => { with (api) { <snippet> } }`); the coordinator runs
`await command(session.localApi)`. **The cursor advances only once that function has settled AND no
op it issued is still in flight** — an in-flight **counter**, `++` on issue, `--` on resolve.
Function-settle alone is insufficient whenever the snippet reaches the API through a call the wrapper
doesn't `await` (unawaited `m()`; `forEach(async f => …)` fire-and-forgets); the counter catches both.

**The catchable/uncatchable boundary is specifically whether a chain yields to the MACROTASK queue
between two API ops.** The quiescence re-check runs at a macrotask/tick boundary, *after* the
microtask cascade drains. A chain whose next API op is reached through **microtask** hops only
(contiguous API ops, or `await`s on synchronously-settling promises like `await Promise.resolve()`)
is **caught**: the cascade drains and lifts the counter before the re-check. What **escapes** is a
chain that yields to a **macrotask** (`setTimeout`, real I/O, `MessageChannel`, an un-instrumented
macrotask-backed helper) — it can sit at counter zero *across* the re-check, so its later ops land in
the next command's window. Same footgun bucket as `Math.random`; a properly-awaited generator script
is nowhere near it. **The re-check must never run synchronously at a decrement**, or a contiguous
chain's momentary counter-zero between two ops could misfire.

Quiescence is primarily an *execution*-level signal, not the resolve queue draining to zero (though
the gate's `pending < BACKLOG_CAP` term makes a backlog-filling command wait on animation drain). In
Race an inner op's promise resolves on the pacing gate (`simNs < raceClock && pending < BACKLOG_CAP`):
open ⇒ next microtask (effectively instant), blocked only when the clock or backlog closes it, so a
command quiesces as fast as its ops execute and the animation drains from the backlog behind it.
Waiting for the resolve queue itself to hit zero would frame-quantize sub-frame commands and
reintroduce the Race active-time bias. In Pace the await resolves on the cross-session op-rendezvous
(drain *and* join), so quiescence lands with the queue empty and in step with peers.

**A command runs per-session against a LOCAL inner API.** When session X's cursor reaches a command,
X runs the function with a scope whose `getFiles`/`readFile`/`fs.open`/… are bound to X's own paced
single-filesystem surface — they queue into X's resolve queue, animate, cost sim time, and **return
X's real data**. Broadcast happens once, at the command boundary; nothing inside broadcasts again
(typing at the prompt *is* the broadcast). The **focused** session's return value and journal are
what the console shows. So the raw handle layer is just ADR-0014's, used locally — **no
cross-filesystem handle proxy, no result-routing bridge.**

**Reads, `ls`, and every query broadcast, animate, cost sim time, and return real bytes.** "No free
inspection" constrains only *timing*; a genuine inspect-without-simulating surface stays deferred.

**Per-mode queue behavior — one mode-aware pacing primitive is the whole difference.** Each inner op
runs, jumps `simNs` synchronously (ADR-0009), enqueues its animation, then yields on a mode rule:

- **Pace** synchronizes across filesystems at **two levels, each a cross-session join** (no shared
  queue; each session has its own player):
  - *Op level, within a command:* each **awaited** inner op is a phase in a **dynamic-membership
    phased barrier ("phaser")**, so a 1000-read command stays locked read-by-read. Phase *k* releases
    when `arrived ⊇ active_set` (every session *still executing this command*), **not** a fixed
    snapshot: when a session reaches quiescence it **leaves the active set**, re-evaluating pending
    phases and releasing waiters. A session running *fewer* ops just drops out and unblocks the rest
    (a naive snapshot barrier would deadlock; the phaser is the fix). Fixed-count scripts are
    trivially 1:1; dynamic membership engages only for state-dependent scripts whose filesets diverge.
  - *Command level, at the boundary:* the coordinator awaits every session's quiescence (`Promise.all`,
    `lockstep.js`'s `paceStep`) before the next command. The guaranteed re-sync where churn steps and
    hand-issued commands line up; it **absorbs per-op-count divergence** (op-level can't pair 1:1
    forever when filesystems run slightly different op counts).

  A synchronous burst with no `await` has no op-level rendezvous, so it syncs only at the command
  boundary; an unawaited `forEach` still completes only at quiescence.
- **Race** meters **execution** against one shared `raceClock` (climbing `dt × scale` at finite speed,
  a fixed `NO_DELAY_STEP_NS` chunk at max, ADR-0016) and **gates at the low-level op, never the whole
  command**: each awaited inner op runs (jumping `simNs`) while `simNs < raceClock && pending <
  BACKLOG_CAP`, so a 1000-read command is throttled read-by-read on the same budget. **No cross-FS
  rendezvous — desynced by design; the animation is a cosmetic backlog draining at `scale` behind
  execution.** The cursor advances on quiescence, so each command stays atomic without any session
  waiting on another.

Because every session meters on the **same `raceClock`**, all accrue toward one budget: **equal
active time, divergent step counts**, the clock a closed-loop correction each tick. A long script
that `await`s its ops paces op-by-op on that clock; a purely **synchronous** burst (`for (i<10000)
writeFile()` no `await`) can't be paced mid-run (synchronous JS can't yield and the gate is only
consulted on `await`), so it **bypasses `BACKLOG_CAP`** — one atomic jump, tens of thousands of
events into the uncapped resolve queue, `simNs` vaulting past `raceClock`, then the session sits idle
`(simNs − raceClock)/scale` real-ms while the clock climbs back. Mitigation is UI-only: detect a
flooding command and fast-forward its animation (`viz.flush()`); the idle stall itself is an accepted
consequence. A properly-awaited script never triggers this.

**Determinism by construction** (an identical command must produce identical bytes on every
filesystem, without policing what the user types):

- **Console `writeFile(name, size)` content is a pure function of `(name, size)`** —
  `deterministicBytes(hash(name, size), size)`, keyed by the arguments, not a running stream, so a
  state-dependent script issuing a *different number* of writes per FS can't desync a shared
  draw-stream.
- **Random parameters** come from a **seeded poke PRNG kept separate from the churn generator**
  (ADR-0016). Known *at issue* (a button's random name/size, a churn burst's seek targets) ⇒ drawn
  once and **baked into the entry**. Drawn *at execution* (no-arg `writeFile()`) ⇒ a **per-command
  seed** is baked and each session seeds its own local generator (identical seed + call order ⇒
  identical draws; a count-divergent command's desync is contained, the next re-seeds).
- **`getFiles`/`ls` return entries sorted by name, enforced at the JS boundary for every driver**
  (`runner.list`/`names`/`openDir` return per-driver storage order); without it an order-sensitive
  command (`(await getFiles())[0]`) picks a different file per FS (false divergence). The sorted order
  is the *returned value*; the *animated* dir-scan stays in driver order (real device traffic, not a
  scripting input).
- A command written to diverge (`Math.random`, wall-clock) diverges. Accepted: an honest playground,
  not a footgun cage; our own API never plants the footgun.

**Friendly-API refinements (extending ADR-0014).** The 0014 shape holds; three deltas: (1) an omitted
`size` is now **random** (not 0014's stock default), drawn from the per-command generator; (2) content
is `deterministicBytes(hash(name, size))`; (3) friendly mutators accept a **descriptor or a name**
(`deleteFile(last)` and `deleteFile(last.name)` both work: `name = arg?.name ?? arg ?? <random>`).
The command compiles into a **per-session sandbox scope** so an undeclared loop var (`for (i=0; …)`)
stays session-local instead of leaking to a shared global where concurrent sessions stomp it. Plain
`with(api)` isn't enough (it only traps names the object *has*, so an undeclared `i` falls through);
the scope is a **Proxy whose `has` trap returns `true` for every name**, `set` capturing into a
per-session bag, `get` resolving `api → bag → globalThis` (the globalThis forward is mandatory or it
shadows `Math`/`JSON`). This forces a **sloppy** compile (`new AsyncFunction`, where `with` is legal);
`let`/`const`/`var` stay proper locals, only bare undeclared assignments are trapped.

**Completion sets the tape's lifecycle:** the coordinator marks a command's journal entry `live` on
start and `done` at quiescence — the `queued → live → done` states
([ADR-0018](0018-console-tape-and-scoreboard.md)) fall out of the execution seam. **Focus stays a
view property** (from ADR-0017): die, tape, telemetry, legend follow the focused session; switching
focus changes nothing and is not logged.

## Consequences

- The read-data dead-end and the cross-FS handle proxy both vanish: inner calls are local (return
  data), handles are ADR-0014's layer unchanged.
- **Race keeps a bounded backlog; only Pace drains to zero.** `BACKLOG_CAP` now bounds a command's
  animation lag by gating each **awaited** inner op — keeping the player backlogged is what lets the
  shared `raceClock` stay the closed-loop meter of active time at all speeds. Drain-to-zero in Race
  would frame-quantize sub-frame commands and under-accrue their sim time, breaking equal active time
  for cheap/read-heavy workloads. Caveat: the cap gates on `await`, so it does **not** bound a
  synchronous burst; every well-behaved (awaited) script is cap-bounded.
- Commands are now **async, long-running sequence entries** — a session is "busy" until quiescence,
  cursor parked. `runEntry`/`advance` and the Race loop become async (the 16ms synchronous while-loop
  becomes a per-session async drain loop woken by the clock tick and player drains). The local inner
  API must track its **in-flight op count**; the check is evaluated at a **tick/macrotask boundary**,
  never at a decrement. This is the real new cost, landing on the coordinator.
- **A runaway user command is recoverable unless it never yields to the macrotask queue.** Stop makes
  outstanding and subsequent inner-API awaits **hang (never settle), not reject** — a rejecting abort
  is defeated by `while(true){ try { await readFile() } catch {} }` (swallows the rejection, spins);
  a hanging abort **parks** that loop at its first post-Stop await. The gate-waiters, phaser promises,
  and counter-waiters are coordinator-level (*not* in `viz.queue`), so `viz.stop()`'s barrier
  force-resolve doesn't cover them — each needs its own hang path. **Unrecoverable:** a command that
  never yields to macrotask (synchronous `while(true)`, or microtask-only `while(true){ await
  Promise.resolve() }`) starves the single JS thread. Accepted; no per-command timeout.

## Alternatives considered

- **Op-level broadcast with a result-routing bridge** (ADR-0017 plus a wire for read bytes). Rejected:
  still needs cross-FS handle proxies and a multi-call line still multiplies or won't broadcast;
  moving the boundary to the command dissolves both.
- **Non-atomic, interleaved execution.** Rejected: an unreadable timeline; a command must resolve as a
  unit.
- **Drain the resolve queue to zero between every command in both modes.** Rejected: in Race it
  frame-quantizes sub-frame commands and under-accrues active time; queue-emptiness is a Pace-only
  property, atomicity only needs contiguous ordering.
- **Everything is a script, churn included.** Rejected: churn steps are auto-generated and don't need
  the async-function machinery that only user/button commands require.
