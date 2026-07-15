# Lane V (main-thread consumer) — integration-phase report

Branch `lane/viz`, worktree `/Users/benh/git/flashvis-viz`, on the integrated
base (was a0cf5ed). Scope this phase: wire `web/src/playground.js` onto the
ADR-0024 worker wire, driving the die/HUD/compare-strip/console/controls
through session PROXIES over the protocol.

## Outcome: the page boots and drives both FS end-to-end

`scripts/playground-boot-test.mjs` (new, 15 checks, green) boots the REAL
`web/src/playground.js` headless — fake DOM + one in-realm `createWorkerHost`
per session over `mock-worker-transport.mjs` with the stub runner (no WASM) —
and verifies: boot reaches ready; exactly one main-thread die is mounted;
the compare strip populates from TELEMETRY with fastffs focused; the focused
tape shows the broadcast `help()`/`format()` boot log; focus switch re-points
die+tape to littlefs (its own tape shows the boot log) and back; an injected
`await writeFile("hello.bin",512)` console command echoes on the tape and
shows up in telemetry (`sFiles` 0→1); Run advances the workload (flash time
0→111ms) and Pause stops it; SPEED=max reaches the coordinator; the focused
die renders pulled `shown` state (free pages < total).

### What was wired (`web/src/playground.js`, full rewrite of boot())

- Spawns one worker per FS via a `connectWorker(fsId, meta)` seam
  (`new Worker(new URL('./session-worker.js', …), {type:'module'})` in
  production; a headless test installs `globalThis.__flashvisWorkerConnect`).
  Wraps each in `createSessionProxy(port, meta)` — the proxy is the SINGLE
  port owner — and hands the proxies to `coordinator.setSessions([...])`.
- ONE main-thread `viz` (not N dies). A rAF render loop pulls the FOCUSED
  proxy (`proxy.pull({heat,wear,liveMap,journal,events})`) and paints
  `viz.applyFrame(adaptFrame(proxy.frame))`. Focus switch = `viz.clear()`
  (new — blanks the die) + re-attach fresh (`journal.newest`) so the next
  pull is a full-state snap repaint (§7). Unfocused sessions stream nothing.
- HUD + compare strip from TELEMETRY (`proxy.telemetry`) + `snapshots()` on
  the ~250ms cadence. Hold pins: fs-card "holding" label debounced ~300ms,
  #pinCS status dot RAW per-frame (spec/ui.md — CS pin blinky, Holding
  debounced); consumes `snapshots().csActive` when present, else the raw
  `waitStates()` signal.
- Console/buttons: `broadcast()` now ships SOURCE TEXT. `wrapCommandSource()`
  (exported, unit-testable) wraps a console line into a self-contained
  async-fn expression that rebuilds the `with`-sandbox worker-side and echoes
  itself to the per-FS tape via `api.print`. Tape is worker-owned, rendered
  from journal-pull data (dedup by id).
- Run/Pause → coordinator start/stop (gates churn generation only); Step,
  SPEED→setSpeed, BG-GC→setGcRatio, Race/Pace wheel, header Reset (bumps
  epoch, replays boot log, never switches mode — spec/ui.md), palette
  switcher, console history — all preserved.

### `web/src/viz.js` — one addition

Added `viz.clear()` (exposes the internal `resetDie()`) for focus-switch /
epoch-bump blanking. `viz-frame-test.mjs` still green (16 checks).

### Removed (superseded / dead)

- `web/src/session-client.js` + `scripts/session-client-test.mjs`: my
  phase-1 raw-port facade. The proxy owns the port now and I folded its
  focus/snap logic into playground's render loop (per the brief's option);
  the logic is exercised end-to-end by `playground-boot-test.mjs`. Removed to
  avoid a dead module a future dev might wire into a conflict with the proxy.
- `scripts/dom-smoke.mjs` + `scripts/stub-backend.mjs`: tested the pre-0024
  `__flashvisBackend` in-process contract that playground no longer
  implements. Superseded by `playground-boot-test.mjs` (same intent, the new
  wire). `package.json` `test:domsmoke` → `test:playgroundboot`.

## Things that FIGHT the wiring — flagged, not guessed around

