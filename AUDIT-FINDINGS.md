# AUDIT-FINDINGS — worker-per-session (ADR-0024) unintentional losses

Read-only audit. Reference: OLD in-process tree `/Users/benh/git/flashvis` (branch
`main`) vs NEW worker tree `/Users/benh/git/flashvis-integrate` (branch
`integrate/0024`). Filter = ADR-0024 `…model.dedup.named.md`. Scope = behaviors
lost/changed with NO basis in 0024 (or contradicting it), EXCLUDING the already-tracked
B1–B9 in BUGS.md. Ranked most-severe first.

Determinism substrate is intact: `churn.js`, `device.js`, `runner.js` are byte-identical
to `main` (verified by diff), and the worker's `deterministicBytes`/`mulberry32`/
`hashNameSize` + seeded `randomBytes`/`randomName` are ported verbatim (I7 holds). The
findings below are the residue after that.

---

## A1 — `getFiles()` lost its name-sort (determinism contract)  · HIGH · high confidence

**Intended:** OLD `web/src/session.js:318-336`. `scanDir(prefix,{sorted})` scans in driver
order; `getFiles = scanDir(..., {sorted:true})` sorts the RETURNED array by name at the JS
boundary, `ls = scanDir(..., {sorted:false})` does not. Comment (session.js:314-317):
"`sorted` (getFiles) sorts the RETURNED array at the JS boundary only … sorting is a
scripting-input concern" — i.e. `getFiles()` is the *deterministic, name-ordered* view a
script iterates, distinct from `ls()`'s driver-order stream. ADR-0019 (I7 determinism);
brief flags "getFiles/ls name-sort" explicitly.

**Worker does instead:** `session-worker.js:212,230`. `ls = op(() => runner.list().filter(...))`
and `getFiles: ls` — getFiles is a bare alias to ls. It returns `runner.list()` order,
**unsorted**. Any command doing `const f = await getFiles(); use(f[0])` now gets driver
order, not name order — a silently different value than the in-process backend produced for
the identical command source.

**Tag:** silent-loss / NEW (not a B1–B9 symptom). 0024 gives no basis for dropping the
sort; §6 says the command's semantics are unchanged, only the locus moves.

---

## A2 — Tier-2 raw `fs.*` handle/dir API dropped from the command sandbox  · MED · high (dropped) / med (intent)

**Intended:** OLD `session.js:350-385` (ADR-0014 "RAW" tier). `fs` exposed
`open()`→wrapHandle (read/write/seek/stat/close), `openDir()`→wrapDir (dir.read/dir.close),
plus `list`, `cat`, `stat`, `mkdir`, `sectorClasses`, `liveMap`, and `write(n,d)` labelled
with byte size via `sizeOf(d)`. These are the streaming/handle primitives ADR-0014 defines
and ADR-0009's streaming-`ls` bridge is built on.

**Worker does instead:** `session-worker.js:216-226`. `fs` has only
`format/mount/unmount/write/read/remove/exists/fsinfo/gcStep`. `fs.open`, `fs.openDir`,
`fs.cat`, `fs.list`, `fs.stat`, `fs.mkdir`, `fs.sectorClasses`, `fs.liveMap`, and the
handle/dir wrappers are **gone** — a console command calling any of them hits `undefined`
and throws. `fs.write(n,d)` also lost its `… B` byte-size label (line 220 vs OLD 377).

