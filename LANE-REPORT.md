# Lane C (coordinator + clock algebra) — ADR-0024 report

Scope delivered: the coordinator now drives sessions over the **protocol.js wire**
(async grant/ack via a session-proxy on a Port) instead of synchronous device/runner
calls. §2 clock-release algebra implemented; Race + Pace bound per §3; holding/stalled/
waiting derived from ack state. Verified by my own suite against mock workers over the
faithful transport.

## Deliverables (all on branch `lane/coord`)

- `web/src/lockstep.js` — rewritten coordinator (owned).
- `web/src/session-proxy.js` — NEW coordinator-side wire adapter (owned).
- `scripts/mock-worker.mjs` — NEW faithful mock session worker (honours the §2 gate).
- `scripts/coord-wire-test.mjs` — NEW suite (`npm run test:coordwire`), 8 groups, all green:
  handshake/epoch (I5), Race divergence + level playback + round barrier (I2), Race
  command drain (I1), Pace lockstep + join, Pace command + holding, Pace→Race reseat
  burst, grant-continuity + derived-not-accumulated (I10/I4), reset epoch discard (I5).
- `package.json` — added `test:coordwire` (additive one line).

Untouched (per lane boundary): session.js, viz.js, playground.js, device.js, runner.js,
protocol.js, mock-worker-transport.mjs.

## What changed at the seam

Old load-bearing breakage removed: the Race gate `s.device.stats.simNs < raceClock`
and the synchronous `advanceSync` while-loop. Both are now the §2 grant/ack model:
the coordinator DERIVES `playLimitNs` every round (`rel = MAX_s(acked_s − baseline_s) +
chunk`, clamp `≥ acked_s`), a round advances only when every session has acked it
(barrier, I2), and a grant is sent every frame (no-op when idle, I10). `simNs` is now
telemetry-only; `playbackNs` is the currency the gate keys on. Cursors, entriesDrained,
fileOpCount all arrive over `grantAck`; fsinfo/liveness over `telemetry`.

---

## C↔V CONTRACT DIFF (coordinator public API — what playground.js must change)

The method NAMES are all preserved (setSessions, setGcRatio, setMode/get mode, setSpeed,
start, stop/get running, step, reset, broadcast, pendingFor, snapshots, waitStates), plus
a test-only `_tick` and `get epoch`. Forced changes:

1. **`setSessions(list)` takes session-PROXIES, not in-process sessions.** Each element
   is `createSessionProxy(port, { fsId, name, geometry })` (new module). The coordinator
   `init()`s new proxies. **Playground must** create the worker + transport, build the
   proxy, and pass proxies. (In the real app: `new Worker()` → `createSessionProxy(worker,
   …)`; the worker host runs session.js behind protocol.js.)

2. **`broadcast(payload, label)` — first arg is serializable SOURCE, not a live `fn`.**
   A closure cannot cross the worker boundary (I7: commands ship as source, compiled
   worker-side with the per-command seed). The returned object no longer carries
   `journalEntries`; **the tape (queued→live→done) is now worker-owned** and read via
   pull/frame (§7), not flipped by the coordinator. Playground's console/button layer
   must emit source text and move tape rendering onto pull data.

3. **`snapshots().wa` is `null`.** TelemetryMsg (§4) carries `fsinfo{files,bytes}`,
   `livenessCounts`, `exec_fileOpCount`, `exec_simNs` — but NOT `programBytes`/`hostBytes`,
   so write-amplification is not derivable over the current wire. Needs a telemetry field
   or a pull. Everything else in the snapshot shape is preserved and populated from acks/
   telemetry. `fileOpCount` now comes from `grantAck.drainedCounters.fileOpCount`.

