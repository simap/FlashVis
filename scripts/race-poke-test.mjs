/*
 * race-poke-test.mjs: regression guard for "poke does nothing in Race".
 *
 * Repro (user, authoritative): load page, switch to Race, inject a manual console
 * command (a "poke", e.g. `await writeFile(...)`) WITHOUT pressing Run. Expected: a
 * poked command runs in Race exactly as it does in Pace. This used to fail: the
 * run/pause entryLimit freeze gated Race execution on `running`, so a poke sat queued
 * while paused. That freeze has been removed; this test guards against it coming back.
 *
 * Same headless harness as playground-boot-test.mjs: the REAL web/src/playground.js
 * on the ADR-0024 worker wire, a fake DOM, one in-realm worker host per session over
 * the mock transport with the stub runner (no real WASM). We inject the SAME poke in
 * Pace (positive control, must execute) and in Race (must also execute), so the test
 * isolates the Race-specific behavior.
 */
import { installFakeDom } from './fake-dom.mjs';
import { createTransport } from './mock-worker-transport.mjs';
import { createWorkerHost } from '../web/src/session-worker.js';
import { createStubRunner } from './worker-stub-runner.mjs';

const dom = installFakeDom();
const fail = (msg) => { console.error('FAIL:', msg); dom.uninstall(); process.exit(1); };
let checks = 0;
const ok = (c, m) => { if (c) { checks++; console.log('  ok   -', m); } else fail(m); };

const hosts = [];
globalThis.__flashvisWorkerConnect = (fsId) => {
  const { mainPort, workerPort } = createTransport();
  const host = createWorkerHost(workerPort, { createRunner: (geometry) => createStubRunner(geometry) });
  hosts.push(host);
  return { port: mainPort, terminate: () => { host._stop?.(); workerPort.close?.(); mainPort.close?.(); } };
};
globalThis.__flashvisHoldShowMs = 0;

await import('../web/src/playground.js');   // starts boot()

async function pump(turns = 1) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
    dom.runIntervals();
    dom.tick(1);
  }
}
const tapeText = () => dom.getEl('tape').children.map((c) => c.textContent).join('\n');
const sFiles = () => { const t = dom.getEl('sFiles').textContent; const n = parseInt(t, 10); return Number.isFinite(n) ? n : 0; };
// Inject one console command (a poke), same path the browser takes: type into the
// terminal input and press Enter.
function poke(src) {
  const input = dom.getEl('terminput');
  input.value = src;
  input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
}

// ---- boot reaches ready ----
let ready = false;
for (let i = 0; i < 600 && !ready; i++) { await pump(1); ready = dom.getEl('bootStatus').textContent === 'ready'; }
ok(ready, 'playground reached bootStatus "ready"');
if (dom.getEl('specLive').textContent.includes('boot failed')) fail(`boot failed: ${dom.getEl('specLive').textContent}`);
for (let i = 0; i < 40; i++) await pump(1);   // let telemetry populate; fastffs is focused

// boot default is Pace. Confirm via the mode wheel's own state, so the two halves are
// unambiguous (markMode sets modeWheel.dataset.mode, playground.js:500).
const mode = () => dom.getEl('modeWheel').dataset.mode;
ok(mode() === 'pace', `boot default mode is Pace (modeWheel=${mode()})`);

// ---- POSITIVE CONTROL: poke in PACE, no Run. It must execute. ----
const filesBeforePace = sFiles();
poke('await writeFile("pace-poke.bin", 512)');
for (let i = 0; i < 80; i++) await pump(1);
const filesAfterPace = sFiles();
const paceRan = filesAfterPace > filesBeforePace && /pace-poke/.test(tapeText());
ok(paceRan, `PACE control: poke executed WITHOUT Run (sFiles ${filesBeforePace} -> ${filesAfterPace}, tape shows pace-poke)`);

// ---- switch to RACE ----
dom.dispatch('modeWheel');   // Pace -> Race
for (let i = 0; i < 40; i++) await pump(1);
ok(mode() === 'race', `switched to Race (modeWheel=${mode()})`);

// ---- REGRESSION GUARD: poke in RACE, no Run. It must execute, exactly like Pace. ----
const filesBeforeRace = sFiles();
poke('await writeFile("race-poke.bin", 512)');
for (let i = 0; i < 120; i++) await pump(1);   // generous: if it were authorized it would run
const filesAfterRace = sFiles();
const raceRan = filesAfterRace > filesBeforeRace && /race-poke/.test(tapeText());
ok(raceRan,
  `RACE: poke executed WITHOUT Run, same as Pace (sFiles ${filesBeforeRace} -> ${filesAfterRace}, tape shows race-poke).\n` +
  `         last tape lines:\n         ${tapeText().split('\n').slice(-6).join('\n         ')}`);

for (const h of hosts) h._stop?.();
dom.uninstall();

console.log(`\nPASS - a poked command executes in BOTH Pace and Race without Run (${checks} checks).`);
