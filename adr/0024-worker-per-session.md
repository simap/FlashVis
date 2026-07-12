# ADR 0024: One worker per session, with coarse sync interfaces sized to the marshalling cost

- **Status:** Proposed (drafted from the workers spike; pending specialist review pass)
- **Date:** 2026-07-12
- **Deciders:** —

Amends ADR-0019: retires the Pace op-level phaser (rendezvous coarsens to the step boundary);
the command-atomic broadcast, quiescence model, and tape lifecycle stand.

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
thread as it happens — costs ~0.33 µs/event to marshal, so a compaction-scale burst spends ~12–14 ms
serializing (measured: 40.5 k events structured-clone in 13.7 ms): **as much as executing it**.
Fine-grained streaming merely relocates the stall.

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
  cross-thread query; the worker self-meters inside its grant (Race semantics are unchanged —
  "run while simNs < R" is today's `raceGateOpen`, evaluated worker-side; overshoot stays one op)
  and reports `simNs`/`fileOpCount` in the ack, so the 16 ms rate sampler and the per-frame
  waiting/stalled pins read main-side grant bookkeeping and mirrored counters, never a cross-thread
  query on a hot path. A Pace ack fires when the entry has executed AND its metered playback
  drained — ADR-0009's drain-to-zero, now worker-side. No SharedArrayBuffer required (kept as an
  optimization option, accepting COOP/COEP if ever taken).
- **Commands stay atomic at the command level** (ADR-0019): a console line ships as **source**
  (closures don't cross postMessage), compiles and runs worker-side against the local inner API,
  returns its result and per-op log lines in one reply. Quiescence detection moves inside the
  worker unchanged — `session.runCommand`'s in-flight counter + macrotask-boundary re-check
  relocates with session.js, and the command's ack IS its quiescence.
- **The heat field moves into the worker; the main thread pulls, it is not pushed.** Each worker
  runs its session's glow accumulation (`readHeat`/`progHeat` bump + decay — the ADR-0022
  representation) against granted time. The main thread renders the **focused** die by pulling the
  heat arrays once per frame: two Float32Arrays over 1024 pages = ~4 KB each, ~8 KB/frame
  (~0.5 MB/s at 60 fps); the die's fill/wear state (`shown` + `wear`, ~2.3 KB) rides the same pull.
  The pull is O(geometry), never O(ops) — it costs the same whether the frame covered 10 ops or a
  36.5 k-event compaction. Unfocused dies stream nothing and cost nothing — an improvement over
  today, where a hidden die keeps its full rAF loop running (`setActive` only toggles a CSS class);
  their heat stays warm worker-side and a focus switch pulls full state for a snap repaint. This
  **complies with the ADR-0022 veto by construction**: every op still contributes its full glow —
  what changed is where the accumulation runs, not what is counted. The erase sweep and command
  lifecycle transitions still stream individually — rare, meaningful per event. Tape op-lines are
  NOT rare (thousands/second at no-delay): the journal lives worker-side, only the **focused**
  session streams appends (the UI already ignores unfocused journal events — `onSessionJournal`
  returns early for them), batched onto grant acks, and a focus switch bulk-pulls the last 400
  lines (all the tape ever renders).
- **Timed playback (ADR-0009) becomes worker-side metering.** The SPEED scale ships to workers;
  a worker spends real-time budget × scale advancing its sim, so pacing/`await fs.op()` resolves
  against the worker's own clock instead of a main-thread animation queue drain. The main thread
  keeps only rendering.
- **Telemetry is a periodic push** (~250 ms: fsinfo, livenessCounts, fileOpCount, simNs), matching
  the scoreboard's existing cadence; the live map (1 KB at current geometry) crosses only for the
  FOCUSED session when dirty — the die's liveness tint needs it at its existing 250 ms
  `refreshLiveness` cadence, not just the inspector.
- **Staged behind a flag.** The backend selects via the existing `globalThis.__flashvisBackend`
  seam; the in-process implementation remains the fallback. **Acceptance gate:** the flag does not
  default on until `scripts/lockstep-concurrency-test.mjs` — every scenario: exactly-once dispatch,
  busy-locks, abort/reject recovery, the Pace→Race reseat, holding/stalled/waiting, teardown —
  runs green against the worker backend, including its cross-FS byte-identity assertions. The
  suite already parameterizes its coordinator (`FV_LOCKSTEP`) and the UI its backend
  (`__flashvisBackend`); extending it to the worker backend is part of this work, not follow-up.

## Consequences

- The 13.5 ms compaction stall leaves the main thread entirely, and five drivers use five cores;
  main-thread cost becomes rendering the focused die + pulled snapshots, independent of op rate.
- Race/Pace correctness now rests on grant/ack protocols across threads; the concurrency suite is
  the safety net (see the acceptance gate above), and every stop/abort/reject path must be re-proven
  with an op in flight on another thread.
- Teardown becomes a two-sided handshake: a `setSessions` removal must settle that session's
  outstanding grant acks (else a Pace round's `Promise.all` hangs and wedges the coordinator —
  ADR-0016's barrier-hang in grant form) before terminating the worker.
- Pace's rendezvous coarsens from per-op to per-step — **this amends ADR-0019**: the
  dynamic-membership op-level phaser is retired, and sessions within one step are no longer
  op-interleaved in real time. Step-boundary state — the comparison the product makes — is
  unaffected, and the tape's command-granular `queued → live → done` lifecycle (ADR-0018) survives
  untouched: it keys off broadcast ('queued'), grant ('live'), and ack ('done') — the same
  boundaries it already used, observed over the wire instead of in-process.
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
