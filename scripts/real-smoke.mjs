/*
 * Real-backend smoke (ADR-0024 worker wire): boot the WHOLE playground against
 * the REAL shipped backend (lockstep.js coordinator + session-proxy.js +
 * session-worker.js host + real WASM FASTFFS/LittleFS/SPIFFS/JesFS/FAT+WL)
 * under a fake DOM, and drive the compare modes end to end.
 *
 * Counterpart to the STUB whole-playground boot (playground-boot-test.mjs): that
 * one installs a __flashvisWorkerConnect over the mock transport with a STUB
 * runner (no real WASM, no real clock) and proves the wire + page mechanics.
 * This one installs the REAL-runner seam (scripts/real-worker-connect.mjs: the
 * SAME in-realm host over the SAME mock transport, but the real WASM runner), so
 * it can exercise what a deterministic stub CANNOT: real per-FS simulated flash
 * cost driving the coordinator's Race clock. This suite keeps ONLY those
 * real-clock/real-WASM behaviors:
 *   - Pace pacing: running advances real simulated flash time; the card's bottom
 *     rate reads a real per-op flash time.
 *   - Race workload-op telemetry: the bottom rate flips to a real ops/s and the
 *     ops total climbs as real WASM writes land.
 *   - Pace<->Race reseat + stall indicator: after Pace diverges the FSs in flash
 *     time, switching to Race reseats the clock to the min (frontier); every
 *     AHEAD FS stalls until the clock climbs, but the frontier FS (min flash
 *     time, the laggard everyone waits FOR) must NEVER flag holding.
 *   - typed gc(): reports a real timed "gc() -> N ms" line on the worker tape.
 *
 * Everything a stub already proves is covered elsewhere and NOT re-asserted here:
 *   - boot reaches ready, one die per session, focus switch, tape help()/format()
 *     echo, console-driven writes, Run gates churn, both-totals-in-both-modes,
 *     RC-A focus no-replay: playground-boot-test.mjs.
 *   - the static geometry line (NOR / no "SOP-8"): playground-boot-test.mjs.
 *   - Race/Pace pacing algebra, reseat + holding signals on the real coordinator
 *     over real WASM: lockstep-concurrency-test.mjs (worker-harness.mjs).
 *
 * NOTE on the retired pre-0024 assertions (see LANE report): the old suite drove
 * the pre-0024 single-"vital" card DOM (fsV-/fsL-, a value that FLIPPED between
 * flash time and an "ops done" label by mode) and expected the header Reset to
 * stay FULLY ANIMATED with a format-drain holding showcase. Both are obsolete on
 * this branch: the ADR-0024 card ALWAYS shows both totals (fsTime + fsOps), only
 * the bottom rate switches (spec/ui.md "FS cards"), and the header Reset now
 * replays through the SAME prep-wrapped, fast-forwarded bootSequence() as
 * page-load boot (playground.js btnReset; spec/ui.md "Page load"/"Header Reset"),
 * so it no longer animates a holding sweep. Those assertions were dropped.
 *
 * Requires the built dist/*.mjs (npm run build:*), same as the concurrency suite.
 */
import { installFakeDom } from './fake-dom.mjs';
import { installRealWorkerConnect } from './real-worker-connect.mjs';

// Wire playground.js's connectWorker seam to a REAL worker host (real WASM) over
// the mock transport BEFORE importing playground.js (its boot() connects on
// import). Node has no `new Worker`, so without this the boot throws
// `Worker is not defined`.
const realConnect = installRealWorkerConnect();

const dom = installFakeDom();
process.on('unhandledRejection', (e) => { console.error('\nFAIL, unhandled rejection:', e && e.stack || e); process.exit(1); });
function fail(msg) { console.error('\nFAIL:', msg); process.exit(1); }

// Disable the hold-pin show-threshold (holdDebounceMs): the debounce is
// real-time while this harness pumps a fake frame clock, so with it on the card
// `.waiting` polls below would race wall-clock instead of deterministically
// tracking the raw unified waitStates() signal (which is what the assertions pin
// down; the debounce itself is a trivial display-side delay).
globalThis.__flashvisHoldShowMs = 0;

await import('../web/src/playground.js');   // starts boot() against the REAL backend

