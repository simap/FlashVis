/*
 * FAT+WL live-map RENDER pin (spec/ui.md): drives the REAL web/src/viz.js on a
 * fake DOM (same harness pattern as viz-heat-test.mjs) and asserts how the
 * driver's extra classes decorate cells:
 *
 *   - class 5 "slack" (allocated but carrying no data) must READ as
 *     erased/blank ("unused pages in a file's clusters read as erased/blank").
 *     That is a VISUAL contract, not a dataset-string contract: a slack page
 *     is physically programmed (shown > 0), so an empty data-live would leave
 *     the default full-height fill in the LIVE gold — pixel-identical to live
 *     data (the exact misreading the spec exists to fix). So the pin is:
 *       (a) class 5 gets its own nonempty data-live name 'slack', and
 *       (b) web/index.html carries CSS that SUPPRESSES the fill for it
 *           (transparent fill + erased-edge ring, placed after the
 *           [data-s="prog"] rule it must override at equal specificity).
 *   - class 4 "WL" renders as the 'wl' shade — FTL-written metadata only.
 *   - liveCounts() folds slack into the ERASED bucket, never metadata (slack
 *     must not inflate the metadata counter) and never obsolete/garbage.
 *   - unknown higher classes still degrade to 'meta' (no throw, no unstyled
 *     name) — the ADR-0011 graceful-degradation contract.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createViz } from '../web/src/viz.js';

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   -', m); } else { failed++; console.error('  FAIL -', m); } };

// ---- minimal fake DOM (viz-heat-test pattern) + a registry of created els ----
const made = [];
function makeEl() {
  const style = { setProperty() {} };
  Object.defineProperty(style, 'boxShadow', { set() {} });
  Object.defineProperty(style, 'height', { set() {} });
  Object.defineProperty(style, 'transitionDuration', { set() {} });
  const el = {
    dataset: {}, style, className: '', children: [],
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    animate() {},
  };
  made.push(el);
  return el;
}
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.document = { createElement: () => makeEl() };
let pendingFrame = null;
globalThis.requestAnimationFrame = (cb) => { pendingFrame = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pendingFrame = null; };
const stepFrame = (ts) => { const cb = pendingFrame; if (cb) { pendingFrame = null; cb(ts); } };

const sectorSize = 4096, sectorCount = 64, pageSize = 256;
const pps = sectorSize / pageSize, npages = sectorCount * pps;
const listeners = [];
const device = {
  sectorSize, sectorCount, pageSize,
  wear: new Uint32Array(sectorCount),
  stats: { reads: 0, simNs: 0 },
  onEvent(fn) { listeners.push(fn); },
};
const viz = createViz(device);
viz.setScale(Infinity);
viz.mountDie(makeEl());
stepFrame(0);

// Program the first 8 pages so shown[p] > 0 there (the live-map tint only
// paints cells with programmed bytes; everything else renders '').
for (let p = 0; p < 8; p++) for (const fn of listeners) fn({ op: 'prog', off: p * pageSize, len: pageSize, ns: 100 });
stepFrame(16);

// Synthetic map: page p <- class p for p = 0..6 (6 = unknown), rest erased.
const map = new Uint8Array(npages);
for (let p = 0; p < 7; p++) map[p] = p;
viz.applyLiveMap(map);

const cells = made.filter((el) => el.className === 'cell');
ok(cells.length === npages, `harness sees all ${npages} cells (got ${cells.length})`);

const live = (p) => cells[p].dataset.live;
ok(live(0) === '', 'class 0 (erased) renders blank');
ok(live(1) === 'meta', 'class 1 renders meta');
ok(live(2) === 'obsolete', 'class 2 renders obsolete');
ok(live(3) === 'live', 'class 3 renders live');
ok(live(4) === 'wl', 'class 4 (FTL-written metadata) renders wl');
ok(live(5) === 'slack', 'class 5 (slack) carries its own data-live name — an empty name would leave the default live-gold fill (spec/ui.md)');
ok(live(6) === 'meta', 'unknown class 6 degrades to meta (no throw, no unstyled name)');
ok(live(8) === '', 'an unprogrammed page renders blank regardless of class');

// ---- the VISUAL half of the slack contract: web/index.html must suppress the
// fill for [data-live="slack"] so the cell reads as erased substrate, and must
// neutralize the [data-s="prog"] hot edge. Equal specificity means source
// order decides, so the slack rules must come AFTER the data-s="prog" rule.
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const fillRule = html.match(/\.cell\[data-live="slack"\]\s+\.fill\s*\{([^}]*)\}/);
ok(!!fillRule && /background:\s*transparent/.test(fillRule[1]),
  'CSS suppresses the slack fill (.cell[data-live="slack"] .fill → background:transparent) — slack READS blank, not live gold');
const bodyRule = html.match(/\.cell\[data-live="slack"\]\s*\{([^}]*)\}/);
ok(!!bodyRule && /box-shadow:[^;}]*--erased-edge/.test(bodyRule[1]),
  'CSS resets the slack cell ring to the erased edge (overriding [data-s="prog"]\'s hot edge)');
const progRuleAt = html.indexOf('.cell[data-s="prog"]');
ok(progRuleAt >= 0 && !!bodyRule && html.indexOf(bodyRule[0]) > progRuleAt,
  'slack rules come after the [data-s="prog"] rule (equal specificity — source order is the override)');

// Counters: slack folds into erased, WL into metadata; slack inflates neither
// metadata nor obsolete.
const counts = viz.liveCounts();
// shown pages 0..7 -> classes 0,1,2,3,4,5,6,0: erased bucket = two class-0
// pages + the slack page (5) = 3.
ok(counts.erased === 3, `slack counts as erased-equivalent (erased=${counts.erased}: class 0 x2 + class 5)`);
ok(counts.metadata === 3, `metadata counts meta+wl+unknown only (metadata=${counts.metadata}: classes 1, 4, 6)`);
ok(counts.obsolete === 1 && counts.live === 1, `obsolete/live unaffected (${counts.obsolete}/${counts.live})`);

// ---- REGRESSION: apply-before-animation ordering (the live-page "slack tail
// renders as full gold data" bug). refreshLiveness applies the map at most once
// per flash change, and that change is signalled synchronously at op EXECUTION —
// BEFORE the timed animation has drawn the op's pages. So the single
// applyLiveMap lands while the freshly-written pages are still unshown; every
// page the animation programs AFTER it must still take its class from the map,
// or a slack tail (map says 5) keeps data-live='' and renders as the default
// full-height gold fill — pixel-identical to live data. The checks above program
// pages FIRST then apply, so they never caught this; this reproduces the real
// ordering: apply while the pages are unshown, THEN drain the animation.
{
  const base = 3 * pps;                          // sector 3 (pages 48..63), still erased here
  // Queue one whole-sector program (as diskio issues — a single 4096-B write over
  // the sector), but DO NOT drain the frame yet: shown[base..] stays 0.
  for (const fn of listeners) fn({ op: 'prog', off: base * pageSize, len: sectorSize, ns: 1600 });
  // A file's tail cluster: 10 live + 6 slack. Apply the map NOW, while those pages
  // are still unshown (exactly what the 250 ms refreshLiveness tick does mid-write).
  const tailMap = new Uint8Array(npages);
  for (let k = 0; k < pps; k++) tailMap[base + k] = k < 10 ? 3 : 5;
  viz.applyLiveMap(tailMap);
  ok(cells[base].dataset.live === '',
    'apply-before-draw: a not-yet-animated page tags blank at apply time (the map alone paints nothing)');
  // Drain the queued program: paint() runs per page as the animation reveals each
  // one, all AFTER the single applyLiveMap above.
  stepFrame(32);
  let liveOK = true, slackOK = true;
  for (let k = 0; k < 10; k++) if (cells[base + k].dataset.live !== 'live') liveOK = false;
  for (let k = 10; k < pps; k++) if (cells[base + k].dataset.live !== 'slack') slackOK = false;
  ok(liveOK, 'pages drawn AFTER applyLiveMap take the map\'s live class (not a stale blank)');
  ok(slackOK,
    "the slack tail drawn AFTER applyLiveMap reads 'slack', not the default live-gold fill (spec/ui.md: unused cluster pages read as erased)");
}

console.log(failed === 0
  ? `\nPASS - FAT+WL extra classes render per spec/ui.md: slack blank + uncounted, WL a metadata shade (${pass} checks).`
  : `\nFAIL - ${failed} of ${pass + failed} render-pin checks failed`);
process.exit(failed === 0 ? 0 : 1);
