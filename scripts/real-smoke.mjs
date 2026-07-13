/*
 * Real-backend smoke: boot the WHOLE playground against the REAL shipped backend
 * (lockstep.js + session.js + real WASM FASTFFS/LittleFS) under a fake DOM, and
 * drive the compare modes end to end. This is the counterpart to dom-smoke.mjs,
 * which runs the UI against scripts/stub-backend.mjs: the stub is deterministic
 * and fast but has NO real race clock, real timing, or real WASM, so backend
 * behavior (Race pacing, the Pace<->Race reseat, workload-op telemetry, the
 * stall indicator) can only be exercised here. Anything that reads
 * coordinator.snapshots() and renders it belongs under this guard.
 *
 * We do NOT install globalThis.__flashvisBackend, so playground.js imports its
 * real session.js/lockstep.js. Requires the built dist/*.mjs (npm run build:*).
 */
import { installFakeDom } from './fake-dom.mjs';

const dom = installFakeDom();
process.on('unhandledRejection', (e) => { console.error('\nFAIL — unhandled rejection:', e && e.stack || e); process.exit(1); });
function fail(msg) { console.error('\nFAIL —', msg); process.exit(1); }

// Disable the hold-pin show-threshold (playground HOLD_SHOW_MS): the debounce
// is real-time while this harness pumps a fake frame clock, so with it on the
// card `.waiting` polls below would race wall-clock instead of deterministically
// tracking the raw unified waitStates() signal (which is what the assertions
// pin down; the debounce itself is a trivial display-side delay).
globalThis.__flashvisHoldShowMs = 0;

await import('../web/src/playground.js');   // starts boot() against the REAL backend

// ---- wait for boot() (real WASM load + format + mount both FS) ----
let ready = false;
for (let i = 0; i < 800 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  ready = dom.getEl('bootStatus').textContent === 'ready';
}
if (!ready) fail('playground never reached bootStatus "ready" against the real backend (boot hung or threw)');

const tick = async (n) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 0)); dom.tick(1); dom.runIntervals(); } };
const g = (id) => dom.getEl(id);
const card = (fs) => ({
  v: g('fsV-' + fs)?.textContent ?? '', tag: g('fsTag-' + fs)?.textContent ?? '',
  bar: g('fsBar-' + fs)?.style.width ?? '', waiting: !!g('fsCard-' + fs)?.classList.contains('waiting'),
});
const tapeText = () => g('tape').children.map((c) => c.textContent).join('\n');
const FS = ['fastffs', 'littlefs', 'spiffs', 'jesfs', 'fatfs'];

// ---- all FS live, cards + geometry built (redesign A1/A5) ----
if (g('dieStack').children.length !== FS.length) fail(`expected ${FS.length} mounted dies, got ${g('dieStack').children.length}`);
for (const fs of FS) if (!g('fsCard-' + fs)) fail(`fs card missing for ${fs}`);
const geo = g('geoLine').innerHTML || g('geoLine').textContent || '';
if (!geo.includes('NOR')) fail(`geometry line looks wrong: "${geo}"`);
if (/SOP-8/.test(geo)) fail('geometry line still says "SOP-8" (should be scrubbed)');

// ---- Page-load boot fast-forward (UI spec: the load-triggered reset/boot
// animation and delay must not stand between load and a usable page). Boot
// runs help()/format() in PREP mode (ADR-0014) — full speed, no animation, no
// await-pacing, still logged with real simulated cost — so there is no boot
// drain left for anyone to hold behind; that showcase moved to the header-
// Reset replay below, which stays fully animated. Assert the fast-forward
// actually happened: format() lands on the tape with a real cost within a
// SMALL bound of frames after "ready" (proving speed, not just eventual
// completion), and no FS card ever shows "waiting" along the way — nothing
// should ever stall behind a page-load boot again. ----
const BOOT_FRAME_BOUND = 30;   // generous but small — a fast-forwarded boot should settle in a handful of frames
let bootFormatDone = false, bootSawWaiterFF = false, bootFrames = 0;
for (; bootFrames < BOOT_FRAME_BOUND && !bootFormatDone; bootFrames++) {
  await tick(1);
  if (FS.some((fs) => card(fs).waiting)) bootSawWaiterFF = true;
  bootFormatDone = /format\(\)\s*→/.test(tapeText());
}
if (!bootFormatDone) fail(`boot's format() never landed on the tape within ${BOOT_FRAME_BOUND} frames of "ready" — the page-load fast-forward isn't working:\n${tapeText()}`);
if (bootSawWaiterFF) fail('an FS card showed "waiting" during page-load boot — nothing should ever hold behind a fast-forwarded boot replay');
for (const fs of FS) if (card(fs).waiting) fail(`${fs} still shows "waiting" right after boot settled — players should already be fully drained`);
if (Number(g('sFiles').textContent) !== 0) fail(`boot should land on an empty, formatted, usable chip; HUD shows sFiles="${g('sFiles').textContent}"`);

