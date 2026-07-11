# ADR 0010: Port the FASTFFS churn model to JS for a target-live steady state

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

The ad-hoc auto-workload filled the FS monotonically until out-of-space. FASTFFS already ships a
deterministic churn model (`benchmarks/churn_model/`) driving toward a *target live size* (steady
state) that backs its own benchmarks. We want to (a) settle at a steady state, (b) reproduce a
FASTFFS benchmark run, and (c) later feed the *identical* logical workload to several filesystems at
once for lockstep comparison. Reinventing a validated generator forfeits all three.

## Decision

Port the model to JS (`web/src/churn.js`). **Keep the PRNG and the event sequence byte-exact:** the
same LCG (`state = state*1664525 + 1013904223 mod 2^32`, via `Math.imul` + `>>> 0`) and the same
order of draws (weighted size-class, in-class size, ceiling/opportunistic delete checks,
replace-vs-create, live/delete slot selection, forced-large), so a given seed emits the exact event
stream the C model would. Verified by a C-vs-JS parity harness comparing every event field *and the
post-draw PRNG state* per step (matched on a 37-event and a 1500-event config).

Everything above the PRNG is idiomatic JS (string enums, plain event objects, a `ChurnModel` class),
not a transliteration. The default profile matches the C verbatim (so the parity harness is
meaningful); the live workload passes a *device-scaled* profile (the 350 KiB "large" class doesn't
fit a 256 KiB chip), exactly how the C benchmark parameterizes for small devices. **Byte-exactness
lives in the draw order, not any one profile.** The workload drives toward a target live size with
slack headroom, applying each event to the FS then the model so both stay in lockstep; the model
resets on every format/granule change (restart from seed against an empty chip).

## Consequences

- Steady state: default 96 KiB live target / 112 KiB ceiling on the 256 KiB device; a 30,000-step
  run settled at ~111 KiB with `model.liveBytes == fsinfo.bytes` and no out-of-space.
- Byte-exact PRNG lets the sim reproduce a FASTFFS benchmark run and feed every filesystem the
  identical logical workload, which is what makes the lockstep Race/Pace comparison meaningful.
- Cost: pinned to the C model's draw order. A change to the C sequence silently breaks parity; the
  parity harness is the guard. The idiomatic split means the two can't be diffed mechanically.

## Alternatives considered

- **Keep the ad-hoc workload, just add a target.** Rejected: reinvents a validated model and
  forfeits benchmark reproducibility and cross-FS equivalence.
- **Compile `churn_model.c` to WASM and drive it from JS.** Rejected: a build step and pointer
  marshalling for a tiny deterministic generator, and it makes the workload opaque to the console.

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
