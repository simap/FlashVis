# Lane T2 report — concurrency-suite conversion (ADR-0024)

Worktree: `/Users/benh/git/flashvis-test-concurrency`, branch `lane/test-concurrency`.

## Outcome

`scripts/lockstep-concurrency-test.mjs` is rewritten to drive the worker
protocol (`web/src/protocol.js`) over `scripts/mock-worker-transport.mjs`,
against a new reference worker host (`scripts/ref-worker-host.mjs`) that wraps
the real `session.js`/`runner.js`/real WASM. It runs green:

```
node scripts/lockstep-concurrency-test.mjs   # PASS, ~0.25s
```

**5 of the old suite's scenario slots are converted, each mutation-proven.
11 are deferred with a documented reason** (not stubbed to vacuous — see
below). This is a narrower cut than the full 16-scenario BOUND priority list;
scope ballooned exactly where the brief predicted it would (the long tail),
plus one earlier stop I did not anticipate: **scenarios 1-3's own concept
doesn't survive the architecture change**, so "converting" them meant
designing their replacement from the ADR text, not translating line-by-line.
Reporting now per the BOUND instruction rather than pushing further into the
long tail un-checked-in.

## Why old scenarios 1-3 aren't "the same scenario" anymore

The old bug class was two *different JS call paths* (`paceStep`/`raceTick`/
`step()`) racing on **shared coordinator state** to dispatch the same
`sequence[i]` twice. ADR-0024 makes that specific hazard architecturally
impossible at the coordinator (I9: "no per-op wire" — a worker executes its
own entries serially, alone, and commands compile from source *inside* the
worker so there's no shared closure two coordinator code paths could race on
in the first place). So old scenarios 1/2/3 (race→pace flip mid-drain,
step()-vs-raceTick, step()-vs-paceStep) don't have a literal analog — the code
paths they exercised don't exist in the new shape.

