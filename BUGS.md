# Worker-per-session (ADR-0024) — bug tracker

Branch `integrate/0024`, NOT landed to main. Fixes NOT yet delegated. Severity:
CRIT (core value prop broken) · HIGH (core behavior/observability lost) ·
MED (visible defect) · LOW (cosmetic). Root-cause lines are hypotheses until confirmed.

---

## CRIT

### B7 — Pace: speed slider does not pace execution; sim runs faster than real-time
5× slow-mo Pace: FASTFFS burned **12.75 s of flash time in ~9.5 real s** (others more) —
sim is running *faster* than real-time when 5× slow-mo should make it ~5× *slower*
(~1.9 s expected). At 333× slow-mo, sim *still* outruns real-time. The timed-player
contract (ADR-0007/0009: playback = realBudget × scale) is not being honored.

### B8 — Pace: speed slider only affects heat-fade + erase-fade, not op pacing
The SPEED scale reaches the main-thread viz fade animations (heat decay, erase sweep)
but does NOT gate worker op execution. The §2 watermark (`playLimitNs`, `chunk =
scale/targetFPS`) should throttle the worker's playback to real-time; instead the
worker drains eagerly. **CONFIRMED by audit (see A-section): B6+B7+B8 are one root
cause — there is NO worker-side timed player.** `worker-heat.js` applies events eagerly
(drain-synchronous); the worker header openly states "not a worker-side timed player";
`MAX_OPS_PER_FRAME` is absent. Contradicts §6 ("player [0007/0009] … playback at
realBudget × scale … drain pacing [0022] lives here"). FIX: build the relocated timed
player worker-side — meter playback at realBudget×scale against playLimitNs, continuous
intra-event, drain-paced with carry-forward. This is the single largest fix and subsumes
B6. (ADR-0022 I8 veto still honored — every op contributes full heat.)

---

## HIGH

### B5 — Journal/tape lost all timing + flash-op breakdown + sub-op detail
The tape is a core instrument (ADR-0018 "journal of truth"; ADR-0023 observability
contract: every op line shows its flash-op breakdown and time). Worker-era tape shows
only bare command names — no ms, no `N erase M prog K read`, no sub-op lines, no `ls`
entry listing.

OLD:
```
format() → 43 ms · 2 erase 2 prog
mount() → 0.7 ms · 3 read
> writeFile()
write(f000-159461b1.bin, 28226 B) → 176 ms · 131 prog 19 read
> ls()
openDir() → 0.0 ms
dir.read() → 0.1 ms · 2 read
  f000-05ca18ee.bin  14686 B
dir.read() → 0.1 ms · 2 read
  f000-159461b1.bin  28226 B
dir.close() → 0.0 ms
```
NEW:
```
format()
mount()
write(f000-159461b1.bin, 28226 B)
write(f000-05ca18ee.bin, 14686 B)
ls()
```
The worker's `timed()` op-log capture (was session.js) is not populating the journal
ring with per-op time + device-op counts. Suspect worker-rings/session-worker journal
emission dropped the timed op detail.

---

## MED

### B4 — Focus switch replays historical animation events (erase, fill)
Switching FS replays lots of one-shot animations (notably erase sweeps) that already
happened. On re-attach the render loop pulls `events: { since: 0, limit: 400 }`
([playground.js:353](web/src/playground.js#L353)) — it re-sends the whole event ring
and replays every historical erase. Fill/tint is tolerable (simple transition, less
distracting); erase is a one-time event and must NOT replay. Fix: on switch, seed
`eventsSince` to the current event head (paint current state, don't replay history) —
mirrors the user's hypothesis that it's grabbing all events on the frame after switch
instead of carrying `eventsSince` forward.

### B2 — INIT async runner-build races an immediately-following RESET
A RESET arriving before INIT's async runner build completes starves the build → a
runner-less worker (blank die on boot/reset). Reachable on a normal boot→reset. Fix:
serialize RESET against the in-flight INIT build (queue/await/cancel). (T2-flagged.)

### B1 — Over-capacity write crashes the worker (no catch in pump)
A write larger than the chip throws synchronously in session-worker.js `pump()` →
uncaught → worker down. The old in-process path swallowed it. NOT triggered by the
live churn workload (large class weight 0, forced-large disabled — same as main), but
reachable by hand-typing e.g. `writeFile('x', 400000)`. Fix: catch, journal the error,
keep the worker alive. (T2-flagged.)

### B9 — Race: sim ignores the speed slider (+ perf note)
Race runs flat-out regardless of SPEED. Partly expected at no-delay (flat-out but
sim-synced), but at finite speed Race should still pace. Perf is otherwise good: uses
>1 core, faster than the old non-worker path. Possible further speedup (may be bounded
by per-op worker round-trip overhead). Verify Race honors finite scale; treat the perf
observation as an optimization lead, not a defect.

---

## INVESTIGATE

### B6 — MAX_OPS_PER_FRAME: did ADR-0022 drain-pacing survive the worker split?
ADR-0022 caps ops drained per frame (500, carry-forward) so a burst stays visibly lit
instead of collapsing to one decay flash — explicitly NOT throttling the glow. Confirm
this drain-pacing exists in the worker model (worker-side, since the player moved) and
still carries forward. If lost, bursts mush.

---

## LOW

### B3 — fs-card hold label text hardcoded by mode
[playground.js:223](web/src/playground.js#L223) sets the hold label text to
`◷ waiting` (Race) / `◷ holding` (Pace) by mode, while *visibility* is driven by the
debounced `holding` signal. Cosmetic leftover from the signal rework.

---

## AUDIT FINDINGS (read-only audit vs ADR-0024 …named.md; full report AUDIT-FINDINGS.md)

Determinism substrate intact: churn.js/device.js/runner.js byte-identical to main; seeded
randomBytes/randomName ported verbatim (I7 holds). Four residual losses:

### A1 — getFiles() lost its name-sort (determinism) · HIGH · silent-loss
OLD `session.js:318-336`: `getFiles` sorts the returned array by name at the JS boundary
(ADR-0019 I7 — the deterministic view a script iterates); `ls` stays driver-order. Worker
`session-worker.js:230` aliases `getFiles: ls` → returns unsorted `runner.list()` order, so a
command doing `getFiles()[0]` gets a silently different value than in-process. No 0024 basis.

### A2 — Tier-2 raw `fs.*` handle/dir API dropped from the sandbox · MED · silent-loss (part maybe intentional)
OLD `session.js:350-385` (ADR-0014 RAW tier): `fs.open`/`openDir`/`cat`/`list`/`stat`/`mkdir`/
`sectorClasses`/`liveMap` + handle/dir wrappers. Worker `fs` (session-worker.js:216-226) has
only 9 members; the rest throw `undefined`. `fs.write` also lost its ` B` byte-size label.
Partly overlaps W's declared "tier-2 not ported" deferral, but no 0024 section authorizes it;
`fs.openDir` loss makes streaming/per-entry `ls` unreconstructable (compounds B5).
RESOLUTION: deferral, NOT a product decision (W bounded-scope; ADR-0014 defines it, 0024 §6
keeps command semantics). RESTORE the tier-2 `fs.*` API + handle/dir wrappers + the full old
`HELP_TEXT` verbatim (incl. HANDLES line + return-shape/tracked-file/mkdir-p/atomic-loop-var
notes + example). KEEP the new `fs.exists`/`fs.fsinfo` (good adds the old help omitted) and
restore `fs.write`'s ` B` byte-size label.

### A3 — Driver caps hardcoded on main thread; ADR-0011 authority lost · MED · silent-loss
ADR-0011: `ff_caps()` is the single source of truth. Runner now lives worker-side and
TELEMETRY (§4) carries no caps field, so `playground.js:36-45` hardcodes a `STATIC_CAPS` table
(comment admits it) that `applyCapsGating` gates off — can drift from the real bitmask. Fix:
plumb caps over INIT-derived TELEMETRY (or FRAME) and gate off it.

### A4 — Liveness walk missing the "≥250 ms since last" throttle · LOW · contradicts-§7 (pre-existing)
§7: walk iff dirty AND ≥250ms since last. Worker `ensureLiveness()` (session-worker.js:148-160)
is dirty-gated only; under churn `mapDirty` re-sets every frame so the focused worker can walk
~60×/s vs §7's ~4×/s. Pre-existing in OLD too (low confidence as a port regression); version-
stamps-the-walk IS preserved.

### Audit confirmations (fold into existing bugs, not new):
- **B6/B7/B8 share ONE root cause: there is no worker-side timed player.** `worker-heat.js`
  applies every event EAGERLY (drain-synchronous); the worker header (session-worker.js:8-22)
  explicitly states "not a worker-side timed player." `MAX_OPS_PER_FRAME` absent everywhere.
  This CONTRADICTS §6 ("player [0007/0009] … playback at realBudget × scale … drain pacing
  [0022] lives here"). THE fix for pacing: implement the relocated timed player worker-side —
  meter playback at realBudget×scale against playLimitNs, continuous intra-event, drain-paced
  with carry-forward. (ADR-0022 I8 veto — every op contributes full heat — IS still honored.)
- **B5** compounds with A2: `ls` uses `runner.list()` (session-worker.js:212) not the
  `openDir`+N×`dir.read`+`dir.close` scan, so the sub-op tape lines AND per-entry pacing are
  structurally gone, not just the `→ ms · N read` text.
