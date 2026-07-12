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
const FS = ['fastffs', 'littlefs', 'spiffs', 'jesfs', 'fatfs'];

// ---- all FS live, cards + geometry built (redesign A1/A5) ----
if (g('dieStack').children.length !== FS.length) fail(`expected ${FS.length} mounted dies, got ${g('dieStack').children.length}`);
for (const fs of FS) if (!g('fsCard-' + fs)) fail(`fs card missing for ${fs}`);
const geo = g('geoLine').innerHTML || g('geoLine').textContent || '';
if (!geo.includes('NOR')) fail(`geometry line looks wrong: "${geo}"`);
if (/SOP-8/.test(geo)) fail('geometry line still says "SOP-8" (should be scrubbed)');

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
// diverge the two FS in flash time, switch to Race (raceClock reseats to the min,
// so the ahead FS is stalled until the clock climbs), and watch the cards. The
// ahead FS must read "waiting"; the FS at the frontier must NOT; and never both at
// once (that would be the flicker bug). ----
dom.dispatch('modeWheel');          // back to Pace
await tick(400);                    // let flash time diverge
dom.dispatch('modeWheel');          // -> Race; ahead FS should stall

// With N participants, every FS ahead of the reseated clock may wait at once —
// only the frontier FS (defining raceClock's floor) must never be flagged. So the
// invariant is "a nonempty PROPER subset waits": all-N-waiting is the flicker bug.
let sawAnyWaiter = false, sawAllWaiting = false;
for (let round = 0; round < 12; round++) {
  await tick(8);
  const w = FS.filter((fs) => card(fs).waiting);
  if (w.length) sawAnyWaiter = true;
  if (w.length === FS.length) sawAllWaiting = true;
}
if (!sawAnyWaiter) fail('Race stall indicator never fired after a Pace->Race divergence (the ahead FS should show "waiting")');
if (sawAllWaiting) fail('Race stall indicator flagged EVERY FS at once (the frontier FS should never wait)');

// ---- typed gc() must report + glow exactly like churn-driven GC (fix: used to
// route through the undefined api.fs.gcStep and silently do nothing). Pause
// first so churn/gc auto-workload lines don't drown out the assertion. ----
if (g('runLabel').textContent === 'Pause') dom.dispatch('btnRun');
const tapeText = () => g('tape').children.map((c) => c.textContent).join('\n');
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

// ---- header Reset: stop, re-format both FS (files/stats back to 0), wipe the
// tape, and replay the boot log (help()/format()) — no page reload. ----
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

console.log('PASS — real backend: both FS boot on real WASM, Pace advances flash time,');
console.log('       Race shows workload "ops done" + ops/s, geometry has no "SOP-8", the');
console.log('       Race stall indicator fires for the ahead FS (only) after a Pace->Race divergence,');
console.log('       typed gc() reports timing/op-stats on the tape like churn-driven GC, and the header');
console.log('       Reset control stops the sim, re-formats every FS, and wipes+replays the tape.');
