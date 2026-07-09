# ADR 0019: Broadcast the atomic command, not the op; a local inner API; complete on quiescence

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** —

Supersedes [ADR-0017](0017-broadcast-operations-focus-the-view.md): it keeps that ADR's stance —
every filesystem action is broadcast through one shared, replayed timeline while the *view* focuses
one filesystem — but replaces the *granularity* and completion model that turned out wrong in
practice.

## Context

[ADR-0017](0017-broadcast-operations-focus-the-view.md) broadcast at the **op** level: each
`write`/`read`/… became a single sequence entry, executed per-filesystem by cursor. Building the UI
on it exposed three failures that all trace to that granularity:

1. **Read data had nowhere to go.** Broadcast decouples *issue* (append to the sequence, returns
   synchronously) from *execute* (cursor-driven, later). A read's bytes are produced at execute time,
   but the coordinator discarded the executor's return — so `await fs.read(name)` could only hand back
   a descriptor, and the entire raw handle layer ([ADR-0014](0014-console-fs-api.md)'s `fs.open` /
   `file.read`) was deleted rather than reconciled. That deletion was mis-justified with ADR-0017's
   phrase "no free inspection", which was only ever about *timing* — a read must animate and cost sim
   time, not be a free instant peek — never about withholding bytes.
2. **Multi-call console lines don't fit op-level broadcast.** `let f = await getFiles(); f.forEach(({name}) => readFile(name))`
   either multiplies (if every inner call broadcasts, you get N×N executions) or doesn't broadcast at all.
3. **Op-level broadcast interleaves the timeline.** Two queued lines shuffle into
   `getFiles, write×10, read×10` instead of the first line resolving fully, then the second.

The fix is to move the broadcast boundary up to the **command**, and to stop equating completion with
*"the JavaScript returned"* — a command's enqueued animation must be accounted for either way, so the
unawaited reads still cost sim time and play out. Pace waits for that animation to fully drain; Race
meters it into a bounded backlog on the shared clock. Either way the `forEach`'s reads are never lost.

## Decision

**The broadcast unit is one atomic command — a whole console input, a button command, or a churn
step — not an individual filesystem op.** Every command is potentially composite: `writeFile` is
`open`+`write`+`close`, a churn step may be a burst of reads, and none of a command's ops may
interleave with another command's. There are two queues:

- **Command queue** — the shared canonical `sequence[]` with a per-session cursor
  ([ADR-0016](0016-lockstep-coordinator.md)). Heterogeneous atomic entries: churn steps, and user
  commands (an async function plus its echoed label). Broadcast appends one command at the frontier;
  every session replays it by cursor, so the timeline is identical on every filesystem.
- **Resolve queue** — each session's own player/animation-and-timing queue
  ([ADR-0009](0009-timed-playback-and-pacing.md)). A command's inner filesystem calls enqueue here.

