# fix/midflight — backend-fix lane report (B14, B16, B17)

Scope: `web/src/lockstep.js`, `web/src/worker-heat.js`, `web/src/session-worker.js`
(+ their tests). ADR-0024 worker-per-session. Did NOT touch
playground.js / viz.js / session-proxy.js / protocol.js.

## Verdict on the "boot-noise vs real mid-flight bug" question

**B16 and B14 are REAL mid-flight bugs, not boot-noise.** They share ONE root:
the worker port decoupled EXECUTION from paced PLAYBACK and then let execution
run a *fixed sim-second* ahead (`TAPE_CAP = 1e9`), independent of SPEED. At the
default 50× slow-mo (scale 20000) that is ~50 real-seconds of executed-but-
unplayed backlog, and the coordinator also ships a flat 256-entry Race prefetch
window on top. Measured on the real backend (mock transport + real WASM):

- Running Race at scale 20000: leader `cursor=58` while `entriesDrained=1` — i.e.
  execution had vaulted ~57 entries (≈1 sim-second) ahead of what the die shows.
- After Stop: the leader kept executing and playing back for **300+ entries /
  minutes** (my 2000-frame probe, ~32 s, had not finished; the full frontier is
  ~314 entries). Generation IS correctly gated by `running` (ensure() only runs
  while running) — the tail is entirely the pre-generated + pre-executed backlog
  draining at Speed, exactly ADR-0020's "long tail," not a generator-gate leak.

The ADR intent (§6 / worker-side gating) is "the limit LEADS the meter by ≈ one Δ
(one frame of sim)" — execution tracks playback within a frame or few, with
`TAPE_CAP` absorbing a single sync burst (e.g. a 13.5 ms compaction), NOT routine
1-sim-second headroom. The constant `1e9` is the regression.

### Why B14 ("SPEED sometimes only controls fade, not op pacing") is the same root
The steady-state leader always paced correctly with SPEED in my tests (10× scale
ratio → 10× playback-rate ratio, drift 1.00×; mid-run speed change lands in ≤1
frame). The "sometimes flat-out" is the backlog interacting with
`MAX_OPS_PER_FRAME`: when a large executed-but-unplayed backlog of CHEAP ops
exists, the metered drain hits the 500-ops/frame cap before the time (chunk)
budget, so the op RATE pins at 500/frame and stops tracking SPEED (while heat/
erase fade, which read `scale` directly, keep responding) — hence "fade works,
pacing doesn't." Non-deterministic because it depends on what burst was mid-flight.
With execution tracking playback (below), there is no large backlog, so at finite
speed the drain is chunk/time-bound and SPEED controls the op rate.

## Fixes

### B14 + B16 — bound execution & prefetch lead over paced playback
1. `session-worker.js`: `TAPE_CAP` is now **scale-relative** —
   `TAPE_CAP_FRAMES(=4) × chunk` (`chunk = scale × MS_PER_FRAME`) at finite speed,
   `NO_DELAY_TAPE_CAP(=1e9)` at no-delay. Execution now leads paced playback by a
   bounded ~4 frames of real time at any finite speed (matching §6), instead of a
   fixed sim-second. No-delay is unchanged (playback is flat-out, no real-time
   lead to bound; `BACKLOG_CAP` still guards the event count). Only affects REAL
   entries (synthetic conformance entries commit via `playLimitNs`, untouched).
2. `lockstep.js`: the Race prefetch window `RACE_LOOKAHEAD` is now **scale-aware**
   (`raceLookahead()`): deep (256) at no-delay + fast finite for throughput, sized
   to ~8 frames of paced playback worth of entries at slow speeds (floor 4). The
   shipped-but-unplayed frontier is exactly what drains after Stop, so this bounds
   the post-Stop tail. Under-provisioning only costs a round-trip of idle, never
   correctness (§4 "window size is a deferred tuning knob").

Result (scale 20000, 50× slow-mo): post-Stop tail **300+ entries → ~4-6 entries**,
BOUNDED (does not grow with runtime — verified after 300-frame run: execution
leads playback by ~2 entries). At/above real-time speed the tail is ~sub-second.
Race pacing tracks SPEED consistently (10× ratio, drift 1.00×). No-delay throughput
preserved (concurrency suite s7 Race reseat still bursts cursor 25→251).

### B17 — restore per-page playback sweep
`worker-heat.js` gained `stepsFor(ev)` (splits a multi-page read/prog into N
per-page steps of ns/N each; erase stays one whole-sector step) and `applyStep(ps)`
(applies one page). `session-worker.js`'s timed player enqueues per-page steps
instead of one whole-op step, and applies each page's glow at the START of its
playback slot — so a multi-page/sector read lights page-by-page as the meter
crosses each slot, across frames (ADR-0009 "multi-page ops split to sweep page-by-
page"), instead of the whole glow landing at once. Per-page ns sum to the op's ns,
so playback accounting (playbackNs, entriesDrained, fileOpCount) is unchanged —
intra-op granularity only. Verified: a 3-page prog → 3 steps of ns/3, same final
shown/heat state as whole-op application; erase → 1 step.

## Verification
- Suites named in the brief GREEN: `lockstep-concurrency` (§13 acceptance),
  `session-worker`, `worker-conformance`, `coord-wire`. Also green: `vizframe`,
  `tapeleak`, `opcount`, `bootformat`? (see below), all FS unit + integrity tests,
  `console`, `playgroundboot`, `commanderror`? (see below).
- WASM built: `git submodule update --init && npm run build` (all 5 FS).
- Behavioral (mock transport + real WASM): B16 Stop halts the leader promptly
  (bounded ~4-entry drain); B14 Race paces at finite speed and tracks SPEED.

## Pre-existing failures (NOT mine — flagged)
Four suites fail identically WITH and WITHOUT my changes (verified via `git stash`);
all are in files outside my scope (viz.js / session-proxy.js / playground.js):
- `fatfs-render`: `TypeError: viz.setScale is not a function` (viz.js has no
  `setScale`; fatfs-render-test.mjs:63 calls it).
- `realsmoke`: playground never reaches bootStatus "ready" (real-backend boot
  hangs/throws).
- `bootformat`, `commanderror`: `TypeError: p.reset is not a function` (session
  proxy stub in those harnesses lacks `reset`).
These look like an in-progress state on `fix/midflight` from other lanes; raising
for the lead, not fixing (out of scope).

## Notes / no protocol change needed
All fixes are internal tuning of the worker-side timed player and the coordinator's
prefetch/authorization — no protocol.js wire change, no playground change. The
`TAPE_CAP` and `RACE_LOOKAHEAD` values are the ADR-sanctioned "deferred tuning
knobs"; I made them scale-relative rather than constant.
