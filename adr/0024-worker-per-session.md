# ADR 0024: One worker per session, with coarse sync interfaces sized to the marshalling cost

- **Status:** Proposed (drafted from the workers spike; pending specialist review pass)
- **Date:** 2026-07-12
- **Deciders:** —

Amends ADR-0019: the Pace op-level phaser's mechanism is replaced by a speed-scaled
simNs-chunk barrier — sub-op-fine at slow speeds, coarse at high — so the visible op-by-op
cross-FS pacing survives where it is perceptible; the command-atomic broadcast, quiescence
model, and tape lifecycle stand.

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

The decision is **worker per session** (not one shared worker), and the goal ordering matters:
**total simulation throughput first** — N drivers on N cores; serializing five on one thread is
the real ceiling — **main-thread jank second** (the tens-of-ms pauses were tolerable on their
own). Worker per session fixes both, and the layout matches the product's mental model — N
independent chips racing. The consequence accepted with it: every cross-session rendezvous
(Race metering, Pace stepping) now spans threads, so cross-thread traffic must be sized so that
synchronization and marshalling stay off the per-op path — while pacing granularity itself must
stay **sub-op-fine at slow speeds**, where watching ops interleave across filesystems is the
product.

## Decision

**Worker per session; time crosses the thread boundary as speed-scaled simNs chunks, so the
rendezvous is exactly as fine as the current speed makes visible.**

- **The clock is released in chunks; sequence issuance keeps its ADR-0016 semantics.** Two grant
  kinds cross the boundary. *Sequence issuance:* the coordinator (main) stays the sole sequence
  authority — Pace issues the one shared entry to every worker (cursors move together); Race
  lets each worker consume entries at its own cursor. *Time release:* the coordinator releases
  sim-time in rounds of Δ sim-ns as a **per-session absolute watermark, not one shared clock**,
  and releases round n+1 only when every participant has acked round n. Each grant message is
  `{watermark, scale, epoch}` — "run up to this point in time at this speed": the worker's gate
  is today's `raceGateOpen` ("run while simNs < watermark"), evaluated worker-side with one op of
  overshoot tolerance, and the worker carries no other pacing state. **Δ is tuned to messaging
  overhead, SPEED scale, and the target frame cadence — Δ ≈ scale / target-FPS: ~50 µs of sim
  per chunk at 333× slow-mo, ~150 ms at 10× real-time — so coordination overhead per real second
  stays roughly constant at every speed.** **Watermarks are derived, never accumulated:** the
  coordinator keeps a per-session `baseline` (internal bookkeeping, never sent) and computes each
  round as `watermark_s = baseline_s + rel`, `rel = max over sessions of (acked simNs_s −
  baseline_s) + Δ`, with Δ and scale taken at release time — never `watermark += Δ`. An
  accumulated watermark leaks stale grant: one 70 µs read against a 150 ms high-speed chunk
  leaves ~150 ms of open gate that a switch to 333× slow-mo turns into ~50 real seconds where the
  barrier binds nothing. Deriving from acked `simNs` revokes unconsumed time for free — the acks
  are the proof nobody spent it, and overshoot tolerance covers an op started against the old
  watermark — holds "no session runs more than one chunk ahead" against *consumed* time by
  construction, and subsumes ADR-0020's idle re-baseline at the grant layer: with no consumption
  the watermark stays pinned at consumption + Δ however many trivial no-work acks fire, so the
  ADR-0020 burst bug cannot re-enter through this protocol. `max`, not `min`: a laggard keeps
  headroom to close its gap while the leader gates after exactly Δ; `min` would let one stalled
  worker pin everyone — that strictness is Pace's step join, not the clock. **The baseline is
  what lets one protocol serve both modes, and it moves only at coordinator-decided boundaries.**
  *Race:* all baselines equal the common origin (reset / mode-switch reseat), so every watermark
  is the same number — the shared equal-active-time clock, overshoot debts repaid against
  cumulative time. *Pace:* cumulative `simNs` diverges by design (same ops, different costs), so
  a shared absolute clock would never bind the cheaper sessions — and would resolve their awaited
  ops instantly; instead **baselines rebase at each step join, per issued sequence entry (churn
  event, gc step, and command alike), from that session's STEP ack's `simNs` — never from chunk
  acks**, which feed only the `max` derivation (rebasing per chunk would erase the very drift the
  barrier bounds, and a chunk ack is mid-flight anyway). The rebase is exact, not approximate, by
  the **ack-quiescence invariant**: a Pace session accrues no sim time between its step ack and
  the next issue (the ack IS quiescence), so the step ack's `simNs` equals the next step's true
  start — an invariant the concurrency suite must assert (sim time moving between ack and issue
  means an op leaked outside any step). A step-tail overshoot dies at the join (baselines rebase;
  the cumulative cost is already in `simNs`), where Race debt persists — each mode's correct
  semantics. **Every grant carries the scale it was computed with, and a chunk is metered wholly
  at its release scale**, so a SPEED change synchronizes with the grant stream (it takes effect
  on the next release, ≤ one frame) instead of racing it on a side channel, and catch-up needs no
  new mechanics: fast-forwarding a laggard (mode reseat, late join) is just a range granted at a
  higher scale.
  The property that matters: at slow speeds the
  chunk is far smaller than an op, so cross-FS pacing stays sub-op-fine exactly where it is
  visible; the rendezvous coarsens only at high speeds, where per-op interleaving is imperceptible
  anyway. Acks carry `simNs`/`fileOpCount`, so the 16 ms rate sampler and the waiting/stalled pins
  read main-side grant bookkeeping and mirrored counters, never a cross-thread query on a hot
  path. A Pace step ack fires when the entry has executed AND its metered playback drained —
  ADR-0009's drain-to-zero, now worker-side. No SharedArrayBuffer required (see Alternatives for
  what it would cost).
