# Lane V (main-thread consumer) — report

Branch: `lane/viz`, worktree `/Users/benh/git/flashvis-viz`. Scope: ADR-0024
main-thread render/telemetry consumer — `web/src/viz.js` (pure renderer) and
`web/src/playground.js` (worker spawn + PULL/FRAME/TELEMETRY wiring).

## What's built (committed)

**`web/src/viz.js` — rewritten as a pure FRAME renderer.** Removed everything
that moved worker-side per ADR-0024 §6 (accumulation, the timed per-op
player, `device.onEvent` intake, `queue`/`cur`/`scale`/`prep`,
`setScale`/`setPrep`/`flush`/`barrier`/`pending`). `createViz(geometry)` now
takes geometry only — no device/runner reference, it never touches simulated
flash. New surface: `applyFrame(frame)`, called once per pulled FRAME
(nominally once/rAF for the focused session), which:
- paints `shown.pages`/`shown.wear` as a full-state diff (unchanged `paint()`
  math),
- renders `heat.read`/`heat.prog` — already-decayed full-state arrays, same
  two-channel coalesced-glow math as before (ADR-0022's veto holds
  unchanged: still zero per-op `animate()`, still O(active cells) render,
  now scanned in O(geometry) per the ADR's own accounting — see §6 "pull
  O(geometry), not O(ops)"),
- applies `liveMap.classes` when `liveMap` is present (version > since),
- processes `events[]` for the two discrete triggers a full-state snapshot
  can't represent: `kind:'erase'` fires the single `Element.animate()`
  sector sweep (ADR-0022) and clears that sector's pages; `kind:'reset'`
  does the full-die clear the old `device.onEvent('reset', …)` path did.

Kept unchanged in substance: inspector (`sectorInfo`/`renderInspector`),
wear-heatmap toggle (now reads a locally-mirrored `wearArr` instead of
`device.wear`), theme re-sourcing (`refreshTheme`), `liveCounts()`,
`metrics()`, `mountDie()` DOM structure.

Verified by `scripts/viz-frame-test.mjs` (16 checks, passing): heat
coalescence bound (100-op vs 30000-op coalesced frame render identically,
zero `animate()` calls — the ADR-0022 hard veto, re-verified against the new
contract), dual-channel read+program blend, decay-to-zero clears the resting
ring, shown/wear/liveMap snapshot painting, exactly-one-`animate()`-per-erase-
event, reset-event full clear.

**`web/src/session-client.js` (new) — the main-thread PULL/FRAME/TELEMETRY
facade for one worker-backed session.** `createSessionClient({port, fsId,
name, geometry, epoch})`: sends `INIT` on construction; `pull()` sends `PULL`
only while focused (unfocused sessions stream nothing, §7) and marks the
*next* pull after a focus-on as a fresh re-attach (`journal.newest`/
`events` since 0) so it lands as the snap repaint; `onFrame`/`onTelemetry`
subscriptions; discards any message whose `epoch` doesn't match current (I5);
`rebase(epoch)` for reset/teardown; `dispose()`. Deliberately does **not**
send `ENTRIES`/`GRANT` or read `grantAck` — that's the coordinator's §2
clock-release algebra, out of this lane's scope per the brief.

Verified by `scripts/session-client-test.mjs` (14 checks, passing) against
`scripts/mock-worker-transport.mjs` with a small hand-rolled fake worker-side
responder (no real worker/session.js needed).

**Retired `scripts/viz-heat-test.mjs`**, superseded by `viz-frame-test.mjs`
(same intent — the ADR-0022 heat-coalescence bound — re-expressed against the
new `applyFrame` contract). Repointed `package.json`'s `test`/`test:vizheat`
accordingly (`test:vizframe`, `test:sessionclient` added).

## What's NOT built: `playground.js`

I did not touch `web/src/playground.js`. Below is why, concretely, rather
than a schedule slip — this is a cross-lane contract gap, not a work-volume
problem.

Today's `playground.js` drives everything (die render, HUD, tape, compare
strip, focus, console/buttons) through **synchronous session objects** it
gets from `session.js` and hands to `lockstep.js`'s `createLockstep(...)`.
Both those modules are still the pre-0024 in-process implementation in this
worktree (unconverted — that's lanes S and C's work, not landed here yet).
The brief preserves `lockstep.js`'s **outer** call surface
(`setSessions`/`broadcast`/`snapshots`/`waitStates`/`setSpeed`/`setMode`/
`reset`/`step`), but nearly everything `playground.js` does today reaches
*through* that surface into synchronous per-session state
(`session.device.stats.simNs`, `session.pending()`, `session.runCommand(...)`,
`session.onJournal(...)`, `session.livenessCounts()`, …) that literally
cannot stay synchronous once the session lives in a worker. So the *inner*
shape of whatever object `setSessions([...])` will take is necessarily
different post-0024, and that shape is lane C's to define (the §2
watermark/grant math needs global cross-session state
`max over s in S`, which can only live in the coordinator).

