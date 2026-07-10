/*
 * Dom-smoke: boot the console/comparison UI (ADR-0018/0019) headless in Node
 * against a fake DOM, driving it through the compiler/broadcast path and
 * asserting the tape, scoreboard, and present-gap behavior react correctly.
 *
 * Unlike the pre-ADR-0019 version of this file, this does NOT boot against
 * real WASM / the real session.js+lockstep.js: those are owned by a parallel
 * backend lane and, as of this writing, still implement the OLDER op-level
 * broadcast (ADR-0017) — they don't yet expose the ADR-0019 contract
 * playground.js is built against (broadcast(commandFn,label),
 * pendingFor().behind, session.journal/onJournal). Instead this installs
 * scripts/stub-backend.mjs — a lightweight stand-in that matches the
 * DOCUMENTED contract — via globalThis.__flashvisBackend before importing
 * playground.js (see loadBackend() there). That keeps this guard exercising
 * the real, shipped compiler/UI code deterministically. Once the backend
 * lands ADR-0019, this should be re-pointed at the real modules (drop the
 * override) to restore full real-WASM end-to-end coverage.
 */
import { installFakeDom } from './fake-dom.mjs';
import { createSession, createLockstep } from './stub-backend.mjs';

const dom = installFakeDom();
const fail = (msg) => { console.error('FAIL —', msg); dom.uninstall(); process.exit(1); };

globalThis.__flashvisBackend = { createSession, createLockstep };

await import('../web/src/playground.js');   // starts boot()

// ---- wait for boot() to finish wiring everything ----
let ready = false;
for (let i = 0; i < 400 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1);
  ready = dom.getEl('bootStatus').textContent === 'ready';
}
if (!ready) fail('playground never reached bootStatus "ready" (boot hung or threw)');
if (dom.getEl('specLive').textContent.includes('boot failed')) fail(`boot failed: ${dom.getEl('specLive').textContent}`);

dom.runIntervals();

// ---- both filesystems are live from page load (ADR-0017) ----
const dieStack = dom.getEl('dieStack');
if (dieStack.children.length !== 2) fail(`dieStack has ${dieStack.children.length} mounted dies, expected 2 (both FS live from load)`);

// ---- scoreboard-switcher header (ADR-0018): one segment per participant ----
const sbFastffs = dom.getEl('sbSeg-fastffs'), sbLittlefs = dom.getEl('sbSeg-littlefs');
if (!sbFastffs.classList.contains('on')) fail('fastffs should be the initially-focused scoreboard segment');
if (sbLittlefs.classList.contains('on')) fail('littlefs should not be focused initially');

// ---- FIX 1: boot logs help()+format() as BROADCAST commands, so BOTH tapes
// show both — not just the focused one. Check the focused (fastffs) tape,
// then switch focus and check littlefs's own tape independently. ----
const tapeText = () => dom.getEl('tape').children.map((c) => c.textContent).join('\n');
if (!tapeText().includes('help()')) fail(`focused (fastffs) tape missing 'help()' at boot:\n${tapeText()}`);
if (!tapeText().includes('format()')) fail(`focused (fastffs) tape missing 'format()' at boot:\n${tapeText()}`);

dom.dispatch('sbSeg-littlefs');
if (!sbLittlefs.classList.contains('on')) fail('clicking the littlefs segment should focus it');
if (sbFastffs.classList.contains('on')) fail('fastffs should lose focus after switching to littlefs');
if (!tapeText().includes('help()')) fail(`littlefs's OWN tape missing 'help()' after focusing it — boot commands did not reach every session:\n${tapeText()}`);
if (!tapeText().includes('format()')) fail(`littlefs's OWN tape missing 'format()' after focusing it:\n${tapeText()}`);

// ---- FIX 4: present-gap chip suppressed in normal (steady, paused) Pace —
// driven off pendingFor().behind, not gap>0. ----
if (!dom.getEl('tapeGap').classList.contains('hidden')) fail('present-gap header should be hidden in steady Pace at boot');

