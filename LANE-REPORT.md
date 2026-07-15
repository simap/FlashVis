# Lane C — ADR-0024 report (integration phase: standing-signal rework)

Resumed at the integrated base (`lane/coord` @ integrate/0024). §2 core was verified +
merged. This pass reworks the standing signals per your correction + spec/ui.md, and
confirms the boot/reset flow. All coordinator work stays in `web/src/lockstep.js` +
`web/src/session-proxy.js`; verified by `scripts/coord-wire-test.mjs` (`npm run
test:coordwire`), 12 groups, all green.

## Correction absorbed (my earlier report §B was wrong for Pace)

You were right: the sustained hold is REAL and is the product's whole point. §2 MAX-not-
min kills only the RACE stall (a laggard burns headroom and catches up — nothing freezes).
In PACE the fast FS genuinely FREEZES at the step-join waiting for the slow peer, and that
is sustained (spec/ui.md: "'Holding' card — debounced ~300ms"). My old derivation assumed
the Race truth applied everywhere. Reworked.

## The two standing-signal contracts (spec/ui.md), exposed per session

Both are derived from ack state only and computed once per `frame()`:

- **`csActive`** (raw, per-frame, NOT debounced) — did this session's `playbackNs` advance
  this frame (compare last-frame vs this-frame acked playbackNs). Drives the CS pin /
  status dot blinky, BOTH modes. `spec/ui.md: "CS pin & status dot — raw real-time
  animation-frame level blinky"`.
- **`holding`** (debounced ~300ms) — this session finished the shared step
  (`entriesDrained ≥ sharedIndex`) / leads on cursor while a peer has NOT, AND it did not
  advance this frame (frozen). The RAW predicate must hold continuously for
  `holdDebounceMs()` before `holding` goes true; it clears the instant the raw signal
  drops. `spec/ui.md: "'Holding' card label — debounced (~300 ms)"`. Fires in Pace slow-mo
  and at Race↔Pace catch-up; steady Race does not fire (the lead FS keeps its gate open,
  never frozen).

`csActive` and `holding` are mutually exclusive by construction (a frame the session
advanced counts as active, and only reads holding from the next frozen frame on).

Exposed on BOTH surfaces:
- `snapshots()[i]` now carries `{ …, holding, csActive }` (the pinned C↔V contract).
  `stalled` and `waiting` are REMOVED (they encoded the retired sustained-Race-stall
  model). `wa` is now populated from the new telemetry `programBytes`/`hostBytes`
  (`programBytes/hostBytes` were added to TelemetryMsg in the integrated base — thanks).
- `waitStates()` now returns `{ [fsId]: { csActive, holding } }` (was a bare bool). Cheap,
  no telemetry walk, for per-frame polling.

Debounce timing has a test seam: `globalThis.__flashvisHoldShowMs` (same knob playground
already reads), now read per-frame so it can be set after module load.

### Action for lane V (playground rewiring)
The current playground `holdTick` debounces `waitStates()` itself and drives BOTH pins off
the debounced value. Under the new contract: the **CS pin** must read RAW
`snapshots()[i].csActive` (or `waitStates()[fsId].csActive`) with NO debounce; the
**"Holding" card** must read the already-debounced `snapshots()[i].holding` (drop the
playground-side 300ms debounce — the coordinator owns it now). `waitStates()[fsId]` is now
an object, not a bool.

## Boot / header-Reset flow — CONFIRMED

Verified against lane W's `session-worker.js` and my `reset()`/`broadcast()`:
- `reset()` bumps the epoch and does NOT touch `mode` → a header Reset never switches
  race/pace (spec/ui.md). ✓ (test [11])
- `reset()` → each proxy `reset(epoch')` → the worker's `handleReset` runs `device.reset()`
  (flash→0xFF, blank chip) + `resetLocalState` — a fresh blanked chip. There is no `format`
  wire field; RESET carries only `epoch'`. ✓
- The ONE real format ships as a broadcast command AFTER reset (`broadcast({…}, 'format()')`
  lands at frontier index 0 on the cleared sequence and executes on every worker). ✓ So the
  boot double-format is avoided without a device-blank/format flag. (test [11])

## Test coverage added (coord-wire-test.mjs)

- [5] SUSTAINED Pace hold: heavy multi-op command, chunk between the two op costs → fast FS
  frozen at the join for many consecutive frames while slow grinds; laggard never holds; a
  holding FS reads `csActive=false`; hold clears on step advance.
- [6] PACE→RACE reseat: behind FS bursts to catch up; no sustained hold in Race; the
  bursting FS never reads holding.
- [6b] RACE→PACE catch-up: the cursor-lead FS holds until the laggard converges, then clears.
- [9] `csActive`: false while idle, true on most running frames, false again once reset to idle.
- [10] debounce: holding NOT lit on the first frame of a fresh hold, lit after the raw hold
  persists past ~300ms (real wall-time).
- [11] boot/reset flow (above).
Plus the prior §2 groups (handshake/I5, Race divergence+barrier, Race command, Pace lockstep,
I10/I4 grant continuity, reset epoch discard) — still green.

## Remaining C↔V notes (unchanged from prior pass, still open for V/W)
- `broadcast(payload, label)` ships serializable SOURCE, not a live fn; return has no
  `journalEntries` (tape is worker-owned).
- `setSessions(list)` takes session-proxies (`createSessionProxy(port, …)`).
- `stop()` gates the churn generator only; a live command runs to quiescence (no
  coordinator-side command abort/rewind — there is no stop message in the protocol).

## Question count: 0 (the §B ambiguity is now resolved by your correction; signals implemented to spec/ui.md)