const g = (id) => dom.getEl(id);
const tick = async (n) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 0)); dom.tick(1); dom.runIntervals(); } };
// ADR-0024 FS card DOM (spec/ui.md "FS cards"): both totals always show; only
// the bottom rate tag switches by mode. `time` = total flash time (simNs), `ops`
// = total fileOpCount, `tag` = per-op flash time (Pace) or ops/s (Race).
const card = (fs) => ({
  time: g('fsTime-' + fs)?.textContent ?? '', ops: g('fsOps-' + fs)?.textContent ?? '',
  tag: g('fsTag-' + fs)?.textContent ?? '', waiting: !!g('fsCard-' + fs)?.classList.contains('waiting'),
});
const tapeText = () => g('tape').children.map((c) => c.textContent).join('\n');
const FS = ['fastffs', 'littlefs', 'spiffs', 'jesfs', 'fatfs'];
// Over the ADR-0024 worker wire the boot/Reset replay is ASYNC: broadcast ->
// worker journal echo -> pull -> tape, across several macrotasks (unlike the
// pre-0024 synchronous main-thread session). Poll (pump frames) until a tape
// predicate holds rather than asserting synchronously right after a dispatch.
const pollUntil = async (pred, frames = 400) => { for (let i = 0; i < frames && !pred(); i++) await tick(1); return pred(); };

// ---- wait for boot() (real WASM load + init + broadcast format on all 5 FS) ----
let ready = false;
for (let i = 0; i < 800 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  ready = g('bootStatus').textContent === 'ready';
}
if (!ready) fail('playground never reached bootStatus "ready" against the real backend (boot hung or threw)');
if (g('dieStack').children.length !== FS.length) fail(`expected ${FS.length} mounted dies on real WASM, got ${g('dieStack').children.length}`);

// ---- Page-load boot fast-forward (spec/ui.md "Page load"): the load-triggered
// reset/boot runs in the ADR-0009 prep bracket (playground.js bootSequence:
// prep(true) … help()/format() … prep(false)), full speed, no metering, no
// animation, still logged with real simulated cost. So the real format() lands
// on the tape within a SMALL frame bound of "ready" (proving the fast-forward,
// not just eventual completion). This is a real-WASM check: the format cost +
// tape line are produced by the real backend.
//   The real invariant is that nothing is left STUCK holding once the replay
// settles, not that a card can never flicker "waiting" for a macrotask or two
// while it runs: each FS's format() lands at a different real wall-clock cost
// (e.g. SPIFFS's 64-sector format vs FASTFFS's 2-erase format), so a fast
// session's ack can genuinely land a macrotask ahead of a slow peer's under
// CI's scheduling, a real but benign transient skew that clears on its own; it
// is not the sustained catch-up wait `holding` exists to show. So poll a short
// settle window AFTER format() lands and require every card to have cleared by
// then; a card still waiting at that point is a stuck hold, the real bug. ----
const BOOT_FRAME_BOUND = 40;
let bootFormatDone = false;
for (let i = 0; i < BOOT_FRAME_BOUND && !bootFormatDone; i++) {
  await tick(1);
  bootFormatDone = /format\(\)\s*→/.test(tapeText());
}
if (!bootFormatDone) fail(`boot's format() never landed on the tape within ${BOOT_FRAME_BOUND} frames of "ready", the page-load fast-forward isn't working:\n${tapeText()}`);
const BOOT_SETTLE_FRAMES = 20;
let stuckWaiter = null;
const bootSettled = await pollUntil(() => !FS.some((fs) => { const w = card(fs).waiting; if (w) stuckWaiter = fs; return w; }), BOOT_SETTLE_FRAMES);
if (!bootSettled) fail(`FS card "${stuckWaiter}" is still "waiting" ${BOOT_SETTLE_FRAMES} frames after boot's format() landed on the tape, a hold is stuck behind the fast-forwarded boot replay (not just a transient cross-FS timing flicker)`);
if (Number(g('sFiles').textContent) !== 0) fail(`boot should land on an empty, formatted, usable chip; HUD shows sFiles="${g('sFiles').textContent}"`);

