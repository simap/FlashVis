/*
 * FAT+WL live-map RENDER pin (spec/ui.md): drives the REAL web/src/viz.js on a
 * fake DOM (same harness pattern as viz-frame-test.mjs; ADR-0024 §4/§6/§7 -
 * viz.js is now a pure FRAME renderer, no device) and asserts how the
 * driver's extra classes decorate cells:
 *
 *   - class 5 "slack" (allocated but carrying no data) must READ as
 *     erased/blank ("unused pages in a file's clusters read as erased/blank").
 *     That is a VISUAL contract, not a dataset-string contract: a slack page
 *     is physically programmed (shown > 0), so an empty data-live would leave
 *     the default full-height fill in the LIVE gold - pixel-identical to live
 *     data (the exact misreading the spec exists to fix). So the pin is:
 *       (a) class 5 gets its own nonempty data-live name 'slack', and
 *       (b) web/index.html carries CSS that SUPPRESSES the fill for it
 *           (transparent fill + erased-edge ring, placed after the
 *           [data-s="prog"] rule it must override at equal specificity).
 *   - class 4 "WL" renders as the 'wl' shade - FTL-written metadata only.
 *   - liveCounts() folds slack into the ERASED bucket, never metadata (slack
 *     must not inflate the metadata counter) and never obsolete/garbage.
 *   - unknown higher classes still degrade to 'meta' (no throw, no unstyled
 *     name) - the ADR-0011 graceful-degradation contract.
 *
 * Migrated off the removed device-driven `viz.applyLiveMap(map)` call (that
 * coupling no longer exists post-ADR-0024): pages are now programmed and
 * tinted by pushing synthetic FRAME payloads through `applyFrame()` -
 * `{ shown: { pages } }` for programmed bytes, `{ liveMap: { version,
 * classes } } ` for the per-page class array, `{ events: [...] }` for erase/
 * reset - mirroring the harness in scripts/viz-frame-test.mjs, which drives
 * the same pure `createViz` renderer. `frame.liveMap.classes` carries the
 * identical per-page class ints (0..5, LIVE_NAME table in viz.js) the old
 * device-derived map did; the wrapper is new, the payload contract is not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createViz } from '../web/src/viz.js';

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   -', m); } else { failed++; console.error('  FAIL -', m); } };

// ---- minimal fake DOM (viz-frame-test pattern) + a registry of created els ----
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

const geometry = { sectorSize: 4096, sectorCount: 64, pageSize: 256 };
const { sectorSize, sectorCount, pageSize } = geometry;
const pagesPerSector = sectorSize / pageSize, npages = sectorCount * pagesPerSector;
const viz = createViz(geometry);
viz.setScale(Infinity);
viz.mountDie(makeEl());

// Program the first 8 pages so shown[p] > 0 there (the live-map tint only
// paints cells with programmed bytes; everything else renders blank), via a
// full-state shown snapshot - the pure-FRAME equivalent of the old device
// 'prog' events.
const pages = new Array(npages).fill(0);
for (let p = 0; p < 8; p++) pages[p] = pageSize;
viz.applyFrame({ shown: { pages } });

// Synthetic map: page p <- class p for p = 0..6 (6 = unknown), rest erased.
const map = new Uint8Array(npages);
for (let p = 0; p < 7; p++) map[p] = p;
viz.applyFrame({ liveMap: { version: 1, classes: map } });

const cells = made.filter((el) => el.className === 'cell');
ok(cells.length === npages, `harness sees all ${npages} cells (got ${cells.length})`);

const live = (p) => cells[p].dataset.live;
ok(live(0) === '', 'class 0 (erased) renders blank');
ok(live(1) === 'meta', 'class 1 renders meta');
ok(live(2) === 'obsolete', 'class 2 renders obsolete');
ok(live(3) === 'live', 'class 3 renders live');
ok(live(4) === 'wl', 'class 4 (FTL-written metadata) renders wl');
ok(live(5) === 'slack', 'class 5 (slack) carries its own data-live name, an empty name would leave the default live-gold fill (spec/ui.md)');
ok(live(6) === 'meta', 'unknown class 6 degrades to meta (no throw, no unstyled name)');
// Page 8 was never programmed, so it never took part in the shown-snapshot
// diff paint(); its data-live tag is stamped '' only by the liveMap frame's
// unconditional full-cell repaint (applyLiveMapFrame loops every page), which
// already ran above - so this pin doubles as an "every page gets tagged, not
// just the ones the caller happened to touch" check.
ok(live(8) === '', 'an unprogrammed page renders blank regardless of class');

// ---- the VISUAL half of the slack contract: web/index.html must suppress the
// fill for [data-live="slack"] so the cell reads as erased substrate, and must
// neutralize the [data-s="prog"] hot edge. Equal specificity means source
// order decides, so the slack rules must come AFTER the data-s="prog" rule.
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const fillRule = html.match(/\.cell\[data-live="slack"\]\s+\.fill\s*\{([^}]*)\}/);
ok(!!fillRule && /background:\s*transparent/.test(fillRule[1]),
  'CSS suppresses the slack fill (.cell[data-live="slack"] .fill → background:transparent), slack READS blank, not live gold');
const bodyRule = html.match(/\.cell\[data-live="slack"\]\s*\{([^}]*)\}/);
ok(!!bodyRule && /box-shadow:[^;}]*--erased-edge/.test(bodyRule[1]),
  'CSS resets the slack cell ring to the erased edge (overriding [data-s="prog"]\'s hot edge)');
const progRuleAt = html.indexOf('.cell[data-s="prog"]');
ok(progRuleAt >= 0 && !!bodyRule && html.indexOf(bodyRule[0]) > progRuleAt,
  'slack rules come after the [data-s="prog"] rule (equal specificity, source order is the override)');

// Counters: slack folds into erased, WL into metadata; slack inflates neither
// metadata nor obsolete.
const counts = viz.liveCounts();
// shown pages 0..7 -> classes 0,1,2,3,4,5,6,0: erased bucket = two class-0
// pages + the slack page (5) = 3.
ok(counts.erased === 3, `slack counts as erased-equivalent (erased=${counts.erased}: class 0 x2 + class 5)`);
ok(counts.metadata === 3, `metadata counts meta+wl+unknown only (metadata=${counts.metadata}: classes 1, 4, 6)`);
ok(counts.obsolete === 1 && counts.live === 1, `obsolete/live unaffected (${counts.obsolete}/${counts.live})`);

// ---- REGRESSION: liveMap-vs-shown application ORDER (the live-page "slack
// tail renders as full gold data" bug). Pre-migration this guarded a queued,
// timed animation reveal (applyLiveMap landing mid-drain, before the queued
// paint() for freshly-written pages). ADR-0024 dropped that queue entirely:
// applyFrame() paints synchronously per call, and applyLiveMapFrame's full
// sweep re-derives EVERY cell's tag from current (lastMap, shown) at apply
// time. That makes the underlying invariant - a page's rendered class always
// reflects the LAST-APPLIED map and shown state, never a stale snapshot from
// whichever arrived first - hold by construction; this reproduces the real
// ordering (a liveMap frame CAN arrive before the shown frame that programs
// those same pages, since they are independent worker-pulled fields) to pin
// it stays true across applyFrame call order, not just within one call.
{
  const base = 3 * pagesPerSector;                // sector 3 (pages 48..63), still erased here
  // Apply a liveMap frame naming sector 3's pages (10 live + 6 slack tail)
  // BEFORE the shown frame that programs them - shown[base..] is still 0.
  const tailMap = new Uint8Array(npages);
  for (let k = 0; k < pagesPerSector; k++) tailMap[base + k] = k < 10 ? 3 : 5;
  viz.applyFrame({ liveMap: { version: 2, classes: tailMap } });
  ok(cells[base].dataset.live === '',
    'liveMap applied before the page is shown as programmed still tags blank, liveTag\'s shown-gate wins over the map');

  // Now the shown snapshot programs sector 3 - paint() runs per changed page,
  // AFTER the liveMap above, and must take its class from the already-stored map.
  const pages2 = pages.slice();
  for (let k = 0; k < pagesPerSector; k++) pages2[base + k] = pageSize;
  viz.applyFrame({ shown: { pages: pages2 } });
  let liveOK = true, slackOK = true;
  for (let k = 0; k < 10; k++) if (cells[base + k].dataset.live !== 'live') liveOK = false;
  for (let k = 10; k < pagesPerSector; k++) if (cells[base + k].dataset.live !== 'slack') slackOK = false;
  ok(liveOK, 'pages shown AFTER the liveMap frame take the map\'s live class (not a stale blank)');
  ok(slackOK,
    "the slack tail shown AFTER the liveMap frame reads 'slack', not the default live-gold fill (spec/ui.md: unused cluster pages read as erased)");

  // ---- belt-and-braces on the same sector, both liveTag paths: ----
  // (b) a NEW liveMap frame re-tags already-shown pages via its full sweep -
  // sector 3 is fully shown now, so flipping its classes (file deleted: the
  // whole cluster goes obsolete) must repaint synchronously, no shown change needed.
  const flipMap = new Uint8Array(npages);
  for (let k = 0; k < pagesPerSector; k++) flipMap[base + k] = 2;
  viz.applyFrame({ liveMap: { version: 3, classes: flipMap } });
  let obsOK = true;
  for (let k = 0; k < pagesPerSector; k++) if (cells[base + k].dataset.live !== 'obsolete') obsOK = false;
  ok(obsOK, 'a new liveMap frame re-tags already-shown pages at apply time (live/slack -> obsolete, the applyLiveMapFrame sweep)');
  // (a) an erase event clears the tag: eraseSectorLocal zeroes shown[] and
  // repaints per page, and a page back at shown=0 must read '' even though the
  // STALE stored map (flipMap) still says class 2 for it - liveTag's shown-gate,
  // not the map, decides an erased cell.
  viz.applyFrame({ events: [{ id: 1, kind: 'erase', sector: 3, ms: 1600 }] });
  let erasedOK = true;
  for (let k = 0; k < pagesPerSector; k++) if (cells[base + k].dataset.live !== '') erasedOK = false;
  ok(erasedOK, "an erase event clears the tag: a page back at shown=0 reads '' even with a stale nonzero lastMap class");
}

console.log(failed === 0
  ? `\nPASS - FAT+WL extra classes render per spec/ui.md: slack blank + uncounted, WL a metadata shade (${pass} checks).`
  : `\nFAIL - ${failed} of ${pass + failed} render-pin checks failed`);
process.exit(failed === 0 ? 0 : 1);
