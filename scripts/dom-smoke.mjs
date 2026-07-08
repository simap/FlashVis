/*
 * Dom-smoke: boot the WHOLE playground (control panel + viz + WASM FASTFFS)
 * headless in Node against a fake DOM, then drive one real op and assert the UI
 * reflected real device traffic. This is the end-to-end guard the unit-ish
 * fastffs/integrity tests don't cover: it exercises viz.js and playground.js,
 * not just the runner.
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
const has = (needle) => lines().some((l) => l.text.includes(needle));
const errors = () => lines().filter((l) => l.cls.includes('err'));

await import('../web/src/playground.js');   // starts boot()

// Let boot() resolve (it awaits the WASM module load), ticking frames meanwhile.
let ready = false;
for (let i = 0; i < 400 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1);
  ready = has('console ready');
}
if (!ready) fail('playground never reached "console ready" (boot hung or threw)');
if (errors().length) fail(`errors logged during boot: ${errors().map((l) => l.text).join(' | ')}`);

// Fire the HUD/liveness intervals once so the spec line reflects the mounted FS.
dom.runIntervals();

// The die was built (one child per sector) and the spec line came from real geometry.
const die = dom.getEl('die');
if (die.children.length !== 64) fail(`die has ${die.children.length} sectors, expected 64`);
const geo = dom.getEl('specGeo').textContent;
if (!/KB/.test(geo) || !/ESP32-S3 timing/.test(geo)) fail(`specGeo looks wrong: "${geo}"`);
if (!dom.getEl('specLive').textContent.includes('mounted')) fail('specLive not mounted');

// Drive a real write via the Write button, play it out, refresh the HUD.
dom.dispatch('btnWrite');
dom.tick(30);
dom.runIntervals();

if (errors().length) fail(`errors after write: ${errors().map((l) => l.text).join(' | ')}`);
const files = parseInt(dom.getEl('sFiles').textContent, 10);
if (!(files >= 1)) fail(`expected >=1 committed file after write, HUD shows "${dom.getEl('sFiles').textContent}"`);
const simText = dom.getEl('fSim').textContent;
if (/^0(\.0)? ms$/.test(simText) || simText === '') fail(`expected non-zero flash time, HUD shows "${simText}"`);

// The op log recorded the write with a real cost.
if (!has('write(')) fail('no write(...) entry in the op log');

console.log(`PASS — playground booted against real WASM, built ${die.children.length} sectors,`);
console.log(`       drove a write (${files} file committed, ${simText} of flash time) with viz + HUD live.`);
dom.uninstall();
process.exit(0);