// ---- Pace: running advances REAL simulated flash time; the bottom rate reads a
// real per-op flash time; readouts are sane (no NaN). Poll rather than
// fixed-wait: Pace's first churn round starts only after every session's player
// drains its boot format, and SPIFFS's format erases all 64 sectors (far slower
// than FASTFFS's 2-erase format). ----
const tBefore = card('fastffs').time;
dom.dispatch('btnRun');
let advanced = false;
for (let i = 0; i < 3000 && !advanced; i += 50) { await tick(50); advanced = card('fastffs').time !== tBefore; }
if (!advanced) fail('Pace running did not advance real flash time (churn not driving the real device?)');
for (const fs of FS) { const c = card(fs); for (const [k, val] of Object.entries(c)) if (/NaN|undefined/.test(String(val))) fail(`${fs}.${k} = ${val} in Pace`); }
if (!/ms\/op|µs\/op/.test(card('fastffs').tag)) fail(`Pace tag should be a per-op flash time, got "${card('fastffs').tag}"`);

// ---- Race: the bottom rate flips to a real ops/s and the ops total climbs as
// real WASM writes land (workload-op telemetry). The headline ops count is an
// integer in both modes (spec/ui.md); here we assert it actually ADVANCES under
// the real backend, and the rate reads ops/s. ----
dom.dispatch('modeWheel');
await tick(120);
if (!/ops\/s$/.test(card('fastffs').tag)) fail(`Race tag should end "ops/s", got "${card('fastffs').tag}"`);
if (!/^\d+$/.test(card('fastffs').ops)) fail(`Race ops total should be an integer, got "${card('fastffs').ops}"`);
const raceOpsBefore = card('fastffs').ops;
let raceOpsAdvanced = false;
for (let i = 0; i < 2000 && !raceOpsAdvanced; i += 50) { await tick(50); raceOpsAdvanced = card('fastffs').ops !== raceOpsBefore; }
if (!raceOpsAdvanced) fail(`Race did not advance the real workload op count (stayed "${raceOpsBefore}")`);

// ---- The stall indicator (Race analog of pace holding): run Pace long enough
// to diverge the FSs in flash time, switch to Race (raceClock reseats to the
// min, so every AHEAD FS is stalled until the clock climbs), and watch the
// cards. Ahead FSs must read "waiting"; the FRONTIER FS, the min-flash-time
// laggard defining the reseated clock's floor, i.e. the one everybody is waiting
// FOR, must NEVER be flagged (the "holding on the wrong FS" bug). This is
// purely a real-WASM behavior: the per-FS flash-time divergence that seeds the
// reseat comes from real simulated cost. ----
dom.dispatch('modeWheel');          // back to Pace
await tick(400);                    // let real flash time diverge
// Identify the frontier BEFORE switching: in Pace each card's flash-time TOTAL
// is that FS's own simNs, so the smallest marks the laggard/frontier.
const parseTimeMs = (t) => { const m = String(t).match(/([\d.]+)\s*(ms|s)$/); return m ? parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) : NaN; };
const paceMs = Object.fromEntries(FS.map((fs) => [fs, parseTimeMs(card(fs).time)]));
for (const fs of FS) if (!(paceMs[fs] > 0)) fail(`could not parse ${fs}'s Pace flash-time total ("${card(fs).time}") to find the frontier`);
const frontierFs = FS.reduce((a, b) => (paceMs[a] <= paceMs[b] ? a : b));
dom.dispatch('modeWheel');          // -> Race; the ahead FSs should stall

// With N participants, every FS ahead of the reseated clock may wait at once;
// only the frontier FS must never be flagged. So the invariant is "a nonempty
// PROPER subset waits, never including the frontier": all-N-waiting (or a
// flagged frontier) is the wrong-FS bug.
let sawAnyWaiter = false, sawAllWaiting = false, sawFrontierWaiting = false;
for (let round = 0; round < 12; round++) {
  await tick(8);
  const w = FS.filter((fs) => card(fs).waiting);
  if (w.length) sawAnyWaiter = true;
  if (w.length === FS.length) sawAllWaiting = true;
  if (w.includes(frontierFs)) sawFrontierWaiting = true;
}
if (!sawAnyWaiter) fail('Race stall indicator never fired after a Pace->Race divergence (the ahead FS should show "waiting")');
if (sawAllWaiting) fail('Race stall indicator flagged EVERY FS at once (the frontier FS should never wait)');
if (sawFrontierWaiting) fail(`Race stall indicator flagged the FRONTIER FS (${frontierFs}, min flash time, the laggard the others wait on); the laggard must never show holding`);