**Tag:** silent-loss / NEW. Contradicts 0024 §6 ("command … result ⊕ per-op log … ships as
source, compiles worker-side" — semantics unchanged). Confidence caveat: the worker's
`HELP_TEXT` (lines 46-53) was rewritten and *also* omits open/openDir, so the trim may be
partly deliberate; but no 0024 section authorizes shrinking the ADR-0014 API, and the loss
of `fs.openDir` in particular is what makes streaming/per-entry `ls` unreconstructable
(reinforcing B5's tape loss with an API-surface loss).

---

## A3 — Driver capabilities hardcoded on the main thread; `runner.caps` authority lost  · MED · high confidence

**Intended:** ADR-0011 makes `ff_caps()` (WASM bitmask) + exported-symbol presence the
**single source of truth** for per-FS capability. OLD `session.js:407` surfaced it as
`session.caps = runner.caps`; the UI gated controls off that authoritative value
(FF_CAP_GC / FF_CAP_LIVE_MAP / FF_CAP_SECTOR_CLASSES, ADR-0021).

**Worker does instead:** the runner now lives in the worker, and 0024 §4's TELEMETRY schema
carries **no caps** field (confirmed: `session-worker.js:368-378` sends fsinfo /
livenessCounts / exec_* only). So `playground.js:36-45` hardcodes a `STATIC_CAPS` table
(`fastffs: GC|LIVE_MAP`, `littlefs: LIVE_MAP`, …) and `applyCapsGating()` (playground.js:558)
gates off *that*. The code comment (playground.js:33-34) openly flags it: "caps are not on
the wire today (TELEMETRY carries none), so this table [hardcodes]." This table can drift
from the real `ff_caps()` bitmask, and a new/changed driver's caps won't be reflected — the
exact single-source-of-truth ADR-0011 was written to prevent.

**Tag:** silent-loss / NEW. Not intended by 0024 (§4 simply never plumbed caps); it is an
incomplete port of the ADR-0011 authority, not a deliberate relocation. Fix lead: add a caps
field to INIT-derived TELEMETRY (or the FRAME) and gate off it.

---

## A4 — Liveness walk missing the "≥250 ms since last" throttle  · LOW · medium confidence

**Intended:** 0024 §7: "liveMap … lazy walk on pull **iff dirty ∧ ≥ 250 ms since last**
[walk is real work: 0008]." ADR-0008: `fffs_inspect_live_map` is a full reachability walk
(`calloc` + many silent reads), meant to run "a few times per second."

**Worker does instead:** `session-worker.js:148-160` `ensureLiveness()` is **dirty-gated
only** — no timestamp. `handlePull` (line 453-455) calls it on every `liveMap` pull, and the
render loop pulls once per rAF with `liveMap:{since}` (`playground.js:349-351`). Under
continuous churn `mapDirty` is re-set every frame (device `prog`/`erase` events,
session-worker.js:403), so the focused worker can run the full walk up to ~60×/s instead of
the §7-capped ~4×/s.

**Tag:** contradicts-0024 §7 / pre-existing (OLD `session.js:122` `ensureLiveness` also had
no timestamp gate and was driven from an rAF `refreshLiveness`, so this is not a regression
*introduced* by the port — but the §7 model the port implements now names the gate and the
worker omits it). Low severity; the 250 ms telemetry tick already bounds the *counts* path,
only the pull-path die-tint walk is uncapped. Version-stamps-the-walk (livenessGen++ per
walk, not per mutation) IS correctly preserved (line 151).

---

## Confirmations of already-tracked bugs (NOT re-reported as findings)

- **B6 (drain-pacing) = CONFIRMED LOST.** `MAX_OPS_PER_FRAME` exists nowhere in the new tree
  (grep: absent; OLD `viz.js:36` + drain loop `lockstep.js:374-377`). `worker-heat.js`
  applies every event eagerly (lines 61-69) with no per-frame drain cap / carry-forward. The
  ADR-0022 I8 *veto* (every op contributes full HEAT_ADD — nothing dropped/sampled) IS
  honored; but the drain *pacing* that keeps a burst visibly lit across frames is gone. This
  is the same root as B7/B8: there is no worker-side timed player at all (session-worker.js
  header, lines 8-22, states execution is "DRAIN-SYNCHRONOUS … not a worker-side timed
  player"), which directly contradicts 0024 §6 ("player … drain pacing [0022] lives here").
- **B5** — the streaming/per-entry `ls` loss compounds with A2: `ls` calling `runner.list()`
  (session-worker.js:212) instead of the `openDir`+N×`dir.read`+`dir.close` scan means the
  sub-op tape lines AND the per-entry pacing are both structurally unreconstructable, not
  just the `→ ms · N read` text.
</content>
</invoke>