- **Commands stay atomic at the command level** (ADR-0019): a console line ships as **source**
  (closures don't cross postMessage), compiles and runs worker-side against the local inner API,
  returns its result and per-op log lines in one reply. Quiescence detection moves inside the
  worker unchanged — `session.runCommand`'s in-flight counter + macrotask-boundary re-check
  relocates with session.js, and the command's ack IS its quiescence. **A command's awaited ops
  resolve as released chunks cover their simulated time, so a console-pasted micro-benchmark
  paces both across filesystems and over real time at any SPEED** — atomicity (no interleaving
  of two commands' ops) stands.
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
- **Timed playback (ADR-0009) becomes worker-side metering.** The scale reaches a worker on each
  time grant, never as a separate message that could race the grant stream; a worker spends
  real-time budget × the grant's scale advancing its sim, so pacing/`await fs.op()` resolves
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

## Protocol (normative)

The concrete contract binding coordinator (main) and workers. Where the prose above and this
section disagree, this section wins; prose reconciliation is tracked in the review checklist.

**Two clocks per session.** *Execution* (device `simNs`; vaults on a synchronous WASM call) and
*playback* (the metered replay position). **The protocol's currency is the playback clock** —
limits, acks, baselines, awaited-op resolution, standings. Execution appears only in telemetry.
Every message carries `epoch`; mismatch ⇒ discard, and a bump voids the worker's held limits,
scale, entries, prep flag, and any suspended-metering state — the session rebuilds in the new
epoch. UI pull cursors from the old epoch are void too: re-attach with `newest`. Entry indexes
and journal/event ids are **consecutive** and monotonic within an epoch.

**One control loop: `grant`/`grantAck`.** Entries are instruction feed, not control; all UI data
rides `pull`/`frame`. Steady-state traffic is O(1) messages per session per frame regardless of
op rate, and the worker holds no state about what the UI has seen.

**Main → worker**

- `init {epoch, fsId, geometry, name}` — worker builds runner + device + player + heat + journal
  and viz-event rings (`JOURNAL_MAX` ≥ the 400 lines the tape renders) locally.
- `entries {epoch, [{index, kind: churn|gc|command, payload, seed}]}` — incremental append,
  consecutive monotonic indexes; commands ship as source. Pure prefetch: shipping authorizes
  nothing. Race: window ahead of each cursor, refilled from acked cursors; Pace: the frontier
  advances one entry per join. **Window size is a deferred tuning knob — correctness never
  depends on it:** exhaustion acks immediately (see grantAck), so an undersized window costs at
  most a round-trip of idle — simNs simply doesn't advance for a few frames, accounting
  unaffected. Size later by measurement: marshalling overhead vs the achievable no-delay
  multiplier.
- `grant {epoch, round, entryLimit, playLimitNs, scale}` — the whole control plane; per session,
  frame cadence. "Execute entries `index < entryLimit`; play back up to `playLimitNs` at
  `scale`." `round` is a monotonic grant id for ack matching and stale-ack discard. `playLimitNs`
  is derived, never accumulated: `playLimitNs_s = baseline_s + rel`,
  `rel = max_s(ackedPlayback_s − baseline_s) + Δ`, Δ and scale taken at release, clamped ≥ that
  session's last acked position; round n+1 releases only when every current participant acked
  round n. **Rounds run continuously at frame cadence: a grant is always sent, degenerating to a
  no-op (limits unchanged) when there is nothing new to authorize — the loop controls how much
  is granted, never whether; neither side ever detaches.** `entryLimit` — Pace: shared index + 1
  for due sessions (a session already past it
  gets its own cursor); Race: the shipped frontier. No-delay Δ is finite, sized to drain-paced
  playback throughput.
- `pull {epoch, heat?, wear?, liveMap:{since}?, journal:{since, limit, newest}?, events:{since,
  limit}?}` — once per rAF, for each session the UI currently renders: today the focused die
  (full pull); a compare view pulls several sessions heat/wear/liveMap-only. **Focus = which
  workers the UI pulls and what it asks for; no focus message exists.**
- `reset {epoch'}` — voids all in-flight state on both sides; awaits hang, never reject.
- No stop, pause, or speed message exists. **The UI's Run/Stop gates the churn generator only
  (ADR-0020)** — grants keep flowing (no-op when idle) and a typed command executes at Speed
  while "stopped." Pace naturally idles when no entries arrive; Race spends the idle letting
  laggards catch up (intentional; a speed = 0 "freeze time" is a possible later option). The
  generator produces entries on demand — when the lead session's window needs them. **Reset is a
  halt**: the coordinator lets the in-flight round's acks land (≤ one frame — grants are
  granular, nothing needs interrupting), then bumps the epoch; in-flight awaits need no explicit
  hang mechanism — they starve, since their epoch never receives another grant, and the session
  rebuilds in the new epoch. SPEED rides only on `grant.scale`, so it cannot race the grant
  stream. Terminate is `worker.terminate()` after the teardown settle, not a message.

**Worker → main**

- `grantAck {epoch, round, playbackNs, cursor, entriesDrained, drainedCounters}` — **every grant
  is acked on receipt**, even with zero progress (an idle ack reports the parked position), then
  re-acked at frame cadence while playback advances, on reaching either limit (`playLimitNs`, or
  `entryLimit` — window exhaustion acks immediately), and at quiescence; idempotent per round,
  coordinator keeps the per-session max. Diagnostic invariant: activity in a no-op grant's ack
  is a bug or a leaky abstraction spilling somewhere. Per-round acks also mean the CS pin /
  status-dot data (spec/ui.md) is fresh every round. `cursor` = entries executed (drives window
  refill and bounds execution skew); `entriesDrained` = highest index executed AND tape-drained.
  **The Pace join = every session reporting `entriesDrained ≥ shared index`**, and the rebase
  reads that ack's `playbackNs` — ack-quiescence: that position must not move again before the
  next `entryLimit` raise (escape-free steps; an ADR-0019 escaped op's charges land in the next
  frame via the rebase). `drainedCounters` (fileOpCount, flash time — as of the last
  fully-drained op tape) feed the scoreboard, rate sampler, and ms/op; never execution numbers.
  In Race, `entriesDrained` is bookkeeping only and baseline-inert.
- `frame {epoch, heat (~8 KB, full state), shown+wear (~2.3 KB), liveMap+version (1 KB snapshot,
  only if its version > the pull's `since`), journal[], events[], journalHead, eventHead}` — reply to
  `pull`, returning everything played up to the instant it is served (events land in the frame
  they play; boundary case: an event playing after this frame's pull lands in the next — the
  same frame-boundary paint cadence as the in-process rAF loop). Journal and viz events are
  **append-only logs with monotonic ids**, served by `since`/`limit`/`newest` from the
  worker-side rings; best case a handful cross, worst case `limit` newest. Heat is full-state,
  so the first pull after a focus switch IS the snap repaint. Heat decay computes closed-form at
  bump/pull time (no worker rAF).
- Journal event format: `{jid, entryIndex, kind: started|op|done|gc|crash, text, costNs?,
  flashOps?}`. Tape status is a **fold over immutable events** per `entryIndex`: 'queued' stays
  main-side (broadcast time), 'live' folds from `started`, 'done' carries result + cost summary;
  gc lines gray by kind (ADR-0023). Nothing is updated in place.
- Viz events (erase sweep, command lifecycle): same ring/id pattern, frame-batched — numerous at
  full speed but never op-tape-scale (the heat field already coalesced those by construction).
- Log ids are consecutive per epoch, so a gap is arithmetically detectable (first returned id >
  `since`+1 ⇒ ring eviction — reachable whenever pulls stop while the worker runs, e.g. a
  backgrounded tab; the UI may render a break marker). `newest:true` ignores `since` and returns
  the newest `limit` items plus current heads — the **(re)attach mode**: a focus switch, tab
  re-foreground, or epoch bump pulls journal `{newest, limit: 400}` and events
  `{newest, limit: 0}` (head pointer only — stale sweeps are never replayed); continuous pulls
  use `since`.
- liveMap versioning is **execution-granular** — the finest that exists: WASM is synchronous, so
  FS state changes atomically at op execution; during an op-tape's playback the state already
  holds the post-op result, and past states are not walkable. Dirty = any program/erase executed
  since the last walk, observed at the device (FS-agnostic, the ADR-0011 wear pattern). The
  worker walks lazily on pull — dirty AND ≥ ~250 ms since the last walk (the walk is real work,
  ADR-0008) — and the version stamps the walk, not the mutation. Consequence (ADR-0009's
  standing contract, bound now larger): the liveness tint is execution-current while the glow is
  the paced replay, so the tint leads the glow by up to the execution-skew bound (`TAPE_CAP` +
  one sync burst) — minutes of real time at deep slow-mo. Any remedy is UI-side deferral, not
  protocol.
- `telemetry {epoch, fsinfo, livenessCounts, execution fileOpCount, execution simNs}` — scalars
  only (liveMap rides `pull`); ~250 ms, **unconditional: it doubles as the liveness heartbeat.** k
  missed periods ⇒ presumed wedged/crashed → console-tape line, with k·250 ms sized well above a
  legal synchronous macrotask burst; `worker.onerror` short-circuits the same line. No recovery.

**Worker-side gating** (all local; nothing crosses a thread on the per-op path)

- The player is ADR-0007/0009's timed player relocated, and remains the sole source of visible
  delay: it meters playback at real-time budget × `grant.scale`, **continuous intra-event**
  (a 21 ms erase holds across frames), capped at `playLimitNs`; overshoot is the sub-frame
  budget remainder. In steady state the limit leads the meter (Δ ≈ one frame of sim at the
  current scale), so pacing feel is identical to in-process; the limit binds only when a session
  would outrun its siblings. ADR-0022's drain pacing relocates into this meter.
- Execution proceeds while: `index < entryLimit`, the awaited op's resolution is covered by
  playback (the ADR-0009 barrier), `pendingOps < BACKLOG_CAP`, and
  `executedTapeNs − playbackNs < TAPE_CAP` (sim-time cap). A synchronous burst may vault the
  caps within one macrotask — accepted (ADR-0019). Shipped-but-unexecuted entries count toward
  no cap.

**prep (ADR-0014) in protocol terms**

- `prep(true)`/`prep(false)` are ordinary broadcast entries. `prep(true)` takes effect
  per-session at its sequence position — no entry sync; sessions enter prep as their cursors
  arrive. **Only the exit is a join**: the coordinator holds `entryLimit` at the `prep(false)`
  index until every session's `entriesDrained` reaches it, because the clear + reseat must land
  at one shared entry (reseat mechanics; a momentary join even in Race). Playback is one FIFO
  replay, so entering prep flushes whatever remains of that session's own pre-bracket tape; a
  session's execution reaches `prep(true)` only after its backlog drains below `TAPE_CAP` at
  Speed — so the exit join waits on the slowest session's drain (minutes at deep slow-mo;
  accepted, the SPEED slider is the remedy).
