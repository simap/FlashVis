# Race scale / equal-flash-time diagnosis (ADR-0024, lane C)

Two symptoms reported watching RACE mode at http://localhost:8024/web/. Diagnosis first,
then the coordinator-side fixes (web/src/lockstep.js). All fixes verified by
scripts/coord-wire-test.mjs groups [12] and [13] (npm run test:coordwire).

Constants at the top of lockstep.js: `RACE_LEAD_BOUND_FRAMES` (bounded-MAX, user-set 2),
`RACE_LOOKAHEAD_*` + `NOMINAL_ENTRY_NS` (prefetch window), `observedMinCost()` /
`trackEntryCost()` (window sizing).

---

## Symptom 1: race does NOT keep flash time roughly equal at high speed

### Root cause (COORDINATOR-side, per the user's spec decision)
The §2 MAX watermark is correct: it grants the laggard the headroom to catch up
(playLimit_laggard = baseline + leader_advance + chunk). But a too-slow FS is genuinely
EXECUTION-bound: the worker cannot burn that headroom fast enough (it can only drain so
many device ops per frame). So the leader's race clock (max_s(acked) + chunk) keeps
climbing every frame while the laggard cannot follow, and the flash times diverge without
any bound. Nothing in the old watermark limited how far the leader may run ahead of the
slowest session.

The user's decision (authoritative): do NOT try to make the worker keep up, and do NOT
cap animation (ADR-0022 stands). BOUND the leader's race clock instead.

### Fix (lockstep.js `computeGrants`, RACE only)
Keep `rel_uncapped = max_s(acked - baseline) + chunk`. Add a bound:

    rel = max( min(rel_uncapped, relMin + RACE_LEAD_BOUND_FRAMES * chunk), chunk )

where `relMin = min_s(acked - baseline)` is the slowest session. Effects:
- lead under the bound: `rel` is the MAX exactly, clock advances by MAX, no hold (small
  jitter is free).
- a session falls more than the bound behind: the ceiling pins at `slowest + bound` and
  climbs only as that laggard climbs. A real hold appears, but ONLY for the too-far-behind
  case. It is a CLOCK bound, not an op/animation cap: every op the laggard does still
  animates; the leader is held at the boundary the way a Pace join holds.
- invariants preserved: DERIVED not accumulated (recomputed from acked each round),
  per-session clamp `playLimit >= acked_s` (a session already past the bound is held at
  its own position, never rewound), and `rel >= chunk` so the slowest always keeps at
  least one chunk of headroom and nothing deadlocks. PACE keeps the unbounded MAX.

### BOUND value: RACE_LEAD_BOUND_FRAMES = 2 (USER-SET)
Scale-relative: the leader may run at most `2 * chunkNs()` of race time ahead of the
slowest session (chunk = scale * MS_PER_FRAME), so the allowed visual lead is a constant
2 frames at every speed. The user chose 2; it is a single named constant at the top of
lockstep.js and trivial to retune. Alternative (noted for the user): a FIXED sim-ns
flash-time tolerance instead of a frame-multiple, if a speed-invariant ABSOLUTE tolerance
is preferred over a speed-invariant VISUAL one (swap `RACE_LEAD_BOUND_FRAMES * chunk` for
a constant ns).

### Signals
The pinned leader shows `holding` (a real bounded-race hold): it has consumed its bounded
budget and is waiting on the slower peer. Derived in `racePinned()` (granted headroom
squeezed below one chunk while a peer sits further behind). Unlike the Pace freeze, a
pinned leader still CREEPS one laggard-step per frame, so it can read `csActive=true` while
`holding=true` in race (they are not mutually exclusive here). The exec-bound laggard, the
one still executing, never reads holding. `stalled`/`waiting` were not resurrected.

---

## Symptom 2: the speed slider does nothing in race

### Root cause (COORDINATOR-side)
The scale to chunk to ceiling path itself is correct: `chunkNs() = scale * MS_PER_FRAME`
and the ceiling grows one chunk per frame, so a higher scale SHOULD produce a proportionally
larger per-frame advance. The break was the RACE PREFETCH WINDOW. `raceLookahead()` sized
the shipped/authorized `entryLimit` by a fixed nominal per-entry cost (`NOMINAL_ENTRY_NS`)
and clamped it at 256 entries. A cheap-op FS needs MANY small entries to fill one chunk of
the shared flash-time ceiling; the nominal-sized window authorized far fewer, so `entryLimit`
(the prefetch window, meant only to avoid starvation) became the throttle INSTEAD of the §2
`playLimitNs` gate. Once the clamp saturated at 256, the authorized entries per frame stopped
growing with scale, the gate never became the binding limit, and the per-frame advance stopped
tracking the slider. Measured before the fix: per-frame advance ~0.07ms at scale 1e5 where the
chunk (the intended advance) is 1.67ms, i.e. the window throttled it ~24x below the clock.

