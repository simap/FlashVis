/*
 * Dom-smoke: boot the WHOLE playground (control panel + viz + WASM FASTFFS)
 * headless in Node against a fake DOM, then drive one real op and assert the UI
 * reflected real device traffic. This is the end-to-end guard the unit-ish
 * fastffs/integrity tests don't cover: it exercises viz.js and playground.js,
 * not just the runner. It also exercises the lockstep coordinator (ADR-0016):
 * adding a second participant, Race-mode progress on both, and the display
 * switch rebinding the shared HUD/console to whichever session is shown.
 *
 * It imports playground.js dynamically AFTER the fake DOM is installed, because
 * the module boots itself on import.
 */
import { installFakeDom } from './fake-dom.mjs';

const dom = installFakeDom();
const fail = (msg) => { console.error('FAIL —', msg); dom.uninstall(); process.exit(1); };

// termout accumulates the playground's log lines; scan it for readiness / errors.
const termout = dom.getEl('termout');
const lines = () => termout.children.map((c) => ({ text: c.textContent, cls: c.className }));
const has = (needle, from = 0) => lines().slice(from).some((l) => l.text.includes(needle));
const errorsSince = (from = 0) => lines().slice(from).filter((l) => l.cls.includes('err'));

await import('../web/src/playground.js');   // starts boot()

// Let boot() resolve (it awaits the WASM module load), ticking frames meanwhile.
let ready = false;
for (let i = 0; i < 400 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1);
  ready = has('console ready');
}
if (!ready) fail('playground never reached "console ready" (boot hung or threw)');
if (errorsSince().length) fail(`errors logged during boot: ${errorsSince().map((l) => l.text).join(' | ')}`);

// Fire the HUD/liveness/compare intervals once so the spec line + compare row reflect the mounted FS.
dom.runIntervals();

// The active session mounted its own .die into the shared #dieStack container
// (one child per sector), and the spec line came from real geometry.
const dieStack = dom.getEl('dieStack');
if (dieStack.children.length !== 1) fail(`dieStack has ${dieStack.children.length} mounted dies, expected 1`);
let die = dieStack.children[0];
if (die.children.length !== 64) fail(`die has ${die.children.length} sectors, expected 64`);
const geo = dom.getEl('specGeo').textContent;
if (!/KB/.test(geo) || !/ESP32-S3 timing/.test(geo)) fail(`specGeo looks wrong: "${geo}"`);
if (!dom.getEl('specLive').textContent.includes('mounted')) fail('specLive not mounted');

// Drive a real write via the Write button, play it out, refresh the HUD.
dom.dispatch('btnWrite');
dom.tick(30);
dom.runIntervals();

if (errorsSince().length) fail(`errors after write: ${errorsSince().map((l) => l.text).join(' | ')}`);
const files = parseInt(dom.getEl('sFiles').textContent, 10);
if (!(files >= 1)) fail(`expected >=1 committed file after write, HUD shows "${dom.getEl('sFiles').textContent}"`);
const simText = dom.getEl('fSim').textContent;
if (/^0(\.0)? ms$/.test(simText) || simText === '') fail(`expected non-zero flash time, HUD shows "${simText}"`);

// The op log recorded the write with a real cost.
if (!has('write(')) fail('no write(...) entry in the op log');

// ---- lockstep (ADR-0016): add LittleFS as a second participant ----
const preAdd = lines().length;
dom.dispatch('fsPick-littlefs');
let added = false;
for (let i = 0; i < 400 && !added; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1);
  added = has('participants:', preAdd) && has('LittleFS', preAdd);
}
if (!added) fail('adding LittleFS as a second participant never logged "participants: ..." (toggleParticipant hung or threw)');
if (errorsSince(preAdd).length) fail(`errors while adding LittleFS: ${errorsSince(preAdd).map((l) => l.text).join(' | ')}`);

