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
const FS = ['fastffs', 'littlefs'];

// ---- both FS live, cards + geometry built (redesign A1/A5) ----
if (g('dieStack').children.length !== 2) fail(`expected 2 mounted dies, got ${g('dieStack').children.length}`);
for (const fs of FS) if (!g('fsCard-' + fs)) fail(`fs card missing for ${fs}`);
const geo = g('geoLine').innerHTML || g('geoLine').textContent || '';
if (!geo.includes('NOR')) fail(`geometry line looks wrong: "${geo}"`);
if (/SOP-8/.test(geo)) fail('geometry line still says "SOP-8" (should be scrubbed)');

// ---- Pace: running advances real flash time; readouts are sane (no NaN) ----
const vBefore = card('fastffs').v;
dom.dispatch('btnRun');
await tick(200);
if (card('fastffs').v === vBefore) fail('Pace running did not advance flash time (churn not driving the real device?)');
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

let sawSingleWaiter = false, sawBothWaiting = false, sawAnyWaiter = false;
for (let round = 0; round < 12; round++) {
  await tick(8);
  const w = FS.filter((fs) => card(fs).waiting);
  if (w.length) sawAnyWaiter = true;
  if (w.length === 1) sawSingleWaiter = true;
  if (w.length === 2) sawBothWaiting = true;
}
if (!sawAnyWaiter) fail('Race stall indicator never fired after a Pace->Race divergence (the ahead FS should show "waiting")');
if (sawBothWaiting) fail('Race stall indicator flagged BOTH FS at once (should only be the FS ahead of the clock)');
if (!sawSingleWaiter) fail('Race stall indicator never showed exactly one waiter');

console.log('PASS — real backend: both FS boot on real WASM, Pace advances flash time,');
console.log('       Race shows workload "ops done" + ops/s, geometry has no "SOP-8", and the');
console.log('       Race stall indicator fires for the ahead FS (only) after a Pace->Race divergence.');