### Fix (lockstep.js window sizing) : PER-SESSION window, keyed on observed drain
The window must not throttle entryLimit below the §2 gate for any FS. My FIRST attempt sized
one SHARED window from the cheapest observed per-entry cost and shipped the frontier ahead of
the LEADER's cursor (RACE_LOOKAHEAD_MAX 256 -> 4096). That fixed symptom 2 but REGRESSED the
B16 post-Stop drain tail: the shared frontier sits ahead of the leader, and in a diverging race
the leader-lead grows without bound, so the laggard's tail = (leader-lead + window) blew past
200 frames (the s13 regression). The comment "tail stays ~RACE_LOOKAHEAD_FRAMES frames" only
holds if the frontier is near the LAGGARD, not the leader.

Corrected fix: size the window PER SESSION from that session's OWN observed drain rate, and
authorize each session only a few frames ahead of ITS cursor.
- `trackDrainRates()`: per-session EMA of `dCursor / frame` (entries that session actually
  drains per frame).
- `raceWindow(p) = clamp(RACE_LOOKAHEAD_FRAMES * drainEma[p], MIN, MAX)`.
- Race `entryLimit_s = cursor_s + raceWindow(p)` while RUNNING; FROZEN at its last running
  value once STOPPED (so a session drains only its already-authorized backlog, about one
  window, and halts, instead of a treadmill chasing the frontier; at no-delay the worker
  bypasses the playback gate, so entryLimit is the only tail bound). Generation covers
  `max_s(cursor_s + raceWindow(s))`.

This keeps the §2 gate the throttle for every FS (per-frame advance is chunk = scale *
MS_PER_FRAME, tracks the slider) AND bounds each session's post-Stop tail to a few frames of ITS
own drain, whatever its per-op cost. RACE_LOOKAHEAD_MAX 4096 is now a per-session memory guard.
`NOMINAL_ENTRY_NS` / `observedMinCost` (the shared-cost approach) were removed.

Verified [12]: doubling scale doubles the per-frame race advance (ratio 2.00), advance equals
chunk = scale * MS_PER_FRAME (1.67ms at scale 1e5). Verified s13 (real WASM): after stop the
laggard drains about one window and csActive clears in ~11 frames (was hundreds, then never).

### Interaction with the bounded-MAX clock at the very top of the slider
The slider now bites across the range until the point where the FS becomes execution-bound. At
that point the bounded-MAX clock (symptom 1) pins the leader to the slowest FS's exec rate, so
at the very top the effective race throughput is the slowest FS's execution rate and the slider
naturally saturates. That saturation is now the CORRECT behavior (you cannot run the shared
clock faster than the slowest FS can execute while holding flash times within the bound). Below
that point the slider responds proportionally.

---

## Symptom 1b: the bound was DROPPED at MAX speed (the off-spec infinite-scale path)

### Root cause (COORDINATOR-side, off-spec)
User repro: reload, Race, MAX speed, run a bit, switch to slowest, and flash times were
divergent (61/25/25/61/106 ms across the 5 FS, growing with runtime). The bounded-MAX bound
(symptom 1) lives ENTIRELY in `playLimitNs`. But at MAX speed the coordinator set
`atMax = !isFinite(scale)` and sent `grant.scale = Infinity`. In `session-worker.js drain()`
(~line 542) `const noDelay = prepActive || !isFinite(scale); let budget = noDelay ? Infinity :
(playLimitNs - playbackNs)`, so an infinite scale makes the worker's drain budget Infinity: it
IGNORES `playLimitNs` and runs flat out. With `playLimitNs` never consulted, the bound does
nothing at MAX and each FS races ahead at its own op rate. §2 requires Δ = scale / targetFPS to
be finite and the player "capped at playLimitNs" unconditionally; the infinite scale / no-delay
path is off-spec, and it is exactly what drops the bound at "max".

### Fix (SETTLED user decision): cap scale to finite, drop "max no delay"
There is no infinite scale anymore. The finite ceiling is the single chokepoint, so everything
flows the metered path and the bound holds at every slider position including the top.
- `lockstep.js`: `MAX_SCALE = 1e7` (10x real-time; real-time = 1e6). `setSpeed(next)` clamps
  `scale = Math.min(next, MAX_SCALE)` (turns a passed Infinity finite here). `atMax` is removed
  entirely. `chunkNs() = scale * MS_PER_FRAME` always; `wireScale() = scale` always (both
  atMax branches removed). `NO_DELAY_STEP_NS` removed (now unused). So `grant.scale` is always
  finite, the worker always runs `budget = playLimitNs - playbackNs`, and the 2x chunk bound is
  enforced at the top.
- `playground.js applySpeed` (minimal, this edit only): removed the `v >= 100 -> Infinity /
  'max no delay'` branch; log range top is now `Math.log10(1e7)`; `v = 100` maps to exactly 1e7
  and reads "10x real-time". Feeds both `coordinator.setSpeed` and `viz.setScale` a finite value
  (viz fill-reveal now scales at the top instead of flooring at MIN_ANIM). viz.js not touched.