// Both dies stay mounted (participants aren't torn down, only display toggles visibility).
if (dieStack.children.length !== 2) fail(`dieStack has ${dieStack.children.length} mounted dies with 2 participants, expected 2`);
if (!dom.getEl('fsPick-fastffs').classList.contains('on')) fail('fastffs should still be a selected participant');
if (!dom.getEl('fsPick-littlefs').classList.contains('on')) fail('littlefs should be a selected participant after toggling it on');

// A participant-set change resets everyone (ADR-0015's "no carryover", extended) — both fresh.
dom.runIntervals();
if (dom.getEl('cmpFiles-fastffs').textContent !== '0') fail(`fastffs should be fresh after adding a participant, cmpFiles shows "${dom.getEl('cmpFiles-fastffs').textContent}"`);
if (dom.getEl('cmpFiles-littlefs').textContent !== '0') fail(`littlefs should be fresh after adding a participant, cmpFiles shows "${dom.getEl('cmpFiles-littlefs').textContent}"`);

// ---- Race mode: the corrected invariant (ADR-0016). Race clocks by SIMULATED
// flash time, not animation — a shared sim-time budget advances and every
// session runs until its own simNs reaches it. So after a while: total active
// time (simNs) is ROUGHLY EQUAL across the two FSes, while their workload STEP
// cursors DIVERGE (the cheaper-per-op FS fits more steps into the same sim-time).
//
// Driven at max speed on purpose: at no-delay the shared clock advances by a
// FIXED sim-ns chunk per tick (independent of real elapsed), so this headless
// loop — whose ticks are microseconds apart — advances the sim clock
// deterministically. Each runIntervals() = one coordinator tick; the interleaved
// dom.tick() drains the (no-delay) players so the backlog cap never bites.
dom.dispatch('modePick-race');              // select Race explicitly — the coordinator now boots in Pace (ADR-0017/0018)
dom.getEl('speed').value = '100';           // max · no delay ⇒ fixed sim-ns chunk per race tick
dom.dispatch('speed', 'input');
dom.dispatch('btnRun');
for (let i = 0; i < 60; i++) { dom.runIntervals(); dom.tick(4); }
dom.dispatch('btnRun');                     // pause again
dom.runIntervals();

if (errorsSince(preAdd).length) fail(`errors while racing: ${errorsSince(preAdd).map((l) => l.text).join(' | ')}`);

// Parse the compare strip's formatted active-time back to milliseconds (fmtTime:
// "<n> ms" or "<n> s"), so we can assert simNs is roughly equal numerically.
const simMs = (text) => {
  const m = text.trim().match(/^([\d.]+)\s*(ms|s)$/);
  return m ? parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) : NaN;
};
const stepFastffs = parseInt(dom.getEl('cmpStep-fastffs').textContent, 10);
const stepLittlefs = parseInt(dom.getEl('cmpStep-littlefs').textContent, 10);
if (!(stepFastffs > 0)) fail(`expected fastffs' step cursor to advance in Race mode, shows "${dom.getEl('cmpStep-fastffs').textContent}"`);
if (!(stepLittlefs > 0)) fail(`expected littlefs' step cursor to advance in Race mode, shows "${dom.getEl('cmpStep-littlefs').textContent}"`);
// STEP cursors must DIVERGE — two FSes with different per-op cost can't complete
// the identical step count within the same sim-time budget.
if (stepFastffs === stepLittlefs) fail(`Race step cursors should diverge (different per-op cost), both = ${stepFastffs}`);
const simFastffs = dom.getEl('cmpSim-fastffs').textContent;
const simLittlefs = dom.getEl('cmpSim-littlefs').textContent;
const msFastffs = simMs(simFastffs), msLittlefs = simMs(simLittlefs);
if (!(msFastffs > 0)) fail(`expected fastffs to accrue simulated flash time in Race mode, shows "${simFastffs}"`);
if (!(msLittlefs > 0)) fail(`expected littlefs to accrue simulated flash time in Race mode, shows "${simLittlefs}"`);
// ACTIVE TIME must be ROUGHLY EQUAL — both raced against the same sim-time clock,
// so they diverge only by one op's overshoot plus fmtTime rounding (well under 20%).
const simSpread = Math.abs(msFastffs - msLittlefs) / Math.max(msFastffs, msLittlefs);
if (simSpread > 0.2) fail(`Race active time should be roughly equal across FS, spread ${(100 * simSpread).toFixed(1)}% (fastffs ${simFastffs}, littlefs ${simLittlefs})`);