1. **Worker FRAME shape ≠ frozen protocol.js FrameMsg.** protocol.js pins
   `heat{read,prog}`, `shown{pages,wear}`, `liveMap{version,classes}`, and
   `events` as erase/reset `EventEntry` triggers — and my viz.js already
   conforms to that. But lane W's `session-worker.js` `handlePull` emits
   `heat{readHeat,progHeat}`, `shown{shown,wear}`, `liveMap{map,version}`,
   and uses the `events` ring for COMMAND lifecycle (`{entryIndex,
   kind:'started'|'done'}`), not erase/reset. I isolated a one-way
   `adaptFrame()` in playground (accepts BOTH key spellings via `??`, so it
   keeps working once the worker conforms) rather than bend viz.js off the
   frozen contract. **Ask: lane W's worker should emit protocol field names;
   then `adaptFrame()` becomes a no-op and can be deleted.**

2. **Erase sweep has no trigger on the wire.** The worker plays an erase as a
   `shown`-clear only; it emits no erase `EventEntry`, so the theatrical
   purple sector sweep (ADR-0022) does not fire. The die still renders
   correctly (pages clear from the `shown` snapshot) — this is animation
   polish, deferred per the "report before polishing" bound. **Ask: worker
   should push an `{kind:'erase',sector,ms}` EventEntry per sector erase (and
   `{kind:'reset'}` on device reset) into a viz-events channel distinct from
   the command-lifecycle events ring.**

3. **TELEMETRY is missing the Flash-Stats numbers.** The worker's
   `sendTelemetry` sends only `fsinfo`, `livenessCounts`, `exec_fileOpCount`,
   `exec_simNs`. protocol.js's TelemetryMsg also declares `programBytes` /
   `hostBytes` (write-amp) but the worker doesn't send them, and device
   erase/read COUNTS and per-sector wear aren't in the telemetry contract at
   all. So the HUD shows `—` for write-amp and can't show erase/read counts;
   `snapshots().wa` stays null. Present-from-frame stats (%prog, free pages,
   garbage%, live) work. **Ask: worker should populate programBytes/hostBytes
   in telemetry (protocol already reserves them); decide whether erase/read
   counts + wear peak belong in telemetry or should be read off the FRAME.**

4. **Per-FS caps aren't on the wire.** Control-gating (hide GC slider /
   garbage stat for an FS that disclaims the cap) needs `caps` per fsId, which
   used to come from the in-process `session.caps`. Nothing carries it now, so
   I hardcoded a static `FS_CAPS` table (fastffs=GC|LIVE_MAP, others
   LIVE_MAP). Cosmetic if wrong. **Ask: surface `caps` on INIT-ack or
   TELEMETRY, or confirm the static table is acceptable.**

5. **`pull()` selector: `shown` vs `wear`.** The brief's example passes
   `{shown:true}`, but the worker gates the shown payload on `m.wear`
   (`if (m.wear) payload.shown = …`). I pass `wear:true` (and `heat:true`).
   Minor, flagging so the selector key is pinned.

## Verification

Green (WASM-free): `playground-boot-test` (15), `viz-frame-test` (16),
`coord-wire-test`, `session-worker-test`, `worker-conformance-test`. Did not
regress the coordinator/worker/test lanes' files (untouched).

Not run — WASM-gated, `dist/*.mjs` not built in this worktree (pre-existing,
unrelated to this change): `command-error-test`, `tape-leak-test`,
`opcount-test`, the FS integrity/render suites, `real-smoke`. **`real-smoke`
also still assumes the old `__flashvisBackend` in-process backend and will
need the same worker-seam rework `dom-smoke` got — flagging for whoever owns
the real-WASM smoke; I left it untouched to stay in lane.** A real-browser
boot (real `new Worker` + real WASM) is the additive check beyond the faithful
in-realm transport, per ADR-0024 §13.

## Files

Touched: `web/src/playground.js` (rewrite), `web/src/viz.js` (+`clear()`),
`package.json`. New: `scripts/playground-boot-test.mjs`. Removed:
`web/src/session-client.js`, `scripts/session-client-test.mjs`,
`scripts/dom-smoke.mjs`, `scripts/stub-backend.mjs`. Not touched:
`session-worker.js`, `session-proxy.js`, `lockstep.js`, `protocol.js`,
`worker-heat.js`, `worker-rings.js`, `runner.js`, `device.js`.