- WHY the user chose 10x: they believe execution is ~5x CPU-bound; keeping the finite range up
  to 10x lets them SEE whether it can exceed 5x. Past ~5x the workers go execution-bound, the
  bound pins the leader, and holding shows. That visibility is wanted.

### Landed COORDINATOR-side (not worker-side)
The fix is coordinator + the shared slider wiring; `session-worker.js` is NOT edited. Its
no-delay path (`budget = Infinity` when `!isFinite(scale)`, `NO_DELAY_TAPE_CAP`) is now
UNREACHABLE from production because scale is always finite. Per the coordinator's instruction
that dead path is left in place for a separate scheduled cleanup (prep still uses `Infinity`,
which is untouched). Production cannot reach the `!isFinite(scale)` branch: the only scale
source is `applySpeed` (now finite) and `coordinator.setSpeed` clamps regardless of caller.

### Test (load-bearing, REAL WASM)
`lockstep-concurrency-test.mjs [17] scenarioRaceMaxSpeedBound`: Race at MAX speed
(`setSpeed(Infinity)` to PROVE the clamp), two FS of very different per-op cost, run 160 frames;
assert the flash-time gap stays within 2x chunk (333 ms at 1e7) AND does not grow with runtime
(the divergence signature). Proven load-bearing by a mutant coordinator that restores the old
`atMax`/`Infinity` path: it FAILS ([17] gap 31927 ms, growing 6038 -> 31927 ms); the fix PASSES
([17] gap 272 ms, plateaued 293 -> 272 ms over 120 frames). Full concurrency + coord-wire green.

---

## Worker-side note (report only, NOT fixed by lane C)
`web/src/session-worker.js` `MAX_OPS_PER_FRAME = 500` (in `drain()`) is the concrete
per-frame drain cap that makes a cheap-op FS execution-bound at high scale. It is the real
limit the user described ("the worker for some FS just cannot keep up"). Given the user's
decision, we do NOT raise or remove it (that would be an animation/throughput change,
ADR-0022 territory, and the worker lane's call). The coordinator's bounded-MAX clock turns
that real exec limit into a bounded, well-signalled HOLD instead of runaway divergence, which
is the desired product behavior. No worker change is required for either symptom under the
bounded-MAX decision. If the user later wants higher absolute race throughput at the very top
of the slider, that is a worker-side conversation about MAX_OPS_PER_FRAME.

## Playground (shared file) note
`web/src/playground.js applySpeed` wiring is correct: slider maps 3000..1e8 sim-ns/ms (log),
only slider==100 is Infinity/no-delay, and it calls `coordinator.setSpeed(scale)` and
`viz.setScale(scale)`. It is not a cause of either symptom; no change needed there.

## Tests
- coord-wire-test.mjs [12] `testRaceScaleProportional`: higher scale -> proportionally larger
  per-frame race advance; advance ~= chunk (symptom 2).
- coord-wire-test.mjs [13] `testBoundedRaceClock`: both keep up -> flash time level, no false
  hold; one FS execution-bound -> leader pins at slowest + 2*chunk (no runaway) and reads
  holding, laggard never does (symptom 1).
- coord-wire-test.mjs [6] updated: after a Pace->Race reseat the Pace playback gap exceeds the
  bound, so the AHEAD FS is pinned (may read holding) while the BEHIND FS bursts to catch up
  and never holds. This corrects the old "no sustained race hold" assertion to the bounded-MAX
  behaviour (not a weakening; the pre-bounded-MAX assumption is simply no longer true).
- Full coord-wire suite green (npm run test:coordwire), and the full REAL-WASM
  `scripts/lockstep-concurrency-test.mjs` green (s10-s15 signals incl. s12/s13, and s7 reseat).

## CORRECTION: the earlier "pre-existing bootFormat failure" was wrong (dist was missing)
My previous report claimed lockstep-concurrency was pre-existing-red at HEAD. That was WRONG.
The cause was a MISSING BUILD ARTIFACT: `dist/*.mjs` (the real filesystems, loaded by runner.js
via `../../dist/${fsId}.mjs`) is gitignored, so a fresh git worktree has no `dist/`, and
`bootFormat` could not load real WASM. Stashing code cannot restore a missing build artifact, so
"stash and re-run still fails" did not prove pre-existing. With `dist` symlinked in
(`flashvis-coord/dist -> flashvis/dist`), the suite boots real WASM. Always run it with `dist`
present.

## The real regression this task also fixed (s13)
With real WASM present, my symptom-2 change (the SHARED enlarged prefetch window) introduced a
real regression: `s13-drain-to-idle` hung. After `coord.stop()` the laggard had to drain the
whole shared frontier (leader-lead + 4096) at its slow rate, so `csActive` stayed set for
hundreds of frames. Root cause: the window was shared and shipped ahead of the LEADER. Fixed by
the per-session, stop-frozen window above (frontier bound by each session's own cursor + drain).
s13 now clears in ~11 frames. This is the frontier-bound fix the coordinator directed.