Two concrete unknowns block a safe rewrite:

1. **Who spawns the `Worker` and who owns its single message-handler slot?**
   The brief says playground.js spawns a worker per session. But a
   port/Worker exposes one `onmessage` slot (not `addEventListener`-style
   fan-out — `mock-worker-transport.mjs`'s `Port` models this faithfully).
   The coordinator needs `grantAck` off that same port for its §2 algebra;
   this lane needs `frame`/`telemetry`. Something has to demux by message
   type before either consumer sees it — either a shared per-session router
   (whose lane?), or the coordinator front any worker itself and hand this
   lane a narrower "frame/telemetry only" view. `session-client.js` is built
   to accept *either* — any port-shaped object — so it's ready the moment
   this is settled, but I don't want to guess the demux owner and bake a
   shape lockstep.js then has to bend around.

2. **What does the new "session" object `setSessions()`/`broadcast()` take?**
   Not knowing this, I can't rewire `injectCommand`, the tape (`onJournal` →
   journal-pull per the brief), `setFocus`, or the compare strip without
   inventing lockstep.js's contract myself — a real risk of producing
   something that conflicts with lane C's actual implementation and gets
   thrown away.

Per the standing protocol ("if your brief is invalidated by a surprise,
raise it as a question — don't assume"), I'm stopping here rather than
guessing. **What I'd want from you (or lane C) to unblock**: the shape lane
C's `lockstep.js` will expect from a worker-backed session in
`setSessions()`, and who owns the per-session port's message demux. Once
that's pinned, wiring `playground.js`'s die-render + HUD + focus-switch onto
`session-client.js` (already built and tested) should be mechanical: a
`requestAnimationFrame` loop calling `focusedClient.pull()` +
`viz.applyFrame()`, and `onTelemetry` callbacks feeding the HUD/compare-strip
fields that today read `session.refreshHUD`/`refreshLiveness`/
`coordinator.snapshots()`.

## Open questions / protocol gaps

1. **`FrameMsg.events[]` entry shape is unspecified in `protocol.js`.** I
   need a discrete per-sector-erase trigger (the sweep is a one-shot
   `Element.animate()`, not a state diff a full snapshot can represent) and a
   full-clear trigger for reset/format. I implemented and tested against an
   assumed shape: `{id, kind:'erase'|'reset', sector?, ms?}` (`ms` = the
   worker-computed animated slot duration, falling back to the old
   `MIN_ANIM` floor if absent). This is a guess, clearly isolated in
   `viz.js`'s `applyEvents()` — please pin the real shape in `protocol.js`
   (or tell me it's wrong) so the worker side and this renderer agree.
2. **`FrameMsg.shown`/`.heat`/`.liveMap` internal structure** isn't spelled
   out either, but the ADR's own byte-size accounting (`shown⊕wear ~2.3KB`,
   `heat ~8KB`, `liveMap ~1KB` at the 64×16-page/256-sector geometry) pins
   the structure almost uniquely: `shown = {pages: Uint16Array-like[1024],
   wear: Uint32Array-like[64]}`, `heat = {read, prog}` two
   Float32Array-likes[1024], `liveMap = {version, classes:
   Uint8Array-like[1024]}`. I built against this with high confidence (the
   byte math checks out exactly) but it's still inference, not a pinned
   contract — flagging so it's confirmed, not assumed, once protocol.js
   grows JSDoc-level field shapes.
3. **The playground.js blocker above** — cross-lane contract, not a protocol
   field gap, but the concrete thing standing between what's built here and
   an integrated page.

## Verification run

- `node scripts/viz-frame-test.mjs` — PASS (16 checks)
- `node scripts/session-client-test.mjs` — PASS (14 checks)
- `node --check` on all touched/new files — OK
- Did **not** run the full `npm test` suite: no `dist/*.mjs` WASM build exists
  in this worktree (build step not run this session — real filesystem builds
  are out of scope for this lane), and several of those tests
  (`fatfs-render-test.mjs`, `dom-smoke.mjs`, the FS integrity/concurrency
  suites) boot `session.js`+`lockstep.js` together against the OLD
  synchronous contract, which this change and the still-unconverted
  session.js/lockstep.js are jointly mid-migration on — expected red until
  lanes S/C land, not a regression introduced here beyond the intentional
  `createViz(device)` → `createViz(geometry)` signature change.

## Files touched

- `web/src/viz.js` — rewritten (pure renderer)
- `web/src/session-client.js` — new
- `scripts/viz-frame-test.mjs` — new (replaces `viz-heat-test.mjs`, deleted)
- `scripts/session-client-test.mjs` — new
- `package.json` — `test:vizheat` → `test:vizframe`; added `test:sessionclient`

Not touched: `web/src/playground.js`, `web/index.html`, `web/src/session.js`,
`web/src/lockstep.js`, `web/src/protocol.js`, `web/src/runner.js`,
`web/src/device.js`.
