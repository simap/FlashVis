# ADR 0010: Port the FASTFFS churn model to JS for a target-live steady state

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Ben

## Context

The auto-workload was ad-hoc: random create/replace/delete against a hardcoded name pool
with no target, so it filled the FS monotonically until it threw out-of-space. FASTFFS already
ships a deterministic churn model (`benchmarks/churn_model/`) that drives toward a *target live
size* — a steady state — and backs its own benchmarks. We want the visualizer to (a) settle at
a steady state instead of overfilling, (b) be able to reproduce a FASTFFS benchmark run, and
(c) later feed the *identical* logical workload to several filesystems at once for lockstep
comparison. Reinventing a workload generator FASTFFS already validated would forfeit all three.

## Decision

Port the model to JS (`web/src/churn.js`). Keep the PRNG **and the event sequence byte-exact**:
the same LCG (`state = state*1664525 + 1013904223 mod 2^32`, via `Math.imul` + `>>> 0`) and the
same order of draws — weighted size-class, in-class size, ceiling/opportunistic delete checks,
replace-vs-create, live/delete slot selection, forced-large — so a given seed emits the exact
event stream the C model would. This is verified by a C-vs-JS parity harness that compares every
event field *and the post-draw PRNG state* per step; it matched on a 37-event config and a
1500-event steady-state config.

Everything above the PRNG is idiomatic JS — string enums (`CHURN_CLASS`, `CHURN_EVENT`), plain
event objects, a `ChurnModel` class — not a transliteration of the C structs. The default profile
matches the C verbatim (so the parity harness is meaningful); the live workload passes a
*device-scaled* profile (the 350 KiB "large" class doesn't fit a 256 KiB chip), which is exactly
how the C benchmark parameterizes itself for small devices. Byte-exactness lives in the model's
draw order, not in any one profile.

The workload (`workloadStep` in `playground.js`) drives the model toward a target live size with
slack headroom, applying each event to the FS then to the model so the two stay in lockstep; the
model resets on every format/granule change so it restarts from its seed against an empty chip.

## Consequences

- The workload reaches a steady state: default 96 KiB live target / 112 KiB ceiling on the
  256 KiB device; a 30,000-step run settled at ~111 KiB with `model.liveBytes == fsinfo.bytes`
  and no out-of-space errors.
- Byte-exact PRNG means the sim can reproduce a FASTFFS benchmark run, and — the reason it
  matters downstream — can feed every filesystem the identical logical workload, which is what
  makes the lockstep Race/Pace comparison ([ROADMAP](../ROADMAP.md)) meaningful rather than
  apples-to-oranges.
- Cost: the port is pinned to the C model's draw order. A change to the C sequence silently
  breaks parity — the parity harness is the guard, not the honor system. And the idiomatic split
  means the JS reads as JS, not as a line-for-line copy, so the two can't be diffed mechanically.

## Alternatives considered

- **Keep the ad-hoc JS workload, just add a target.** Rejected: reinvents a model FASTFFS
  already validated and forfeits benchmark reproducibility and cross-FS equivalence.
- **Compile `churn_model.c` to WASM and drive it from JS.** Rejected: adds a build step and
  pointer marshalling for a tiny deterministic generator, and makes the workload opaque to the
  console. A byte-exact JS port gets parity without either cost.

## Update — 2026-07-11: open-loop executor over the lockstep seam

Application moved from `workloadStep` in `playground.js` to the coordinator
([ADR-0016](0016-lockstep-coordinator.md)) plus `runChurnEvent` in `session.js`; the byte-exact
model is unchanged. That seam makes one constraint load-bearing: **the executor is open-loop** — it
issues exactly the oracle's events, with no FS-state-dependent branch (e.g. an `exists()` guard) or
added op, since either diverges one filesystem's issued stream from another's. Consequence: the
intentional over-capacity write (350 KiB class on a 256 KiB chip) can leave the oracle marking a
file live that a filesystem never stored, so a later delete logs "not found" — faithful, not a bug,
and fixed only *outside* the op-sequence (quiet the log, or correct the oracle's bookkeeping). An
`exists()`-guarded delete was tried and reverted.