The hazard **moves** to: can two *messages* (e.g. an overlapping `GRANT`
arriving while a worker's dispatch loop is already mid-command) cause the
*worker* to spawn a second concurrent dispatch loop and double-execute an
entry? That's `scripts/lockstep-concurrency-test.mjs` scenario **[1]**, and
it's the direct, protocol-faithful descendant of the old "busy-map" invariant
— just worker-local instead of coordinator-shared. Mutation-proven (below).

## Scenario mapping (OLD -> NEW)

| # | OLD (in-process, closure counter) | NEW (this suite) | Status |
|---|---|---|---|
| 1-3 | busy-map exclusion across race/pace call-path races; `dispatches` closure counter | **[1]** exactly-once dispatch under an overlapping `GRANT` round; dispatch counted from the worker's own `W2C.FRAME.journal` (pulled via `C2W.PULL`), corroborated by `drainedCounters` | **Converted** (redesigned; see above) |
| — | (not covered — old suite had no explicit round-barrier test) | **[4]** grant/ack round barrier: round+1 never settles until every session acks round *r* (I2) | **New, converted** (§13 requires it) |
| — | (not covered) | **[2]** a re-sent grant with unchanged limits does no work (I10); a duplicated `ENTRIES` resend for the same index does not re-execute it | **New, converted** (§13 requires it) |
| 16(b) | bare `reset()` abandons a parked command; zombie's next op must HANG, not run on the fresh chip | **[3]** `reset()` bumps epoch; a mid-flight round starves (I5); the zombie's post-gate op never lands on the freshly-reformatted chip (implemented via a `pace.before/after` hook that never resolves once epoch has moved — the wire-appropriate re-expression of the old suite's abort-token hang) | **Converted** |
| 8(c) | `setSessions` removal mid-command is a guarded no-op; survivor not wedged | **[5]** teardown drains a straggler: `dropSession` removes it from the round barrier immediately; its late ack lands quietly; no message crosses a `terminate()`d port | **Converted** |
| 1 (mode-flip), 2 (step-vs-raceTick), 3 (step-vs-pacestep), 1b (realistic smoke) | — | superseded by **[1]** per above | Converted (redesigned) |
| 4 | rejecting command (throwing journal subscriber) releases the lock, recovers | — | **Deferred** — needs lane/coord's real command-reject/rewind path; the wire contract doesn't define a "reject" signal distinct from a normal command settling, so faithfully forcing this requires the real coordinator's retry logic, not a guess |
| 5 | `stop()` aborts a non-command churn step in its barrier window (FIX B) | — | **Deferred** — "barrier window" and "stop()" are coordinator-internal concepts (churn-step timing inside a Pace round) not expressed in protocol.js; needs lane/coord |
| 6 | `stop()` aborts a command mid-drain, resumes cleanly | — | **Deferred** — same reason as 5 |
| 7 | Pace->Race `raceClock` reseat = min(simNs) | — | **Deferred** — Race/Pace mode *semantics* (§3: baseline rebase rules, entryLimit computation) are coordinator logic, not wire; protocol.js only carries the already-computed `entryLimit`/`playLimitNs`/`scale` outputs. Testing the reseat *algebra* requires lane/coord's real mode-switch implementation. See "seam" below. |
| 8 | `reset()` byte-for-byte reproducibility; `setSessions` cursor cleanup | partially: **[5]** covers the cleanup-on-removal half | **Reproducibility half deferred** — blocked on the missing file-byte-read wire message (see Protocol ambiguity, below); cannot assert byte-for-byte without it |
| 9 | `opsPerSec` tracks workload ops, never flash ops | — | **Deferred** — `opsPerSec` is a coordinator-computed UI/snapshot value, not a protocol field; needs lane/coord's real snapshot API |
| 10 | Race `stalled` | — | **Deferred** — `stalled` is coordinator-computed from `raceClock`/`simNs` internals not on the wire; needs lane/coord |
| 11 | Pace `holding` | — | **Deferred** — same reason as 10 |
| 12-13 | `waiting` (Race/Pace) | — | **Deferred** — same reason as 10 |
| 14-15 | `waiting` FALSE while animating (Pace/Race) | — | **Deferred** — same reason as 10; also depends on the real player/viz pacing model, which `ref-worker-host.mjs` deliberately does not implement (see its banner) |
| 16 | `reset()` abandons a mid-flight round (3 sub-cases: btnReset flow, bare reset, race quiescence-window) | (a) is superseded by **[3]**; (b)/(c) not attempted | **(a) converted via [3]; (b)/(c) deferred** — need the real coordinator's race-mode quiescence timing |
| CE (command-error-test.mjs) | throwing command op doesn't leak unhandledRejection | — | **Out of scope** — separate file (`scripts/command-error-test.mjs`), not assigned to this lane; untouched |

## The seam

There is **no `FV_COORDINATOR` seam**. Deliberately: this suite plays the
coordinator role directly against the wire rather than guess lane/coord's
future JS method surface (`setMode`/`broadcast`/`snapshots`/`waitStates`/...
are coordinator-internal API, never specified by protocol.js — only the wire
messages are frozen and knowable). Writing against a guessed API risks either
silently diverging from what lane/coord ships, or "stubbing so heavily the
assertion becomes vacuous" (the brief's own phrase) if I re-implemented
Pace/Race mode logic myself to make the guessed API self-consistent — that
would test *my* reimplementation, not lane/coord's. This is exactly why 7,
9-15, and 16(b)/(c) are deferred rather than faked: they are, in the ADR's own
terms, **mode/coordinator semantics** (§3), not wire semantics (§2/§4), and I
don't own the coordinator.

There **is** an `FV_WORKER_HOST` seam
(`scripts/worker-harness.mjs`, defaults to `scripts/ref-worker-host.mjs`).
Swap in lane/worker's real worker host once it lands and exports the same
`attachWorkerHost(workerPort)` shape — one env var, no test rewrite. The
reference host wraps the *real* `session.js`/`runner.js` (real WASM); its
banner documents the one deliberate simplification: `playbackNs` is modeled
as `device.stats.simNs` rather than the real paced player/viz clock (§6),
which is why it's sufficient for exactly-once/round-barrier/epoch-discard
mechanics but not for the Pace/Race stall/holding/waiting UI signals.

**Recommendation for the lead**: once lane/coord's real coordinator exists, a
follow-up pass should decide whether it exposes a snapshot/mode API this
suite can seam onto (an `FV_COORDINATOR`-style hook), or whether scenarios
7/9-15 stay as lane/coord's own test responsibility (its JS API, its tests).
I did not want to make that call unilaterally by inventing the shape now.

## Protocol ambiguity — flagging, not editing (STOP per brief)

**`protocol.js` has no message that returns raw file bytes.** `C2W.PULL` /
`W2C.FRAME` cover heat, wear, liveMap, journal, events — never a file's
content. The OLD suite's *other* primary correctness check throughout nearly
every scenario was `assertCrossFsIdentical`/`fileMapsEqual` (byte-for-byte
read-back comparison, both cross-FS and vs. a clean reference run). Under the
frozen wire contract as it stands, **that check cannot be re-expressed** — the
only in-band signals available are `drainedCounters` (fileOpCount,
flashTimeNs — a cost proxy, not content) and the journal (line-level log, not
bytes).

I did not add a field or message to work around this — protocol.js says
"Treat FROZEN; ambiguity => STOP and ask me, don't edit it." This blocks:
old scenario 8's reproducibility half (byte-for-byte run-1-vs-run-2), and
weakens every scenario that would otherwise corroborate with byte-identity
(this suite's converted scenarios lean on `drainedCounters` alone for that
reason, matching what protocol.js actually offers).

**Question for the lead**: is a `pull.file?{name}` (or similar) addition to
`C2W.PULL`/`W2C.FRAME` in scope, or is byte-for-byte verification intentionally
out of the worker-per-session product surface (e.g. because cross-FS
comparison becomes a build/CI-only concern via a different channel)? This is
the single highest-leverage open question — it unblocks old scenario 8 and
strengthens 1-3's replacement everywhere.

## Mutation evidence (this suite proves its own assertions aren't vacuous)

Run via `FV_REF_HOST_NO_GUARD=1` / `FV_REF_HOST_NO_DEDUP=1` — inline mutation
toggles in `scripts/ref-worker-host.mjs` (documented there; it's test
infrastructure, not production, so an inline flag is fine — mirrors the old
suite's `FV_LOCKSTEP`-pointed scratch-copy pattern without needing a second
file, since I own this whole module).

| Mutation | Result |
|---|---|
| `FV_REF_HOST_NO_GUARD=1` (removes the per-epoch re-entrancy guard around the worker's dispatch loop) | scenario **[1] FAILs**: `fastffs`/`littlefs` each dispatch 2x under the overlapping grant, final dispatch count 3x, `drainedCounters` diverges 3x from the clean reference (fileOpCount 6 vs 2). Also destabilizes **[5]** (cursor overruns to 2) — the guard is load-bearing beyond just scenario 1. |
| `FV_REF_HOST_NO_DEDUP=1` (removes index-based de-duplication on `ENTRIES` resend) | scenario **[2]**'s added check **FAILs**: entries[0] executes 2x off a duplicated `ENTRIES` resend, cursor overruns to 2 |

Every other scenario ([2]'s no-op-grant half, [3], [4]) is a direct assertion
on protocol-level behavior (I2/I5/I10/§8) with no separate mutation needed —
the assertion IS the guard (e.g. [4] literally asserts the barrier promise
hasn't settled yet, which fails immediately if the barrier logic is wrong).

## Files

- `scripts/lockstep-concurrency-test.mjs` — rewritten (owned deliverable)
- `scripts/worker-harness.mjs` — new: rig helpers, the `FV_WORKER_HOST` seam, no coordinator API surface (see "seam")
- `scripts/ref-worker-host.mjs` — new: reference worker host wrapping real `session.js` over the wire; the `FV_WORKER_HOST` default

None of `web/src/*` was touched. `fs/fastffs` and `fs/littlefs` submodules
were initialized and `dist/fastffs.mjs`/`dist/littlefs.mjs` built locally to
run the suite (both gitignored; not part of the commit).

## Open questions (2)

1. **Protocol**: should `C2W.PULL`/`W2C.FRAME` gain a raw-file-bytes pull, or
   is byte-for-byte cross-FS verification intentionally out of scope for the
   wire? (blocks old scenario 8's reproducibility half, and would strengthen
   1-3's replacement's corroboration everywhere else). See "Protocol
   ambiguity" above.
2. **Seam**: once lane/coord's real coordinator lands, should this suite gain
   an `FV_COORDINATOR` seam onto its snapshot/mode API for scenarios 7/9-15,
   or do those stay lane/coord's own test responsibility? See
   "Recommendation for the lead" above.