// ---- buttons inject commands (ADR-0018): Write goes through the exact same
// compile+broadcast path as typing, and shows up on the tape with a real
// result. A command only ADVANCES past "queued" while the workload engine is
// running (Run/Step gates the sequence cursor, same as the real coordinator) —
// so press Run for the rest of the interactive tests. ----
dom.dispatch('sbSeg-fastffs');   // back to fastffs
dom.dispatch('btnRun');
const preWrite = dom.getEl('tape').children.length;
dom.dispatch('btnWrite');
let wrote = false;
for (let i = 0; i < 200 && !wrote; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  wrote = tapeText().includes('writeFile()') && /write\(f/.test(tapeText());
}
if (!wrote) fail(`Write button never produced a writeFile() command + its write(...) result on the tape:\n${tapeText()}`);
if (dom.getEl('tape').children.length <= preWrite) fail('tape did not grow after the Write button');
dom.runIntervals();
const filesAfterWrite = parseInt(dom.getEl('sFiles').textContent, 10);
if (!(filesAfterWrite >= 1)) fail(`expected >=1 file after Write, HUD shows "${dom.getEl('sFiles').textContent}"`);

// ---- console compiler (ADR-0019): type a multi-statement line with an
// UNDECLARED loop var — the canonical footgun the sandbox must trap — and
// confirm it runs as one atomic command with no crash and no global leak. ----
const input = dom.getEl('terminput');
const before = filesAfterWrite;
input.value = "let last; for (i = 0; i < 5; i++) { let f = await writeFile('cs' + i, 32); last && await deleteFile(last.name); last = f; }";
input.dispatch('keydown', { key: 'Enter' });
let settled = false;
for (let i = 0; i < 300 && !settled; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  settled = /delete\(cs\d\)/.test(tapeText());
}
if (!settled) fail(`typed multi-statement command with undeclared 'i' never completed its deletes:\n${tapeText()}`);
if (typeof globalThis.i !== 'undefined') fail(`undeclared loop var 'i' leaked to globalThis.i = ${globalThis.i}`);
dom.runIntervals();
const filesAfterScript = parseInt(dom.getEl('sFiles').textContent, 10);
if (!(filesAfterScript > before)) fail(`expected file count to grow after the typed script (before=${before}, after=${filesAfterScript})`);

// ---- Race mode: an artificial stagger in the stub makes littlefs lag behind
// fastffs, so pendingFor(littlefs).behind should go true, the gap header
// should show while littlefs is focused, and Catch-up should flip to Pace. ----
dom.dispatch('modePick-race');   // still running from the Write/script tests above
let diverged = false;
for (let i = 0; i < 300 && !diverged; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  const f = parseInt(dom.getEl('sbStep-fastffs').textContent, 10);
  const l = parseInt(dom.getEl('sbStep-littlefs').textContent, 10);
  diverged = f > l && l >= 0;
}
if (!diverged) fail('Race mode never diverged the two step cursors (stub stagger not taking effect?)');

dom.dispatch('sbSeg-littlefs');
dom.runIntervals();
if (dom.getEl('tapeGap').classList.contains('hidden')) fail('present-gap header should show once littlefs (the Race laggard) is focused');
if (!dom.getEl('tapeGapText').textContent.includes('behind present')) fail(`gap header text looks wrong: "${dom.getEl('tapeGapText').textContent}"`);

dom.dispatch('btnCatchup');
if (!dom.getEl('modePick-pace').classList.contains('on')) fail('Catch-up should switch mode to Pace');
let caughtUp = false;
for (let i = 0; i < 300 && !caughtUp; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  caughtUp = dom.getEl('tapeGap').classList.contains('hidden');
}
if (!caughtUp) fail('present-gap header never cleared after Catch-up → Pace converged the cursors');
dom.dispatch('btnRun');   // pause again

// ---- participants: toggling still works, and "at least one" holds ----
dom.dispatch('fsPick-littlefs');   // drop littlefs
if (dieStack.children.length !== 1) fail(`expected 1 mounted die after dropping littlefs, got ${dieStack.children.length}`);
dom.dispatch('fsPick-fastffs');    // can't drop the last one
if (dieStack.children.length !== 1) fail('dropping the last participant should be a no-op');
let rejoined = false;
dom.dispatch('fsPick-littlefs');   // rejoin
for (let i = 0; i < 200 && !rejoined; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1);
  rejoined = dieStack.children.length === 2;
}
if (!rejoined) fail('littlefs never rejoined as a participant');

console.log('PASS — booted the console/comparison UI against a stub backend (ADR-0018/0019 contract):');
console.log('  both FS live from load, scoreboard focus-switch works,');
console.log('  boot help()/format() broadcast to BOTH tapes (fix 1),');
console.log('  present-gap chip stays hidden in steady Pace (fix 4) and appears/clears correctly around a Race→Catch-up cycle,');
console.log('  Write button injects a real writeFile() command onto the tape,');
console.log(`  a typed multi-statement command with an undeclared loop var ran atomically with no global 'i' leak (files ${before} → ${filesAfterScript}),`);
console.log('  and participant toggling still holds the "at least one" invariant.');
dom.uninstall();
process.exit(0);