// ---- Display switch: rebind die/HUD/console to LittleFS without tearing anything down ----
const preSwitch = lines().length;
dom.dispatch('cmpRow-littlefs');
dom.runIntervals();
if (dom.getEl('tagFsName').textContent !== 'LittleFS') fail(`tagFsName not rebound to LittleFS: "${dom.getEl('tagFsName').textContent}"`);
if (dieStack.children.length !== 2) fail(`dieStack should still have 2 mounted dies after a display switch (only visibility changes), has ${dieStack.children.length}`);
if (errorsSince(preSwitch).length) fail(`errors during display switch: ${errorsSince(preSwitch).map((l) => l.text).join(' | ')}`);

// The rebound HUD reflects LittleFS's own file count (not fastffs's) — HUD refresh follows the display.
const littlefsFilesShown = parseInt(dom.getEl('sFiles').textContent, 10);
const littlefsFilesCmp = parseInt(dom.getEl('cmpFiles-littlefs').textContent, 10);
if (littlefsFilesShown !== littlefsFilesCmp) fail(`HUD sFiles (${littlefsFilesShown}) doesn't match LittleFS's own file count (${littlefsFilesCmp}) after display switch`);

// ---- Pace mode: repeated manual Steps converge both cursors to equal, no
// matter how much Race left them diverged. Each Step only advances the
// session(s) currently at the minimum cursor (ADR-0016's `due` filter), so
// convergence is gradual and bounded — poll for an observable change after
// each dispatch instead of assuming a fixed number of steps closes the gap. ----
dom.dispatch('modePick-pace');
async function waitForCursorChange(prevMin) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 0));
    dom.tick(2);
    dom.runIntervals();
    const f = parseInt(dom.getEl('cmpStep-fastffs').textContent, 10);
    const l = parseInt(dom.getEl('cmpStep-littlefs').textContent, 10);
    if (Math.min(f, l) > prevMin) return { f, l };
  }
  return null;
}
// Race can leave the cursors up to ~(max step count) apart, and each Pace Step
// closes the gap by exactly one (only the single min-cursor session is `due`),
// so the round cap must exceed the widest possible divergence — 300 clears it
// with margin for the ~150-step spreads this workload produces.
let f = parseInt(dom.getEl('cmpStep-fastffs').textContent, 10);
let l = parseInt(dom.getEl('cmpStep-littlefs').textContent, 10);
let rounds = 0;
do {
  const prevMin = Math.min(f, l);
  dom.dispatch('btnStep');
  const res = await waitForCursorChange(prevMin);
  if (!res) fail(`Pace-mode Step stalled converging cursors (fastffs=${f}, littlefs=${l})`);
  f = res.f; l = res.l;
  rounds++;
} while (f !== l && rounds < 300);
if (f !== l) fail(`Pace mode never converged both cursors to equal after ${rounds} steps (fastffs=${f}, littlefs=${l})`);
if (!(f > 0)) fail('Pace-mode cursors converged at 0 — no progress made');

console.log(`PASS — playground booted against real WASM, built ${die.children.length} sectors,`);
console.log(`       drove a write (${files} file committed, ${simText} of flash time) with viz + HUD live,`);
console.log(`       raced FASTFFS + LittleFS on one sim-time clock: active time ~equal`);
console.log(`         (${simFastffs} vs ${simLittlefs}, ${(100 * simSpread).toFixed(1)}% spread) while steps diverged (${stepFastffs} vs ${stepLittlefs}),`);
console.log(`       rebound the die/HUD to LittleFS via the display switch (${littlefsFilesShown} files shown),`);
console.log(`       and converged Pace mode to equal cursors (${f}) after ${rounds} step(s).`);
dom.uninstall();
process.exit(0);
