# Fill-state animation scaling audit — OLD (main @33e7d96) vs CURRENT (fix/erase-timing)

Symptom: the animations BETWEEN FILL STATES do not scale with playback speed. The
erase sweep (B18) and op-glow decay already track speed; this is about the cell
FILL transitions (empty to programmed reveal, per-page reveal, the erase drain).

## How OLD timed fill animation (the reference)

OLD `viz.js` WAS the timed player. Per playback step it set a running duration:

    runStep(i):  curAnimMs = isFinite(scale) ? clamp(step.ns / scale, MIN_ANIM=110, MAX_ANIM=9000) : MIN_ANIM

and each fill-changing step wrote that onto the fill element as an INLINE
transition-duration, overriding the fixed CSS base:

    progPage(p):   fillEls[p].style.transitionDuration = curAnimMs + 'ms'; paint(p)
    eraseSector(): fillEls[base+k].style.transitionDuration = curAnimMs + 'ms'; shown=0; paint()   // drain over the erase slot

`scale` reached viz through `viz.setScale(simNsPerRealMs)` (OLD viz.js:515), forwarded
by the speed slider. So every fill reveal / drain animated over its real-time slot
(step.ns / scale): fast to 110 ms at the floor, up to seconds at deep slow-mo.

The base CSS `.cell .fill{ transition: height .18s ease }` is byte-identical old and new;
OLD just OVERRODE its duration inline per step.

## Per-animation table

| Animation (fill-state) | OLD duration / constant | OLD scaling | CURRENT | Verdict |
|---|---|---|---|---|
| Fill height REVEAL (empty→programmed, per page) | inline `transitionDuration = clamp(step.ns/scale, 110, 9000)` over CSS `.fill transition:height .18s` | YES — slot = step.ns/scale | `paint()` sets height only; transition-duration left at the fixed CSS **180 ms**; viz has no `scale` | **BUG — scale-blind (frozen at 180 ms)** |
| Fill DRAIN on erase (height→0) | `eraseSector` set `transitionDuration = curAnimMs` (= erase slot ns/scale = the erase `ms`) | YES — erase slot / scale | `eraseSectorLocal()`→`paint()` height 0 at the fixed **180 ms**; the worker-computed `ev.ms` IS in hand but unused for the fill | **BUG — scale-blind; ev.ms ignored for the fill** |
| Erase SWEEP (sector box-shadow) | `Element.animate(eraseKF, curAnimMs)` | YES | `sweep(sector, ev.ms)`, `ev.ms` = worker `clamp(ns/scale,110,9000)` | OK (B18) |
| Read/prog GLOW heat decay | `frame()` decay, half-life `clamp(HEAT_HALF_MS*REF/scale, 50, 3000)` | YES | worker `snapshotHeat(scale)`, same formula | OK — intentional §6 relocation |
| Cell STATE COLOR (live→obsolete / meta / wl) | `.cell[data-live] .fill{ background }`; background is NOT in the `.fill` transition list | NO — instant swap | identical CSS | Not a regression (instant in both; OLD never timed it) |
| Wear TINT `--wc` | `.die.heat .sector{ background: var(--wc) }`, no transition | NO — instant | identical CSS | Not a regression (instant in both) |

So the ONLY lost scaling is the fill HEIGHT transition (reveal + erase drain). The
color/wear transitions the symptom also lists were instant in OLD too, so matching OLD
means leaving them instant, not adding new timed animation.

## Root cause

The ADR-0024 rewrite moved the timed player into the worker (§6) and made viz a pure
paint layer fed full-state `shown` snapshots. Two things that OLD viz did for the fill
transition were dropped and never re-homed:

1. viz lost its `setScale` input — it no longer knows playback speed at all.
2. `paint()` no longer writes an inline `transitionDuration`, so the fill height change
   runs at the fixed CSS 180 ms regardless of speed.

This is NOT covered by the intended §6 relocations: `protocol.js` keeps CONTINUOUS glow
on `heat` (worker-decayed, scale-aware) and the DISCRETE erase on `events.ms`, but the
fill-height REVEAL is neither heat nor an erase event, so it must be timed by viz from
`scale` exactly as OLD did. `lockstep.js:54` even documents `scale` as "the numeric copy
the die animation also uses" — scale is meant to reach viz; the wiring was just dropped.

Consequence: fills look about right only where the fixed 180 ms happens to be near the
scaled slot (roughly the fast / low-slow-mo band), and wrong (too fast, effectively
frozen at 180 ms) elsewhere — the same shape as the earlier glow-at-slow-speed and
TAPE_CAP scale-blindness bugs.

## Proposed fix (contained; viz.js + playground.js, both owned)

Restore OLD's mechanism, adapted to the snapshot model. No protocol / grant / worker-player
change (does not touch lockstep pacing, the wire, or the §6 player contract).

- viz.js: re-add `setScale(simNsPerRealMs)` (OLD name/semantics). Derive the reveal
  duration `curFillMs = isFinite(scale) ? clamp(FILL_REF_NS/scale, MIN_ANIM, MAX_ANIM) : MIN_ANIM`,
  where `FILL_REF_NS = PROG_NS_PER_BYTE(5937, device.js ESP32S3) * pageSize` — i.e. one
  page's program time, exactly OLD's per-page `step.ns` for a full page. `paint()` writes
  `fillEls[p].style.transitionDuration` (curFillMs by default) BEFORE the height change.
  The erase drain paints the cleared pages with `ev.ms` (already scale-correct), so the
  drain matches OLD's `curAnimMs = erase-slot/scale`.
- playground.js `applySpeed`: forward the computed `scale` to each session's viz
  (`st.viz.setScale(scale)`), alongside the existing `coordinator.setSpeed(scale)`.

Does NOT cap / throttle / sample / coalesce anything (ADR-0022 veto honored): every op
still reveals its own page; only the transition DURATION tracks speed.

## Applied + verification (done)

Fix applied to `web/src/viz.js` (`setScale` + `PROG_NS_PER_BYTE`/`FILL_REF_NS`/`curFillMs`,
`paint(p, fillMs)` writes the scaled transition-duration, erase drain uses `ev.ms`) and
`web/src/playground.js` (`applySpeed` forwards `scale` to every session's viz). No change to
lockstep/protocol/worker.

Load-bearing test added to `scripts/viz-frame-test.mjs` (real viz.js against the fake DOM,
capturing every fill `transitionDuration` write):
- reveal duration scales with speed: fast 110 ms (floor) < slow 506 ms;
- slow-mo reveal == `clamp(page-program-ns / scale)` == 507 ms (the pre-0024 per-page slot);
- fast + no-delay floor at MIN_ANIM 110 ms;
- erase drain rides `ev.ms` (7000 ms), not the reveal slot.

Suites green foreground (real WASM built: fastffs + littlefs): viz-frame, session-worker,
coord-wire, playground-boot, worker-conformance, lockstep-concurrency, tape-leak.
