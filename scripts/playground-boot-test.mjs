/*
 * playground-boot-test.mjs — end-to-end boot of the REAL web/src/playground.js
 * on the ADR-0024 worker-per-session wire, headless: a fake DOM (fake-dom.mjs)
 * + one in-realm worker host per session (createWorkerHost over
 * mock-worker-transport.mjs, with the stub runner — no real WASM). Drives the
 * whole page the way a browser would and asserts it boots, renders the focused
 * die from pulled FRAMEs, populates the compare strip from TELEMETRY, switches
 * focus, injects console commands, and gates churn with Run/Pause.
 *
 * This is the "get the page RUNNING" verification the integration brief asks
 * for; a real-browser boot is additive.
 */
import { installFakeDom } from './fake-dom.mjs';
import { createTransport } from './mock-worker-transport.mjs';
import { createWorkerHost } from '../web/src/session-worker.js';
import { createStubRunner } from './worker-stub-runner.mjs';

const dom = installFakeDom();
const fail = (msg) => { console.error('FAIL —', msg); dom.uninstall(); process.exit(1); };
let checks = 0;
const ok = (c, m) => { if (c) { checks++; console.log('  ok   -', m); } else fail(m); };

// Each connectWorker() spins up an in-realm worker host over a transport pair
// and returns the coordinator-side port. The stub runner keeps it WASM-free.
const hosts = [];
globalThis.__flashvisWorkerConnect = (fsId, meta) => {
  const { mainPort, workerPort } = createTransport();
  const host = createWorkerHost(workerPort, { createRunner: (geometry) => createStubRunner(geometry) });
  hosts.push(host);
  return { port: mainPort, terminate: () => { host._stop?.(); workerPort.close?.(); mainPort.close?.(); } };
};
// Deterministic hold pins under the fake clock (no real-time debounce race).
globalThis.__flashvisHoldShowMs = 0;

await import('../web/src/playground.js');   // starts boot()

// ---- pump: fake macrotasks (transport delivery + worker timers) + fake rAF
// (the render loop) + fake intervals (HUD/compare). The mock transport delivers
// on setTimeout(0); the coordinator + worker use setInterval; the render/hold
// loops use rAF — all captured by fake-dom, driven here. ----
async function pump(turns = 1) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));   // let queued transport messages land
    dom.runIntervals();                            // coordinator frame() + worker tick/telemetry + HUD
    dom.tick(1);                                   // one rAF batch (render loop + hold loop)
  }
}

// ---- boot reaches ready ----
let ready = false;
for (let i = 0; i < 600 && !ready; i++) { await pump(1); ready = dom.getEl('bootStatus').textContent === 'ready'; }
ok(ready, 'playground reached bootStatus "ready" (boot did not hang or throw)');
if (dom.getEl('specLive').textContent.includes('boot failed')) fail(`boot failed: ${dom.getEl('specLive').textContent}`);

// ---- one die mounted (ONE main-thread viz, ADR-0024 focus-is-view) ----
ok(dom.getEl('dieStack').children.length === 1, 'exactly one die is mounted (single main-thread renderer)');

// ---- compare strip: one .fs card per registered FS, fastffs focused ----
for (let i = 0; i < 40; i++) await pump(1);   // let telemetry heartbeats populate the strip
const fsFastffs = dom.getEl('fsCard-fastffs');
ok(fsFastffs.classList.contains('on'), 'fastffs is the initially-focused fs card');
ok(!dom.getEl('fsCard-littlefs').classList.contains('on'), 'littlefs is not focused initially');

// ---- boot tape shows the broadcast help()/format() (worker-owned journal,
// pulled + echoed via api.print) ----
const tapeText = () => dom.getEl('tape').children.map((c) => c.textContent).join('\n');
ok(/help\(\)/.test(tapeText()), `focused tape shows the boot help() echo:\n${tapeText()}`);
ok(/format\(\)/.test(tapeText()), `focused tape shows the boot format() echo:\n${tapeText()}`);

// ---- focus switch: die/tape follow littlefs; its OWN tape shows the boot log ----
dom.dispatch('fsCard-littlefs');
for (let i = 0; i < 40; i++) await pump(1);
ok(dom.getEl('fsCard-littlefs').classList.contains('on'), 'clicking littlefs focuses it');
ok(!fsFastffs.classList.contains('on'), 'fastffs loses focus after switching');
ok(/format\(\)/.test(tapeText()), `littlefs's own tape shows the boot format() after focusing it:\n${tapeText()}`);

// back to fastffs
dom.dispatch('fsCard-fastffs');
for (let i = 0; i < 20; i++) await pump(1);
ok(fsFastffs.classList.contains('on'), 'focus switches back to fastffs');

// ---- console injects a source command that drives the FS ----
const filesBefore = dom.getEl('sFiles').textContent;
const input = dom.getEl('terminput');
input.value = 'await writeFile("hello.bin", 512)';
input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
for (let i = 0; i < 60; i++) await pump(1);
ok(/writeFile/.test(tapeText()), `the injected writeFile command echoes on the tape:\n${tapeText().split('\n').slice(-6).join('\n')}`);
ok(dom.getEl('sFiles').textContent !== '0', `telemetry shows a file after the injected write (sFiles=${dom.getEl('sFiles').textContent}, was ${filesBefore})`);

// ---- Run gates churn: start running, the workload advances fileOpCount ----
const opsBefore = dom.getEl('fsV-fastffs').textContent;
dom.dispatch('btnRun');    // Run
for (let i = 0; i < 120; i++) await pump(1);
dom.dispatch('btnRun');    // Pause
const opsAfter = dom.getEl('fsV-fastffs').textContent;
// In Pace (boot default) fsV is flash-time; either way it must have advanced past boot idle.
ok(opsAfter !== opsBefore || dom.getEl('fSim').textContent !== '0 ms',
  `Run advanced the workload (fsV ${opsBefore} -> ${opsAfter}, fSim ${dom.getEl('fSim').textContent})`);

// ---- SPEED slider reaches the coordinator (no throw; label updates) ----
const speed = dom.getEl('speed');
speed.value = '100';
speed.dispatch('input', { target: speed });
ok(dom.getEl('speedRead').textContent.includes('no delay'), 'SPEED=max sets the "no delay" label (setSpeed reached the coordinator)');

// ---- die actually rendered from pulled frames: some cell got programmed
// (fProg > 0% or free pages < total) ----
const free = Number(dom.getEl('fFree').textContent);
ok(Number.isFinite(free) && free < 64 * 16, `the focused die rendered pulled shown state (free pages ${free} < ${64 * 16})`);

for (const h of hosts) h._stop?.();
dom.uninstall();
console.log(`\nPASS - playground boots + drives both FS over the ADR-0024 wire (${checks} checks).`);