**Atomicity is contiguous ordering; completion is execution *quiescence* — not the function merely
returning, and not the resolve queue emptying.** A console input is wrapped into one async command
function with the local API injected — conceptually `const command = async (api) => { with (api) {
<the snippet> } }` — and the coordinator runs `await command(session.localApi)`. The cursor advances
only once that function has settled **and** no filesystem op it issued is still in flight, where "in
flight" counts every promise the local inner API handed out that has not yet resolved (a counter: `++`
on issue, `--` on resolve). Function-settle *alone* is insufficient whenever the snippet reaches the
API through a call the wrapper doesn't `await`: in `async function m(){ await writeFile('a'); await
writeFile('b') }; m()` the wrapper calls `m()` **unawaited**, so `command` settles after only the
*first* write is issued; the second is issued when the first resolves, after settle. Same shape as
`(await getFiles()).forEach(async f => await writeFile() && await writeFile())`, where `forEach`
fire-and-forgets each async callback. The in-flight counter catches both — the command is not quiescent
until every such chain has run dry.

The catchable/uncatchable boundary is **not** attached-vs-detached, and it is **not** every non-API
hop — it is specifically whether a chain yields to the **macrotask** queue between two API ops. The
quiescence re-check runs at a macrotask/tick boundary, *after* the microtask cascade drains. So a chain
whose next API op is reached through **microtask** hops only — contiguous API ops, or plain `await`s on
synchronously-settling promises (`await Promise.resolve()`, `await 0`) — is **caught**: the whole
cascade, including the re-issued op, drains and lifts the counter before the re-check runs, however the
chain was dispatched. What escapes is a chain that yields to a **macrotask** between two API ops — a
`setTimeout`, real I/O, a `MessageChannel`, or an un-instrumented helper whose promise is
macrotask-backed — which can sit at counter zero *across* the re-check, so its later ops land in the
next command's window. That macrotask gap is the real footgun boundary, the same bucket as
`Math.random`, and a properly-awaited generator script (writes/deletes/reads, each `await`ed) is
nowhere near it. The re-check must never run synchronously at a decrement, or a contiguous chain's
momentary counter-zero between two ops could misfire.

Quiescence is primarily an *execution*-level signal, not the resolve queue draining to zero — though
the gate's `pending < BACKLOG_CAP` term does make a backlog-filling command wait on animation drain. In
Race an inner op's promise resolves on the pacing gate (`simNs < raceClock && pending < BACKLOG_CAP`):
when the gate is open it resolves on the next microtask — bounded only by how fast the code runs,
effectively instant — and it blocks *only* when the shared clock or the backlog closes it. So a command
quiesces as fast as its ops execute, the cursor advances without waiting for the die to catch up, and
the animation drains from the backlog behind it. Waiting instead for the *resolve queue itself* to hit
zero would frame-quantize sub-frame commands and reintroduce the Race active-time bias (see
Consequences); quiescence gives the same interleave-safety without that cost. In Pace the inner op's
await resolves on the cross-session op-rendezvous (drain *and* join), so a session's quiescence lands
with its own queue empty and in step with its peers — the fully-synced lockstep Pace wants.

**A command runs per-session against a *local* inner API.** When session X's cursor reaches a command,
X runs the async function with a scope whose `getFiles` / `readFile` / `fs.open` / … are bound to X's
own paced, single-filesystem surface — they queue into X's resolve queue, animate, cost sim time, and
**return X's real data**. Broadcast happens once, at the command boundary; nothing inside broadcasts
again. Typing at the prompt *is* the broadcast; the injected local scope makes everything inside
single-filesystem. The **focused** session's return value and journal are what the console shows. The
raw handle layer is therefore just [ADR-0014](0014-console-fs-api.md)'s, used locally — no
cross-filesystem handle proxy, no result-routing bridge.

**Reads, `ls`, and every query broadcast, animate, cost sim time, and return real bytes.** "No free
inspection" constrains only *timing* — a read is a simulated timeline event, not an out-of-band peek;
a genuine inspect-without-simulating surface stays deliberately deferred.

**Per-mode queue behavior — one mode-aware pacing primitive is the whole difference.** Each inner op
runs, jumps `simNs` synchronously ([ADR-0009](0009-timed-playback-and-pacing.md)), enqueues its
animation, and then yields on a rule that depends on the mode:

- **Pace** synchronizes across filesystems at **two levels**, each a cross-session *join* — there is no
  shared queue; every session has its own player, and the coordinator joins them.
  - *Op level, within a command:* each **awaited** inner op is a **phase** in a dynamic-membership
    phased barrier (a "phaser"), so a 1000-read command stays visually locked read-by-read across
    filesystems. Phase *k* releases when `arrived_at_k ⊇ active_set` — every session *still executing
    this command* has arrived — **not** when arrivals match a fixed snapshot. Membership is live: when a
    session's command reaches quiescence it **leaves the active set**, and that departure re-evaluates
    every pending phase, releasing anyone who was waiting on it. So a session that runs *fewer* ops just
    drops out and unblocks the longer-running ones — no deadlock (the naive snapshot barrier *would*
    deadlock here; the phaser is the fix). For a fixed-count script every session runs the same op count
    and the phaser is trivially 1:1; the dynamic membership engages only for state-dependent scripts
    whose filesets diverge, and degrades gracefully there.
  - *Command level, at the boundary:* the coordinator awaits every session's command quiescence
    (`Promise.all` over per-session completion, [lockstep.js](../web/src/lockstep.js)'s `paceStep`)
    before the next command issues. This is the guaranteed re-sync where churn steps and hand-issued
    commands line up, and it **absorbs per-op-count divergence**: when filesystems run slightly
    different op counts for the same command (a metadata read here, a different fileset there), op-level
    can't pair 1:1 forever, so the command boundary re-locks everyone.

  A synchronous burst that doesn't `await` has no op-level rendezvous point, so it syncs only at the
  command boundary; an unawaited `forEach` still counts as complete only once quiescence is reached.
- **Race** meters **execution** against one shared `raceClock` (sim-ns) — climbing by `dt × scale` at
  finite speed, by a fixed `NO_DELAY_STEP_NS` chunk at max speed ([ADR-0016](0016-lockstep-coordinator.md))
  — and gates at the **low-level op, never the whole command**: each awaited inner op runs (jumping
  `simNs`) while `simNs < raceClock && pending < BACKLOG_CAP`, so a 1000-read command is throttled
  read-by-read and every filesystem stays on the same simulated-time budget. There is **no**
  cross-filesystem rendezvous — Race is desynced by design; the animation is a cosmetic backlog draining
  at `scale` behind the execution. The per-session cursor advances on quiescence (function settled, no
  in-flight op), so each command stays atomic without any session waiting on another.

Because every session meters on the **same `raceClock`**, all accrue sim-time toward one shared
budget: **equal active time, divergent step counts** ([ADR-0016](0016-lockstep-coordinator.md)), and
the clock is a closed-loop correction applied each tick rather than an open-loop rate left to drift. A
cheap-per-op filesystem reaches the clock with *more* commands, an expensive one with *fewer*. A long
script that `await`s its ops (`for (const f of await getFiles()) await readFile(f.name)`) paces
op-by-op on that same clock, staying balanced with the other sessions rather than dumping its whole
sim-cost at once — the resolve queue doing the pacing a long command needs. A purely *synchronous*
burst (`for (i<10000) writeFile()` with no `await`) can't be paced mid-run — synchronous JS can't
yield, and the gate is only consulted on an `await`, so the burst **bypasses `BACKLOG_CAP` entirely**:
it executes as one atomic jump, pushing tens of thousands of events into the (uncapped) resolve queue
and vaulting `simNs` far past `raceClock`. That is negligible for the canonical small `forEach`, but for
a pathological huge one it is **not** a next-tick transient — the session then sits idle for
`(simNs − raceClock) / scale` real-ms (seconds to minutes at finite `scale`) while the clock climbs
back. Mitigation is a UI concern, not a model one: detect a single command flooding the queue and
fast-forward its animation (the existing `viz.flush()` path, [ADR-0014](0014-console-fs-api.md)) rather
than animate tens of thousands of ops — but note that only fixes the *animation* staleness; the
`simNs`-vs-`raceClock` idle stall itself is left as the accepted consequence, not repaired. A
properly-awaited script never triggers any of this.

**Determinism by construction.** The comparison requires that an identical command produce identical
bytes on every filesystem, without policing what the user types:

- **Console `writeFile(name, size)` content is a pure function of `(name, size)`** —
  `deterministicBytes(hash(name, size), size)`, a PRNG *keyed by the arguments*, not a running stream.
  A write is byte-identical on every filesystem regardless of history, so a state-dependent script that
  issues a *different number* of writes per filesystem can't desync a shared draw-stream and corrupt
  later independent writes.
- **Random parameters** come from a seeded poke PRNG kept separate from the churn generator
  ([ADR-0016](0016-lockstep-coordinator.md)), in two cases. A parameter known *at issue* (a button's
  random name/size, a churn burst's seek targets) is drawn once and **baked into the entry**. A
  parameter a *user command* draws *at execution* — a no-arg `writeFile()` picking a random name and
  size ([ADR-0014](0014-console-fs-api.md)) — can't be baked, so instead a **per-command seed** is baked
  into the entry and each session seeds its own local generator from it: identical seed + identical call
  order ⇒ identical draws on every filesystem, and a count-divergent command's desync is contained to
  that command (the next re-seeds). Either way a structurally identical command replays identical
  parameters everywhere.
- **`getFiles`/`ls` return entries sorted by name**, so iterating them is identical across filesystems
  whenever the filesets match — and legitimately diverges when they differ, which is the real
  filesystem difference worth seeing. This must be **enforced at the JS boundary for every driver**:
  `runner.list`/`names`/`openDir` return storage/insertion order, which differs per driver, so the sort
  is applied in the local inner API, not assumed from the driver. Without it an order-sensitive command
  (`(await getFiles())[0]`) would pick a different file per filesystem — a false divergence. The sorted
  order is the **returned value** a script iterates; the *animated* dir-scan (ADR-0014's streaming
  `lsStream`, which prints each entry as `dir.read()` yields it) stays in driver order — that physical
  scan order is real device traffic worth showing, and it's not a scripting input, so it needn't be
  sorted.
- A command written to diverge (`Math.random`, wall-clock) diverges. Accepted: the goal is an honest
  playground, not a footgun cage; our own API surface simply never plants the footgun.

**Friendly-API refinements (extending [ADR-0014](0014-console-fs-api.md) for the broadcast/determinism
model).** The 0014 shape holds — `writeFile(name?, size?) → {name, size}`, `readFile`/`deleteFile` →
`{name, size}`, `getFiles → [{name, size}]`, the `fs.` handle tier, `mkdir -p`, `prep`. Three deltas:
(1) an **omitted `size` is now random**, not 0014's stock default — `writeFile()` is fully random for
one-liner workload generation — drawn from the per-command generator above so it's identical across
filesystems; (2) write content is `deterministicBytes(hash(name, size))`, 0014's "random bytes,
data-agnostic" intent pinned to a reproducible keyed generator for cross-filesystem byte-comparability;
(3) the friendly mutators accept a **descriptor or a name** (`deleteFile(last)` and `deleteFile(last.name)`
both work — `name = arg?.name ?? arg ?? <random>`), so a script passes back the `{name, size}` a prior
call returned without destructuring, and `let last = await writeFile(); … deleteFile(last)` reads
naturally. The command is compiled into a **per-session sandbox scope** so an undeclared loop var (`for (i = 0;
…)`) stays session-local and deterministic instead of leaking to a shared global where concurrent
sessions would stomp it. A plain `with(api)` is *not* enough — `with` only traps names the object
*has*, so an undeclared `i` falls through to the global. The scope must be a Proxy whose **`has` trap
returns `true` for every name** (so nothing escapes to the global), with `set` capturing writes into a
per-session bag and `get` resolving `api` → bag → `globalThis` (the `globalThis` forward is mandatory,
or `has:()=>true` would shadow `Math`/`JSON`/…). This forces a **sloppy** compile (`new AsyncFunction`,
no module/strict, where `with` is legal); `let`/`const`/`var` declarations remain proper per-invocation
locals — only bare undeclared assignments are trapped. (A per-session iframe/realm is the heavier
alternative; compiling strict and requiring `let i` is the lighter one that rejects the sloppy
one-liner.)

**Completion sets the tape's lifecycle.** A command is now an async, long-running entry, so the
coordinator marks its journal entry `live` when the function starts and `done` when it reaches
quiescence — the tape's `queued → live → done` states
([ADR-0018](0018-console-tape-and-scoreboard.md)) fall directly out of the execution seam.

**Focus stays a view property** (retained from [ADR-0017](0017-broadcast-operations-focus-the-view.md)):
die, tape, telemetry, and legend follow the focused session; switching focus changes nothing and is
not logged.

## Consequences

- The read-data dead-end and the cross-filesystem handle proxy both vanish: inner calls are local, so
  they return data, and handles are the existing [ADR-0014](0014-console-fs-api.md) layer unchanged.
- **Race keeps a bounded backlog; only Pace drains to zero.** `BACKLOG_CAP` survives, now bounding a
  command's animation lag by gating each **awaited** inner op. Keeping the player backlogged is what
  lets the shared `raceClock` stay the closed-loop meter of active time at *all* speeds — its increment
  differs (`dt × scale` finite, `NO_DELAY_STEP_NS` at max) but the mechanism does not. Imposing
  drain-to-zero in Race would frame-quantize sub-frame commands — a cheap read animates in well under
  one frame, then the cursor idles a whole frame waiting for the next — systematically under-accruing
  their sim time and breaking equal active time for read-heavy or cheap-poke workloads. Drain-to-zero is
  strictly a Pace guarantee. Caveat: the cap gates on `await`, so it does **not** bound a *synchronous*
  burst (see the synchronous-burst note above); only awaited commands are cap-bounded, which is every
  well-behaved script.
- Commands are now **async, long-running sequence entries** — a session is "busy" for a command's
  duration, cursor parked until it reaches quiescence; Race meters a busy session's inner ops on the
  shared clock, a Pace barrier waits for every session's command to drain. `runEntry`/`advance` and the
  Race loop become async: the 16ms synchronous while-loop ([lockstep.js](../web/src/lockstep.js)'s
  `raceTick`) becomes a per-session async drain loop, woken by the clock tick and by player drains. The
  local inner API must track its **in-flight op count** (issue/resolve) so the coordinator can detect
  quiescence; the check is evaluated at a **tick/macrotask boundary** (after the microtask cascade
  drains), never synchronously at a decrement, so a contiguous chain's momentary counter-zero between
  two back-to-back ops cannot misfire. This is the real new cost, and it lands on the coordinator.
- **A runaway user command: recoverable unless it never yields to the macrotask queue.** Stop aborts by
  making outstanding and subsequent inner-API awaits **hang** (never settle) and having the coordinator
  **abandon** the in-flight command — release the phasers/gates it's parked in and re-baseline — rather
  than awaiting its quiescence. Crucially *hang, not reject*: a rejecting abort is defeated by
  `while(true){ try { await readFile() } catch {} }`, which swallows the rejection and re-issues into an
  unbounded microtask spin; a hanging abort instead **parks** that loop at its first post-Stop await, so
  Stop holds. Note this is beyond `viz.stop()` — the gate-waiters, phaser promises, and in-flight-counter
  waiters are coordinator-level, *not* in `viz.queue`, so `viz.stop()`'s barrier force-resolve
  ([ADR-0015](0015-session-manager-and-executor-seam.md)) doesn't cover them; each needs its own hang
  path. What stays **unrecoverable** is any command that never yields to the macrotask queue — a
  synchronous `while(true)` (no `await`), or a microtask-only spin (`while(true){ await Promise.resolve()
  }`) — which starves the single JS thread exactly as a synchronous loop does, Stop included. We accept
  that, and there is no per-command timeout.
- Phase-1's op-level `broadcast(op, args)` and `runPoke` fold into the *local inner API*; `broadcast`
  pivots to `(fn, label)` and `runEntry` gains the async pace/drain. The per-session journal
  ([ADR-0015](0015-session-manager-and-executor-seam.md)) and `pendingFor` survive.

## Alternatives considered

- **Op-level broadcast with a result-routing bridge** (the ADR-0017 attempt, plus a wire to hand a
  read's bytes back to the caller). Rejected: it still needs cross-filesystem handle proxies for the
  raw layer, and a multi-call console line either multiplies or won't broadcast. Moving the boundary
  to the command dissolves both.
- **Non-atomic, interleaved execution.** Rejected: a mixed, unreadable timeline
  (`getFiles, write×10, read×10`); the point is that a command resolves as a unit.
- **Drain the resolve queue to zero between every command in both modes.** Rejected: in Race it
  frame-quantizes sub-frame commands and systematically under-accrues their active time, breaking the
  "equal active time" invariant for cheap/read-heavy workloads. Atomicity only needs contiguous
  ordering, which a bounded backlog already gives; queue-emptiness is a Pace-only property.
- **Everything is a script, churn included.** Rejected: churn steps are auto-generated and
  deterministic — atomic command entries, yes, but they don't need the async-function machinery that
  only user/button commands require.