4. **`stop()` no longer aborts an in-flight command.** Per §4 ("Run/Stop gates the churn
   generator only") stop() just sets `running=false`; grants keep flowing and any command
   in flight runs to quiescence worker-side. The ADR-0019 coordinator-side token-abort /
   command-rewind (old scenarios 4 & 6) is gone — a paused command COMPLETES rather than
   rewinding. **Confirm** this is the intended new pause semantics (I believe it is, since
   there is no stop/abort message in the protocol).

5. **`reset({format})` — `format` no longer maps to a wire field.** RESET carries only
   `epoch'`; the worker always rebuilds a fresh chip. The boot double-format is avoided by
   the boot flow broadcasting the ONE real format command AFTER reset (as today), not by a
   `format:false` device blank. **Confirm** the boot/header-Reset flow with the worker host.

6. **`step()` mechanism changed (semantics preserved).** Race: authorize one more entry
   ungated for one grant (`entryLimit+1`, `playLimitNs=∞`). Pace: one-shot `forceProduce`
   that lets the shared index advance one step while paused.

`pendingFor`/`waitStates` preserved, reading proxy ack state.

---

## §2 AMBIGUITIES / DECISIONS I HAD TO MAKE (need sign-off)

**A. chunk units.** §2 writes `chunk = scale/targetFPS`, which assumes `scale` in
sim-ns per real-SECOND. The code carries `scale` as sim-ns per real-MS (the numeric copy
the die animation uses). I implemented `chunk = scale × (1000/targetFPS)` — numerically
the SAME per-frame budget the pre-0024 `raceClock` advanced by (`dt·scale` at 60fps), but
now dt-INDEPENDENT (one fixed chunk of headroom per grant). This is what makes the grant
cadence deterministic and the watermark cleanly derived. Confirm the unit reading.

**B. Standing signals (holding/stalled/waiting) are NOT defined by the model doc, and
§2 MAX-not-min changes the observable.** §2/§3 pin the clock algebra only. Under MAX, the
ADR-0020 "ahead FS stalls persistently" behaviour **no longer exists**: a behind FS burns
its extra headroom (`rel − (acked − baseline) ≥ chunk`) and burst-catches to the leader's
ceiling within one/few grants (bounded only by the worker's per-frame op budget), then
both pace level. So "stalled/waiting" is at most a 1-few-frame flicker at a divergence,
not a sustained state. My test [6] confirms the BEHIND FS bursts (cursor 24→408 in a few
frames) and never reads stalled; the leader often re-levels before a stall sample lands.
I DEFINED the signals as: `waiting/stalled` (Race) = idle at the ceiling (gate closed)
more than `STALL_GAP_NS` above the field-min playback; `holding` (Pace) = finished the
shared step (or leads the min cursor) while a peer has not. **This definition is mine to
invent — please confirm, and note the UI show-threshold semantics likely need rethinking
because the sustained-stall state the old UI keyed on is gone.**

**C. Mid-command holding is NOT ack-derivable.** §11 keeps slow-mo command op-by-op
cross-FS pacing (worker-local), but `grantAck.entriesDrained` is per-ENTRY, not per-op.
So the old "arrived at the current op-phase mid-command, waiting on a slower peer's op"
(pacePhaser.parked / the SPIFFS boot-format case) cannot be reconstructed from acks.
Per-entry holding (a session that finished the WHOLE command step while a peer has not)
IS derivable and tested. If mid-command holding must light the UI, the protocol needs a
per-op/per-phase ack field. Flagging, not editing protocol.js.

**D. Pace baseline rebase timing.** §3: "rebased per issued entry from its step-ack
playbackNs". I rebase at the moment the join advances the shared index, using each
session's current `acked.playbackNs`. If "step-ack" must be the exact ack that first
reported `entriesDrained == index` (vs the latest playbackNs), a session that animated
further before the join would rebase slightly high. Coincides in the mock. Confirm.

**E. "running/animating" guard.** The old `pending() > 0` (never-flag-the-laggard guard)
became `gateOpen` = `playbackNs < playLimitNs ∧ cursor < entryLimit`. The truer signal
(playback behind execution) would need the exec position in `grantAck` (only playbackNs
is there); `telemetry.simNs` is 250ms-coarse. `gateOpen` is a faithful ack-only proxy.
Confirm acceptable.

---

## OPEN / FOLLOW-UP (not in this lane)

- **`scripts/lockstep-concurrency-test.mjs` is now RED** against the new API (it imports
  `createSession` and reads `s.device.stats`/`s.runner` synchronously — impossible over
  the wire). ADR §13 says it is to be CONVERTED onto the wire with in-band dispatch/cost
  observables; that needs the worker-host lane (real session in a worker) + the mock/real
  worker backend. I did NOT touch it (test outside my lane; conversion depends on V/worker
  host). `test:coordwire` is my green stand-in for the coordinator half.
- `npm test` overall will be red until the worker host lands and playground is rewired per
  the contract diff above — expected mid-migration; my lane agrees with the host ONLY
  through protocol.js.

## Question count: 5 (items A–E above need sign-off)
