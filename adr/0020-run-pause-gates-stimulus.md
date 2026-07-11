# ADR 0020: Run/Pause gates stimulus, not execution

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** —

## Context

ADR-0016 gave the coordinator one 16ms tick that, while `running`, generated the next auto-workload
step and advanced every session. At that point the sequence held only churn `gc`/`event` steps, so a
single `running` flag gating the whole tick was correct *by coincidence*: the churn generator was the
only source of work. ADR-0019 changed that premise — a console line, a button, and a boot script are
now **commands**, appended at the frontier by `broadcast()` and replayed atomically. That makes **two
independent producers of work**: the churn generator (automatic stimulus) and the console/buttons
(hand-issued). But both still flow through the one `running`-gated tick, so a command is only
*consumed* while `running` even though `broadcast()` enqueues it immediately.

The result is broken: the page boots with the auto-workload paused (the sane default), so boot
`help()`/`format()` and anything typed afterward land in the sequence and *sit there* — queued,
echoed, never executed ("I typed `writeFile()`, it showed in the log, nothing happened"). Pausing the
background workload and pausing the machine that runs your commands are being treated as one act, and
they are not.

## Decision

**Run/Pause/Step gate stimulus generation only. Execution is always-on. Speed is the sole execution
control.** Split the coordinator's single tick into a producer concern and a consumer concern:

- **The churn generator is the producer gate.** `running` (Run/Pause) and the manual `step()` nudge
  govern exactly one thing: whether the coordinator *generates and enqueues the next automatic
  `gc`/`event` step*. `step()` produces exactly one. **Nothing else keys off `running`.**
- **Console lines and buttons enqueue immediately.** `broadcast()` appends a command the instant it's
  issued, regardless of `running` — but what's immediate is the *enqueue*, not the execution: it takes
  its place in the one canonical queue and runs when its turn comes, at Speed, not the instant typed.
- **The consumer runs always.** The tick drains whatever is in the sequence (commands + already-
  generated churn) every tick, paused or not; it just doesn't *generate* new churn when paused. So a
  command issued while "paused" drains at Speed as soon as it reaches the front — right away if the
  queue is empty (the common paused case). The dies are static only because no *automatic* stimulus is
  being produced, not because the machine is off.
- **Speed alone controls execution rate.** How fast enqueued work drains is entirely the Speed scale.
  Exactly one execution-rate knob.

**ADR-0016's sequence, per-session cursor, and Race/Pace scheduling math are unchanged**, save one
Race-clock footnote below.

**Pace needs nothing special** — it paces on each session's own animation drain (`barrier()`) at
Speed, no free-running clock. Letting `paceStep()` issue a queued command while `running` is false is
the whole change.

**Race needs one guard: the shared clock must not free-run while idle.** Race gates on `simNs <
raceClock`, and `raceClock` advances `dt × scale` every tick. An always-on consumer would let it climb
during any idle stretch, so the next command would find the gate wide open and execute as a **flat-out
burst instead of at Speed** — violating "Speed is the sole execution control." So **`raceClock`
advances only on ticks that have work; while idle it re-baselines** (drops `lastTickNow`, the same
mechanism the pause path uses, plus the clamp `step()` already applies keeping `raceClock` at/above
every session's `simNs`). When a command arrives, `raceClock ≈ simNs` and it paces op-by-op at Speed.

## Consequences

- The "console does nothing while paused" bug is gone by construction. "Paused" now means **no
  automatic stimulus is being produced** — the sim is not off; poke it and it responds at Speed, the
  intuitive reading of a pause button on a live system.
- Contained: gate `ensure()`/`genStep` behind `running`, keep the consumer loop unconditional, add the
  Race idle re-baseline. Not a one-line guard delete — the Race clock guard is load-bearing, and
  getting it wrong reintroduces the burst — but it touches two spots in `lockstep.js`, not the model.
- Race's `raceClock` now tracks wall-time-since-start *minus idle* (correct for the comparison: idle
  isn't flash time anyone spent), so it's no longer readable as "how long has this been open." It was
  never a user-facing number.
- ADR-0016 keeps its wording except the one Race-clock footnote; it is not superseded.

## Alternatives considered

- **Leave Run/Pause gating the whole tick; tell users to press Run first.** Rejected: makes the
  console silently inert on boot (reads as broken) and conflates "stop the background workload" with
  "stop the machine."
- **A second flag to pause execution independently of stimulus.** Rejected: no coherent use for "keep
  generating churn but don't run it"; Speed already covers "run it, but slowly."
- **Frame it as "drain the churn backlog while paused, generating none."** Rejected framing: the point
  is not finishing a churn backlog, it's that commands are a separate producer pause doesn't gate — so
  the gate keys on the churn *generator*, and a command jumping the empty queue is the normal case.
- **Amend ADR-0016 or fold into ADR-0019.** Rejected: 0016's machinery is genuinely unchanged, and
  0019 is about *what a broadcast unit is*, not *what the run controls mean*.