// ---- Header Reset, exercised right after boot: the "holding on the wrong FS"
// showcase now lives HERE instead of at page-load boot — Reset's replayed
// format() is NEVER fast-forwarded (only page-load boot is; see the UI spec),
// so it keeps the full animated sweep. While it drains, SPIFFS's 64-erase
// sweep far outlasts every other FS's format, so the fast FSs go idle waiting
// on it and may flag holding — but SPIFFS itself, the laggard actively
// draining its own animation, must NEVER flag (the original user-visible
// bug). Also re-asserts format() lands with a real (non-fast-forwarded) cost
// and the chip is usable (0 files) afterwards. ----
dom.dispatch('btnReset');
if (g('runLabel').textContent !== 'Run') fail('Reset should leave the sim paused (runLabel "Run")');
if (!/help\(\)/.test(tapeText())) fail(`Reset should replay the boot log (help()) on the tape:\n${tapeText()}`);
let resetSawWaiter = false, resetSpiffsFlagged = false, resetDrained = false, resetFormatSettled = false;
for (let i = 0; i < 800 && !(resetFormatSettled && resetDrained); i++) {
  await tick(1);
  const w = FS.filter((fs) => card(fs).waiting);
  if (w.length) resetSawWaiter = true;
  if (w.includes('spiffs')) resetSpiffsFlagged = true;
  resetDrained = resetSawWaiter && w.length === 0;   // waiters appeared, then all cleared = round done
  resetFormatSettled = /format\(\)\s*→/.test(tapeText());
}
if (!resetFormatSettled) fail(`Reset's replayed format() never completed on the tape:\n${tapeText()}`);
if (!resetSawWaiter) fail('no FS ever showed holding during the Reset replay\'s format drain (the fast FSs idle on SPIFFS\'s 64-erase sweep and should flag — Reset stays fully animated, unlike page-load boot)');
if (resetSpiffsFlagged) fail('SPIFFS (the Reset-replay format laggard, actively draining its own animation) flagged holding — the wrong-FS bug');
if (!resetDrained) fail('the Reset replay\'s format round never drained to all-clear within the poll bound');
if (Number(g('sFiles').textContent) !== 0) fail(`Reset should land on an empty, formatted chip; HUD shows sFiles="${g('sFiles').textContent}"`);

// ---- Pace: running advances real flash time; readouts are sane (no NaN) ----
// Poll rather than fixed-wait: Pace's first churn round starts only after every
// session's player drains its boot format, and SPIFFS's format erases all 64
// sectors (~1.4 s simulated) — far slower than FASTFFS's 2-erase format.
const vBefore = card('fastffs').v;
dom.dispatch('btnRun');
let advanced = false;
for (let i = 0; i < 3000 && !advanced; i += 50) { await tick(50); advanced = card('fastffs').v !== vBefore; }
if (!advanced) fail('Pace running did not advance flash time (churn not driving the real device?)');
for (const fs of FS) { const c = card(fs); for (const [k, val] of Object.entries(c)) if (/NaN|undefined/.test(String(val))) fail(`${fs}.${k} = ${val} in Pace`); }
if (!/ms\/op|µs\/op/.test(card('fastffs').tag)) fail(`Pace tag should be a per-op time, got "${card('fastffs').tag}"`);

// ---- Race: vital flips to workload "ops done" (an integer), tag to ops/s ----
dom.dispatch('modeWheel');
await tick(120);
if (g('fsL-fastffs').textContent !== 'ops done') fail(`Race vital label should be "ops done", got "${g('fsL-fastffs').textContent}"`);
if (!/^\d+$/.test(card('fastffs').v)) fail(`Race vital should be an integer op count, got "${card('fastffs').v}"`);
if (!/ops\/s$/.test(card('fastffs').tag)) fail(`Race tag should end "ops/s", got "${card('fastffs').tag}"`);