- While set, the worker plays tape instantly (`playbackNs ≡ executedTapeNs`; metering, drain
  pacing, and await-pacing suspended — user-invoked semantics, not a perf lever; no ADR-0022
  conflict). Journal events carry a prep flag, rendered distinct like gc lines. Measurement
  never stops: ops log real costs, device stats accrue, wear counts.
- **Executing `prep(false)` zeroes the session's displayed counters (flash time, fileOpCount) at
  the exit join, and the coordinator reseats baselines there** — every session restarts from
  zero at the same entry, so Race's displayed totals stay level and exactly mirror what the gate
  enforces. A tape line records the clearing; the ADR-0023 ledger holds window-style (sum the
  lines since the last clear boundary). Named change vs in-process: Race no longer repays
  prep-cost divergence with bonus workload (the old clamp behavior) — prep is a start line, not
  a debt.

**Baselines** (coordinator-internal, never sent)

- Race: common origin (reset / mode-switch reseat) ⇒ all `playLimitNs` equal — the shared
  equal-active-time clock; overshoot debt persists.
- Pace: rebase per entry from the ack that first reports it drained; heartbeats never rebase. A
  not-due session at a reseat: baseline := its acked playbackNs at the switch.

**Control flow, one line each**

- New work: enqueue is immediate, paused or not — a command lands at the frontier of the entries
  stream, the same index for every session; it becomes runnable when `entryLimit` covers it —
  Pace at the next join (usually responsive), Race when each session's cursor reaches its index
  (a backlogged FS sees the identical sequence); the derived `playLimitNs` means no banked time,
  so execution starts at Speed.