// ---- typed gc() must report a real timed result line on the worker tape (fix:
// used to route through the undefined api.fs.gcStep and silently do nothing).
// Pause first so churn/gc auto-workload lines don't drown out the assertion. ----
if (g('runLabel').textContent === 'Pause') dom.dispatch('btnRun');
const preGcLen = g('tape').children.length;
const input = g('terminput');
input.value = 'gc()';
input.dispatch('keydown', { key: 'Enter' });
let gcReported = false;
for (let i = 0; i < 200 && !gcReported; i++) {
  await tick(1);
  gcReported = /gc\(\)\s*→\s*[\d.]+\s*(ms|s|µs)/.test(tapeText());
}
if (!gcReported) fail(`typed gc() never produced a real timed "gc() → …" result line on the tape:\n${tapeText().split('\n').slice(-8).join('\n')}`);
if (g('tape').children.length <= preGcLen) fail('typed gc() did not grow the tape at all');

// ---- header Reset over the worker wire, clicked MID-ROUND after a long
// Pace/Race/gc() session with the sim RUNNING in Pace (so the click lands while
// a churn op is in flight): the reset-epoch regression (ADR-0024 lockstep reset
// epoch), a stale in-flight round used to wake after reset() and stomp the
// fresh cursors, leaving the replayed help()/format() wedged at ⧗ queued forever
// (dead console) or an FS card pinned "waiting" forever. Assert the full
// boot-identical replay lands over the wire: the sim pauses, the pre-reset tape
// is wiped and replayed (help()/format() reappear), the real format() settles
// with a real cost, the chip is usable (0 files), and no card is left wedged.
// (Reset is prep-wrapped/fast-forwarded now, same as page-load boot, so there is
// NO animated holding showcase to assert, see the header note.) ----
if (g('modeWheel').dataset.mode === 'race') dom.dispatch('modeWheel');   // back to Pace, the boot-default regime Reset replays into
if (g('runLabel').textContent !== 'Pause') dom.dispatch('btnRun');       // get something running again
await tick(60);                     // running Pace churn: a round is virtually always mid-drain now
dom.dispatch('btnReset');
if (g('runLabel').textContent !== 'Run') fail('Reset should stop a running sim (runLabel back to "Run")');
if (tapeText().includes('gc()')) fail(`Reset should wipe the pre-reset tape, but it still shows old entries:\n${tapeText()}`);
if (!await pollUntil(() => /help\(\)/.test(tapeText()))) fail(`Reset should replay the boot log (help()) on the tape:\n${tapeText()}`);
if (!await pollUntil(() => /format\(\)\s*→/.test(tapeText()))) fail(`Reset's replayed format() never completed on the tape (the mid-round Reset wedge):\n${tapeText()}`);
if (FS.some((fs) => card(fs).waiting)) fail('an FS card is left "waiting" after the mid-round Reset replay settled (a stale in-flight round wedged a pin, the reset-epoch regression)');
if (Number(g('sFiles').textContent) !== 0) fail(`Reset should return the focused FS to 0 files, HUD shows sFiles="${g('sFiles').textContent}"`);
for (const fs of FS) { const c = card(fs); for (const [k, val] of Object.entries(c)) if (/NaN|undefined/.test(String(val))) fail(`${fs}.${k} looks wrong after Reset: "${val}"`); }

realConnect.uninstall();
dom.uninstall();
console.log('PASS, real backend over the ADR-0024 worker wire (real WASM, real clock):');
console.log('       page-load boot fast-forwards the prep-wrapped format() onto the tape with a');
console.log('       real cost and never holds; Pace advances real flash time and reads a real per-op');
console.log('       rate; Race flips to a real ops/s and the op count climbs; after a Pace->Race');
console.log('       divergence the reseat stall fires for ahead FSs only, never all at once, never');
console.log('       the frontier (min flash time) FS; typed gc() reports a real timed line; and a');
console.log('       mid-round header Reset lands the full boot-identical replay with no wedged ⧗');
console.log('       queued commands and no stuck "waiting" pins (the reset-epoch regression).');