// ---- The stall indicator (Race analog of pace holding): run Pace long enough to
// diverge the FSs in flash time, switch to Race (raceClock reseats to the min, so
// every ahead FS is stalled until the clock climbs), and watch the cards. Ahead
// FSs must read "waiting"; the FRONTIER FS — the min-flash-time laggard defining
// the reseated clock's floor, i.e. the one everybody is waiting FOR — must NEVER
// be flagged (the "holding on the wrong FS" bug). ----
dom.dispatch('modeWheel');          // back to Pace
await tick(400);                    // let flash time diverge
// Identify the frontier BEFORE switching: in Pace the card vital is that FS's
// own flash time, so the smallest parsed time marks the laggard/frontier.
const parseTimeMs = (t) => { const m = String(t).match(/([\d.]+)\s*(ms|s)$/); return m ? parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) : NaN; };
const paceMs = Object.fromEntries(FS.map((fs) => [fs, parseTimeMs(card(fs).v)]));
for (const fs of FS) if (!(paceMs[fs] > 0)) fail(`could not parse ${fs}'s Pace flash-time vital ("${card(fs).v}") to find the frontier`);
const frontierFs = FS.reduce((a, b) => (paceMs[a] <= paceMs[b] ? a : b));
dom.dispatch('modeWheel');          // -> Race; the ahead FSs should stall

// With N participants, every FS ahead of the reseated clock may wait at once —
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
if (sawFrontierWaiting) fail(`Race stall indicator flagged the FRONTIER FS (${frontierFs}, min flash time — the laggard the others wait on); the laggard must never show holding`);

// ---- typed gc() must report + glow exactly like churn-driven GC (fix: used to
// route through the undefined api.fs.gcStep and silently do nothing). Pause
// first so churn/gc auto-workload lines don't drown out the assertion. ----
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
if (!gcReported) fail(`typed gc() never produced a timed "gc() → …" result line on the tape:\n${tapeText().split('\n').slice(-8).join('\n')}`);
if (g('tape').children.length <= preGcLen) fail('typed gc() did not grow the tape at all');

// ---- header Reset again, this time after a long Pace/Race/gc() session: stop,
// re-format every FS (files/stats back to 0), wipe the tape, and replay the
// boot log (help()/format()) — no page reload. The holding showcase is
// exercised above, right after boot, in a clean coordinator state; this
// second Reset is deliberately the simpler smoke check (tape wipe + replay +
// files back to 0) — a fuller assertion here would need to reach quiescence
// after substantial prior Pace/Race churn, which is its own can of worms
// (see the note in the report about a Reset-after-heavy-Race-activity
// coordinator issue found but left alone as out of scope for this change). ----
if (g('runLabel').textContent !== 'Pause') dom.dispatch('btnRun');   // get something running again
await tick(60);
dom.dispatch('btnReset');
if (g('runLabel').textContent !== 'Run') fail('Reset should stop a running sim (runLabel back to "Run")');
if (tapeText().includes('gc()')) fail(`Reset should wipe the pre-reset tape, but it still shows old entries:\n${tapeText()}`);
if (!/help\(\)/.test(tapeText())) fail(`Reset should replay the boot log (help()) on the tape:\n${tapeText()}`);
let formatSettled = false;
for (let i = 0; i < 200 && !formatSettled; i++) {
  await tick(1);
  formatSettled = /format\(\)\s*→/.test(tapeText());
}
if (!formatSettled) fail(`Reset's replayed format() never completed on the tape:\n${tapeText()}`);
if (Number(g('sFiles').textContent) !== 0) fail(`Reset should return the focused FS to 0 files, HUD shows sFiles="${g('sFiles').textContent}"`);
if (/NaN|undefined/.test(card('fastffs').v)) fail(`fastffs vital looks wrong after Reset: "${card('fastffs').v}"`);

console.log('PASS — real backend: all FS boot on real WASM; page-load boot fast-forwards past the');
console.log('       reset/boot animation (format() lands on the tape within a small frame bound,');
console.log('       nothing ever shows "waiting"); the header Reset control — which stays FULLY');
console.log('       animated, unlike page-load boot — replays the holding showcase (fast FSs may');
console.log('       flag while SPIFFS drains, SPIFFS itself never does); Pace advances flash time;');
console.log('       Race shows workload "ops done" + ops/s; geometry has no "SOP-8"; after a');
console.log('       Pace->Race divergence the stall indicator fires for ahead FSs only — never all');
console.log('       at once, never the frontier (min flash time) FS; typed gc() reports timing/op-');
console.log('       stats on the tape like churn-driven GC; and a second Reset after that activity');
console.log('       still wipes+replays the tape, landing one replayed format with files back to 0.');
