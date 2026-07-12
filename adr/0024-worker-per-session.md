# ADR 0024: One worker per session, with coarse sync interfaces sized to the marshalling cost

- **Status:** Proposed (drafted from the workers spike; pending specialist review pass)
- **Date:** 2026-07-12
- **Deciders:** —

## Context

Five filesystems now run in lockstep, and the workers spike measured the main thread as the
binding constraint: execution cost scales perfectly linearly with session count (28.8 µs per
session·step at N=2 and N=5 alike — pure pile-up on one thread), and the worst single operation
is a **13.5 ms LittleFS compaction inside ONE synchronous WASM call** (36 501 device callbacks)
that no main-thread scheduling can split. ADR-0022 decoupled *render* cost from op count; the
*execution* stall was never addressed and multiplies with N.

Two structural facts shape the split. First, a session's device emulator shares an address space
with its WASM module (the HAL writes into `HEAPU8` synchronously mid-call), so the only clean cut
moves the **whole session — runner + device — into the worker**; ADR-0005's "JS owns the device"
survives as JS-in-a-worker. Second, the naive alternative — stream every device event to the main
thread as it happens — costs ~0.33 µs/event to marshal, so a 36.5 k-event burst spends ~13.7 ms
serializing: **as much as executing it**. Fine-grained streaming merely relocates the stall.

The decision is **worker per session** (not one shared worker): each filesystem gets its own core,
so one driver's compaction never delays another's progress, and the layout matches the product's
mental model — N independent chips racing. The consequence accepted with it: every cross-session
rendezvous (Race metering, Pace stepping) now spans threads, so the interfaces must be **coarse**,
sized so that synchronization and marshalling stay off the per-op path.

## Decision

**Worker per session; every cross-thread interface is chunk-granular, never op-granular.**

- **Grant-based scheduling replaces per-op gating.** The coordinator (main) stays the sole
  sequence authority (ADR-0016) and issues **work grants**: in Pace, "run sequence entry k" to
  every worker, joining on completion acks (the rendezvous moves from the per-op animation
  barrier to the step boundary); in Race, "run until your simNs reaches R" — a released batch of
  race-clock ns — re-granted per tick. The hot `simNs < raceClock` read disappears as a
  cross-thread query; the worker self-meters inside its grant and reports simNs in the ack. No
  SharedArrayBuffer required (kept as an optimization option, accepting COOP/COEP if ever taken).
- **Commands stay atomic at the command level** (ADR-0019): a console line ships as **source**,
  compiles and runs worker-side against the local inner API, returns its result and per-op log
  lines in one reply. Quiescence detection moves inside the worker, where the call chain lives.
- **The heat field moves into the worker; the main thread pulls, it is not pushed.** Each worker
  runs its session's glow accumulation (`readHeat`/`progHeat` bump + decay — the ADR-0022
  representation) against granted time. The main thread renders the **focused** die by pulling the
  heat arrays once per frame (two Float32Arrays, ~8 KB each at current geometry — trivially
  cheaper than event streams, and O(geometry), not O(ops)). Unfocused dies stream nothing;
  their heat state stays warm worker-side and is simply pulled again on focus. This **complies
  with the ADR-0022 veto by construction**: every op still contributes its full glow — what
  changed is where the accumulation runs, not what is counted. Low-frequency theatrical events
  (the erase sweep, tape op-lines, command lifecycle) still stream individually — they are rare
  and carry meaning per event.
- **Timed playback (ADR-0009) becomes worker-side metering.** The SPEED scale ships to workers;
  a worker spends real-time budget × scale advancing its sim, so pacing/`await fs.op()` resolves
  against the worker's own clock instead of a main-thread animation queue drain. The main thread
  keeps only rendering.
- **Telemetry is a periodic push** (~250 ms: fsinfo, livenessCounts, fileOpCount, simNs), matching
  the scoreboard's existing cadence; the live map crosses only when the inspector is open and dirty.
- **Staged behind a flag.** The backend selects via the existing `globalThis.__flashvisBackend`
  seam; the in-process implementation remains the fallback until the worker backend passes the
  extended concurrency suite.

## Consequences

- The 13.5 ms compaction stall leaves the main thread entirely, and five drivers use five cores;
  main-thread cost becomes rendering the focused die + pulled snapshots, independent of op rate.
- Race/Pace correctness now rests on grant/ack protocols across threads. The invariants guarded by
  `scripts/lockstep-concurrency-test.mjs` (exactly-once, busy-locks, teardown, mode switches) must
  be re-proven against the worker backend — extending that suite is part of the work, not optional.
- Teardown becomes a two-sided handshake (resolve main-side waiters, then terminate the worker) —
  the ADR-0016 hang risk in cross-thread form.
- Pace's rendezvous coarsens from per-op to per-step: sessions within one step are no longer
  op-interleaved in real time. Die images at step boundaries — the comparison the product makes —
  are unaffected.
- The tape's `queued → live → done` lifecycle (ADR-0018) keys off grant/ack + command replies
  instead of main-thread execution observation.
- Determinism is preserved by construction: one coordinator-owned sequence, events shipped whole,
  command source compiled per-worker with the per-command seed (ADR-0019).

## Alternatives considered

- **One shared worker for all sessions** (the spike's effort-ranked first move): same main-thread
  relief, much simpler rendezvous — but serializes all drivers on one core, so the slowest driver
  still stalls the rest, and it forecloses the per-core scaling this product will keep leaning on
  as drivers are added. Rejected as the end state; its simplicity is inherited anyway by starting
  from grant-based coarse interfaces.
- **Per-op event streaming to a main-thread viz** (the minimal split): measured marshalling makes
  bursts as expensive as execution; rejected.
- **Time-slicing on the main thread:** the worst op is one WASM call with no interior yield point;
  measured ineffective; rejected.
- **SharedArrayBuffer rings/Atomics as the baseline:** works, but drags COOP/COEP onto the dev
  server and any static host for a cost the grant/pull design avoids; kept as an optimization,
  not a dependency.
