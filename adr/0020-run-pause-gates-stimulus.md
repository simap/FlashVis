# ADR 0020: Run/Pause gates stimulus, not execution

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** —

## Context

ADR-0016 gave the lockstep coordinator one 16ms tick that, while `running`, generated the next
auto-workload step from the seeded sequence and advanced every session through it. At that point the
canonical sequence held exactly one kind of thing — churn `gc`/`event` steps — so a single `running`
flag gating the whole tick was correct by coincidence: the churn generator was the *only* source of
work, and pausing it paused everything there was to pause.

ADR-0019 changed that premise. A console line, a button press, and a boot script are now **commands** —
their own kind of sequence entry (`{kind:'command', fn, label, seed}`), appended at the frontier by
`broadcast()` and replayed atomically on every filesystem. That makes **two independent producers of
work**: the churn generator (the automatic background stimulus) and the console/buttons (hand-issued
stimulus). But both still flow through the one `running`-gated tick, so a command entry is only ever
*consumed* while `running` — even though `broadcast()` enqueues it immediately and unconditionally.

The result is a broken interaction model. The page boots with the auto-workload paused (the sane
default — you don't want churn hammering the die before you've looked at it), so the boot `help()` /
`format()` commands, and anything typed into the console afterward, land in the sequence and *sit
there*: queued, echoed to the tape, never executed. "I typed `writeFile()`, it showed in the log, and
nothing happened" is exactly this — the consumer is asleep because the churn producer is. Pausing the
background workload and pausing the machine that runs your commands are being treated as the same act,
and they are not.

## Decision

**Run/Pause/Step gate stimulus generation only. Execution is always-on. Speed is the sole execution
control.**

Concretely, we split the coordinator's single tick into a **producer** concern and a **consumer**
concern that were previously fused:

- **The churn generator is the producer Run/Pause/Step gate.** `running` (set by Run/Pause) and the
  manual `step()` nudge govern exactly one thing: whether the coordinator *generates and enqueues the
  next automatic `gc`/`event` step*. Paused means the background workload stops producing. `step()`
  produces exactly one auto-workload step. Nothing else keys off `running`.

- **Console lines and buttons are stimulus too, and they enqueue immediately.** `broadcast()` appends
  a command entry to the sequence the instant it's issued, regardless of `running` — it already did,
  and that stays. What's immediate is the *enqueue*, not the execution: a command takes its place in
  the one canonical queue like it always has, behind whatever is already ahead of it. It's enqueued
  stimulus, not a request to the run loop for permission — but it still runs when its turn comes, at
  Speed, not the instant it's typed.

- **The consumer runs always.** The coordinator's tick drains whatever is already in the sequence —
  command entries and any already-generated churn — every tick, whether or not `running`. It does
  *not* generate new churn when paused (that's the producer gate above), but it always executes what's
  present. So a command issued while "paused" is drained at Speed as soon as it reaches the front of
  the queue — which, if the queue was empty (the common paused case, since the auto-workload isn't
  producing), is right away. The dies are static only because no *automatic* stimulus is being
  produced, not because the machine is off.

- **Speed alone controls execution rate.** How fast enqueued work drains is governed entirely by the
  Speed scale (the sim-ns-per-real-ms the players animate at and, in Race, the rate `raceClock`
  advances). Run/Pause does not throttle execution; it only turns the automatic stimulus source on and
  off. There is exactly one execution-rate knob, and it is Speed.

This lands almost entirely as a consequence of ADR-0019's second producer; **ADR-0016's sequence,
per-session cursor, and Race/Pace scheduling math are unchanged.** The one place 0016's text needs a
footnote is the Race clock (below).

**Pace needs nothing special.** Pace paces on each session's own animation drain (`barrier()`) at the
Speed scale; it has no free-running clock. Letting `paceStep()` issue a command entry while `running`
is false — while declining to *generate* the next churn entry when the frontier is only reached by the
auto-workload — is the whole change. A paused Pace with a queued command animates that command at Speed
and then idles.

**Race needs one guard: the shared clock must not free-run while idle.** Race gates each op on
`simNs < raceClock`, and `raceClock` advances `dt × scale` every tick (ADR-0016). Today that's safe
only because the tick is skipped while paused. An always-on consumer would let `raceClock` climb during
any idle stretch (paused, or simply no work in flight), so the next command issued after that stretch
would find `simNs` far below `raceClock`, the gate wide open, and would execute as a **flat-out burst
instead of at Speed** — violating "Speed is the sole execution control." So: **`raceClock` advances
only on ticks that have work; while idle it re-baselines** (drops `lastTickNow`, exactly the mechanism
the pause path uses today at `if (!running) { lastTickNow = 0; }`, and the clamp `step()` already
applies keeping `raceClock` at/above every session's `simNs`). When a command then arrives,
`raceClock ≈ simNs`, and it paces op-by-op at Speed as intended. This is a refinement of 0016's "each
16ms tick, `raceClock` advances" — it advances each *non-idle* tick.

## Consequences

- The reported "console does nothing while paused" bug is gone by construction: consumption no longer
  depends on the churn producer being awake. Boot commands drain on load; a typed command drains as
  soon as it reaches the front of the queue (right away when the queue is empty), at Speed.
- "Paused" gets a clear, honest meaning: **no automatic stimulus is being produced.** The simulation
  is not off — poke it and it responds, animated at Speed. This is the intuitive reading of a pause
  button on a live system, and it's now the literal one.
- The change is contained: gate `ensure()`/`genStep` (the auto-workload producer) behind `running`,
  keep the consumer loop unconditional, and add the Race idle re-baseline. It is *not* a one-line
  guard delete — the Race clock guard is load-bearing, and getting it wrong reintroduces the burst —
  but it touches two spots in `lockstep.js`, not the model.
- Race's `raceClock` no longer strictly tracks wall-time-since-start; it tracks wall-time-since-start
  *minus idle*. That's correct for the comparison (idle time isn't flash time anyone spent) but means
  the clock is no longer readable as "how long has this been open." It never was a user-facing number,
  so this costs nothing but is worth stating.
- ADR-0016 keeps its wording except the one Race-clock footnote above; it is not superseded. The run
  semantics documented loosely in 0016's manager-wiring paragraph now live here, stated sharply.

## Alternatives considered

- **Leave Run/Pause gating the whole tick; tell users to press Run before using the console.**
  Rejected: it makes the console silently inert in the default boot state, which reads as broken, and
  it conflates "stop the background workload" with "stop the machine" — two things a user thinks of
  separately and controls with what they expect to be separate affordances.
- **A second flag — pause execution independently of stimulus.** Rejected as a knob nobody asked for:
  there is no coherent use for "keep generating churn but don't run it," and "don't run my typed
  command" is just not issuing it. Execution being unconditionally on is simpler and matches the mental
  model. Speed already covers "run it, but slowly."
- **Drain existing churn while paused, generating none (let the queue run dry, then idle).** This is
  effectively what falls out, but stated as a *rule about churn* it's the wrong framing — the point is
  not "finish the churn backlog," it's "commands are a separate producer that pause doesn't gate." We
  key the gate on the churn *generator*, not on draining a churn backlog, so a command jumping the
  (empty) auto-workload queue is the normal case, not an edge one.
- **Amend ADR-0016 or fold this into ADR-0019 instead of a new record.** Rejected: 0016's decision
  (the sequence/cursor/Race/Pace machinery) is genuinely unchanged and shouldn't be reopened, and 0019
  is about *what a broadcast unit is*, not *what the run controls mean*. The run-model shift deserves
  its own citable record.
