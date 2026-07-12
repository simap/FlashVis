/*
 * Dom-smoke: boot the console/comparison UI (ADR-0018/0019, redesign manifest
 * A1-A9) headless in Node against a fake DOM, driving it through the
 * compiler/broadcast path and asserting the tape, the set-notation header
 * (the `.fs` cards replacing the old scoreboard), and present-gap behavior
 * react correctly.
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

// ---- every registered filesystem is live from page load (ADR-0017) — always all,
// participation toggles are gone (redesign manifest A2). Count tracks FS_REGISTRY
// (playground.js) on purpose: a new driver must actually boot in this harness. ----
const dieStack = dom.getEl('dieStack');
if (dieStack.children.length !== 3) fail(`dieStack has ${dieStack.children.length} mounted dies, expected 3 (every registered FS live from load)`);

// ---- set-notation header (A1): one `.fs` card per participant, built into
// #fsSet, replacing the old scoreboard's `.lane`/sbSeg-* build. ----
const fsFastffs = dom.getEl('fsCard-fastffs'), fsLittlefs = dom.getEl('fsCard-littlefs');
if (!fsFastffs.classList.contains('on')) fail('fastffs should be the initially-focused fs card');
if (fsLittlefs.classList.contains('on')) fail('littlefs should not be focused initially');

// ---- FIX 1: boot logs help()+format() as BROADCAST commands, so BOTH tapes
// show both — not just the focused one. Check the focused (fastffs) tape,
// then switch focus and check littlefs's own tape independently. ----
const tapeText = () => dom.getEl('tape').children.map((c) => c.textContent).join('\n');
if (!tapeText().includes('help()')) fail(`focused (fastffs) tape missing 'help()' at boot:\n${tapeText()}`);
if (!tapeText().includes('format()')) fail(`focused (fastffs) tape missing 'format()' at boot:\n${tapeText()}`);

dom.dispatch('fsCard-littlefs');
if (!fsLittlefs.classList.contains('on')) fail('clicking the littlefs card should focus it');
if (fsFastffs.classList.contains('on')) fail('fastffs should lose focus after switching to littlefs');
if (!tapeText().includes('help()')) fail(`littlefs's OWN tape missing 'help()' after focusing it — boot commands did not reach every session:\n${tapeText()}`);
if (!tapeText().includes('format()')) fail(`littlefs's OWN tape missing 'format()' after focusing it:\n${tapeText()}`);

// ---- FIX 4: present-gap chip suppressed in normal (steady, paused) Pace —
// driven off pendingFor().behind, not gap>0. ----
if (!dom.getEl('tapeGap').classList.contains('hidden')) fail('present-gap header should be hidden in steady Pace at boot');

// ---- buttons inject commands (ADR-0018): Write goes through the exact same
// compile+broadcast path as typing, and shows up on the tape with a real
// result. A command only ADVANCES past "queued" while the workload strip is
// running (Run/Step gates the sequence cursor, same as the real coordinator) —
// so press Run for the rest of the interactive tests. ----
dom.dispatch('fsCard-fastffs');   // back to fastffs
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

// ---- help() renders its reference TEXT, not just the `> help()` echo. help()
// returns HELP_TEXT and the command runner discards return values, so help must
// render through the print sink; a regression here (print no-op) shows the echo
// but no text — the "help() doesn't work" bug. ----
const HELP_MARKER = 'ONE LINE = ONE ATOMIC COMMAND';
dom.getEl('terminput').value = 'help()';
dom.getEl('terminput').dispatch('keydown', { key: 'Enter' });
let helpShown = false;
for (let i = 0; i < 200 && !helpShown; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  helpShown = tapeText().includes(HELP_MARKER);
}
if (!helpShown) fail(`help() showed its '> help()' echo but never rendered the reference text ("${HELP_MARKER}") — the print sink is broken:\n${tapeText()}`);

// ---- ops/s bar (A8): a live per-FS EMA fill, sourced from the coordinator's
// new snapshots().opsPerSec. Sanity-check it actually rendered something. ----
if (!/%$/.test(dom.getEl('fsBar-fastffs').style.width || '')) fail(`fsBar-fastffs never got a width style after activity: "${dom.getEl('fsBar-fastffs').style.width}"`);

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

// ---- Race mode: the compare-mode WHEEL (A1a), a role="switch" button, not a
// link/seg — click toggles pace<->race. An artificial stagger in the stub
// makes littlefs lag behind fastffs, so pendingFor(littlefs).behind should go
// true, the gap header should show while littlefs is focused, and Catch-up
// should flip back to Pace. In Race mode the mode-aware `.fs-v` vital reads
// workload ops done (the step cursor), which diverges as the stagger takes hold. ----
const modeWheel = dom.getEl('modeWheel');
dom.dispatch('modeWheel');   // pace -> race
if (modeWheel.dataset.mode !== 'race') fail(`clicking the mode wheel should switch to race, got "${modeWheel.dataset.mode}"`);
let diverged = false;
for (let i = 0; i < 300 && !diverged; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  const f = parseInt(dom.getEl('fsV-fastffs').textContent, 10);
  const l = parseInt(dom.getEl('fsV-littlefs').textContent, 10);
  diverged = f > l && l >= 0;
}
if (!diverged) fail('Race mode never diverged the two workload-op vitals (stub stagger not taking effect?)');

// The gap header is driven by pendingFor(activeSession).behind (the stepCursor
// timeline), NOT by the ops-done vital — the two need not move in lockstep, so
// tick until the real gap signal registers rather than asserting single-shot on
// the tick that happened to diverge the vital.
dom.dispatch('fsCard-littlefs');
let gapShown = false;
for (let i = 0; i < 300 && !gapShown; i++) {
  dom.runIntervals();
  gapShown = !dom.getEl('tapeGap').classList.contains('hidden');
  if (gapShown) break;
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1);
}
if (!gapShown) fail('present-gap header should show once littlefs (the Race laggard) is focused');
if (!dom.getEl('tapeGapText').textContent.includes('behind present')) fail(`gap header text looks wrong: "${dom.getEl('tapeGapText').textContent}"`);

dom.dispatch('btnCatchup');
if (modeWheel.dataset.mode !== 'pace') fail('Catch-up should switch the mode wheel back to pace');
// ---- Pace "holding" (A8): fastffs ran ahead during the Race divergence, so
// while Pace re-syncs the cursors it should show as .waiting until littlefs
// (the laggard) catches up. ----
let sawHolding = false;
let caughtUp = false;
for (let i = 0; i < 300 && !caughtUp; i++) {
  await new Promise((r) => setTimeout(r, 0));
  dom.tick(1); dom.runIntervals();
  if (dom.getEl('fsCard-fastffs').classList.contains('waiting')) sawHolding = true;
  caughtUp = dom.getEl('tapeGap').classList.contains('hidden');
}
if (!caughtUp) fail('present-gap header never cleared after Catch-up → Pace converged the cursors');
if (!sawHolding) fail('fastffs (the Race leader) never showed the Pace "holding" state (.fs.waiting) while littlefs caught up');
dom.dispatch('btnRun');   // pause again

// ---- ADR-0023 display: the Race "ops done" vital reads fileOpCount (a whole
// console loop counts each inner op; GC no-ops never count), and GC console
// lines render GRAY ("there, but in the background") while file-op lines do not.
// The sim has run plenty of churn by now, so the focused tape holds both. ----
const tapeEls = dom.getEl('tape').children;
const gcLines = tapeEls.filter((el) => /^gc\(/.test(el.textContent || ''));
const fileLines = tapeEls.filter((el) => /^(write|read|delete)\(/.test(el.textContent || ''));
if (!gcLines.length) fail('expected some GC lines on the tape after churn (BG-GC ratio > 0)');
if (!fileLines.length) fail('expected some file-op lines on the tape after churn');
for (const el of gcLines) if (!/(^|\s)gc(\s|$)/.test(el.className || '')) fail(`a GC tape line was not grayed (missing 'gc' class): "${el.textContent}" class="${el.className}"`);
for (const el of fileLines) if (/(^|\s)gc(\s|$)/.test(el.className || '')) fail(`a file-op tape line was wrongly grayed as GC: "${el.textContent}" class="${el.className}"`);

// ---- header Reset: returns the WHOLE sim to a clean boot state without a
// page reload — stop, re-format every FS (files back to 0), wipe the tape,
// then replay the boot log (help()/format()) exactly like boot() does. ----
dom.dispatch('btnRun');   // resume, so Reset also proves it stops a running sim
if (dom.getEl('runLabel').textContent !== 'Pause') fail('expected Run to resume before exercising Reset');
dom.dispatch('btnReset');
if (dom.getEl('runLabel').textContent !== 'Run') fail('Reset should stop the running sim (runLabel back to "Run")');
if (tapeText().includes('cs0')) fail(`Reset should wipe the old tape, but it still shows pre-reset entries:\n${tapeText()}`);
if (!tapeText().includes('help()')) fail(`Reset should replay the boot log (help()) on the tape:\n${tapeText()}`);
if (!tapeText().includes('format()')) fail(`Reset should replay the boot log (format()) on the tape:\n${tapeText()}`);
const filesAfterReset = parseInt(dom.getEl('sFiles').textContent, 10);
if (!(filesAfterReset === 0)) fail(`Reset should return every FS to empty, HUD shows sFiles="${dom.getEl('sFiles').textContent}"`);

console.log('PASS — booted the console/comparison UI against a stub backend (ADR-0018/0019/redesign contract):');
console.log('  both FS live from load (no participation toggles — A2), fs-card focus-switch works,');
console.log('  boot help()/format() broadcast to BOTH tapes (fix 1),');
console.log('  present-gap chip stays hidden in steady Pace (fix 4) and appears/clears correctly around a Race→Catch-up cycle,');
console.log('  Write button injects a real writeFile() command onto the tape, help() renders its reference text (not just the echo), and the A8 ops/s bar renders,');
console.log(`  a typed multi-statement command with an undeclared loop var ran atomically with no global 'i' leak (files ${before} → ${filesAfterScript}),`);
console.log('  the compare-mode wheel (A1a) switches pace<->race,');
console.log('  the Pace "holding" state (A8) shows on the leader while the laggard catches up,');
console.log('  the Race "ops done" vital reads fileOpCount and GC tape lines render gray (ADR-0023),');
console.log('  and the header Reset control stops the sim, wipes the tape, and replays the boot log with every FS back to empty.');
dom.uninstall();
process.exit(0);