- Speed change: next grant carries the new scale; consumed time keeps its old rate, the
  remainder plays at the new one; effective ≤ one frame (heartbeats keep acks flowing).
- Focus switch: the UI repoints its per-frame `pull`, sending `since` = what it already holds;
  no worker state, no replay.
- Teardown: re-evaluate the round predicate AND the Pace join predicate against current
  membership → discard stragglers by (epoch, round, sessionId) → terminate.
- Worker crash: telemetry goes silent or onerror fires → tape line; the sim wedges; reload.

## Consequences

- The 13.5 ms compaction stall leaves the main thread entirely, and five drivers use five cores;
  main-thread cost becomes rendering the focused die + pulled snapshots, independent of op rate.
- Race/Pace correctness now rests on grant/ack protocols across threads; the concurrency suite is
  the safety net (see the acceptance gate above), and every stop/abort/reject path must be re-proven
  with an op in flight on another thread.
- Teardown becomes a two-sided handshake: a `setSessions` removal must settle that session's
  outstanding grant acks (else a Pace round's `Promise.all` hangs and wedges the coordinator —
  ADR-0016's barrier-hang in grant form) before terminating the worker.
- The dynamic-membership op-level phaser is retired in favor of the chunk barrier — **this
  amends ADR-0019's mechanism, not its visible behavior where it matters**: at slow-mo the chunk
  (microseconds of sim time) is far finer than an op, so the mid-command, op-by-op cross-FS
  lockstep the phaser bought remains visible; only at high speed does the rendezvous coarsen to
  chunk granularity, where per-op interleaving was already imperceptible. Step-boundary state is
  unaffected, and the tape's command-granular `queued → live → done` lifecycle (ADR-0018)
  survives untouched: it keys off broadcast ('queued'), issue ('live'), and ack ('done') — the
  same boundaries it already used, observed over the wire instead of in-process.
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
- **SharedArrayBuffer rings/Atomics as the baseline:** works, and would let workers self-pace
  with zero message overhead — but SAB requires cross-origin isolation: `COOP: same-origin` +
  `COEP` headers on EVERY host (the dev server and any static/prod host — header-less static
  hosts need service-worker shims), every cross-origin subresource must opt in via CORS/CORP
  (the page's Google-Fonts load breaks without `crossorigin` or self-hosting), and the isolated
  page can no longer interact with cross-origin popups/embeds. The chunk design needs none of
  it, and its messaging overhead is held constant by construction (Δ ≈ scale / target-FPS);
  kept strictly as a later optimization if measured chunk-ack latency ever bites — and priced up
  by the hosting constraint (ADR-0025): on GitHub Pages SAB needs a service-worker header shim,
  and since the shim can't guarantee isolation (hard refresh bypasses the SW; first visits and
  embeds load without it), the chunk protocol must remain as fallback — SAB would be a second
  parallel implementation, not a replacement.
