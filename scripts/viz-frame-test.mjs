/*
 * viz.js as a pure FRAME renderer (ADR-0024 §4/§6/§7): boots the REAL
 * web/src/viz.js against a fake DOM and geometry only (no device, no runner —
 * viz.js never touches simulated flash anymore), pushes synthetic FRAME
 * payloads through applyFrame(), and asserts:
 *   (a) heat coalescence still renders O(active cells), zero per-op
 *       animate() calls — the ADR-0022 veto holds by construction (I8) even
 *       though the accumulation locus moved worker-side (this file supplies
 *       an already-decayed full-state heat array, exactly what a real FRAME
 *       carries);
 *   (b) shown/wear/liveMap paint from full-state snapshots, not events;
 *   (c) the erase sweep still fires exactly one Element.animate() per
 *       'erase' event in frame.events (the one discrete trigger a
 *       full-snapshot pull can't represent — see the ASSUMPTION note in
 *       viz.js above applyEvents).
 */
import { createViz } from '../web/src/viz.js';

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   -', m); } else { failed++; console.error('  FAIL -', m); } };

// ---- minimal fake DOM (counts what we care about: animate + boxShadow) ----
let animateCount = 0, boxWrites = 0, boxVals = [];
let transDurs = [];   // every fill transitionDuration written (only viz's paint() writes it)
function makeEl() {
  const style = { _bs: '' };
  Object.defineProperty(style, 'boxShadow', { get() { return this._bs; }, set(v) { this._bs = v; boxWrites++; boxVals.push(v); } });
  Object.defineProperty(style, 'height', { set() {} });
  Object.defineProperty(style, 'transitionDuration', { get() { return this._td; }, set(v) { this._td = v; transDurs.push(v); } });
  style.setProperty = () => {};
  return {
    dataset: {}, style, className: '', children: [],
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    animate() { animateCount++; },
  };
}
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.document = { createElement: () => makeEl() };

const geometry = { sectorSize: 4096, sectorCount: 64, pageSize: 256 };
const pagesPerSector = geometry.sectorSize / geometry.pageSize;
const npages = geometry.sectorCount * pagesPerSector;

function mkViz() {
  const viz = createViz(geometry);
  viz.mountDie(makeEl());
  return viz;
}

// ---- (a) heat coalescence: a burst pre-coalesced (as the worker would) into
// a full-state heat array must render O(cells), zero animate() ----
function heatArray(hot) {
  const read = new Array(npages).fill(0), prog = new Array(npages).fill(0);
  for (const [p, v] of hot) read[p] = v;
  return { read, prog };
}
function burst(n) {
  const viz = mkViz();
  // n reads all landing on the 16 pages of sector 0, coalesced (as the worker
  // would coalesce them) into one heat value per page.
  const hot = [];
  for (let i = 0; i < n; i++) { const p = i % pagesPerSector; hot.push([p, (hot.find((h) => h[0] === p)?.[1] || 0) + 1]); }
  const merged = new Map();
  for (const [p, v] of hot) merged.set(p, v);
  animateCount = 0; boxWrites = 0;
  viz.applyFrame({ heat: heatArray([...merged.entries()]) });
  return { rendered: boxWrites, animated: animateCount };
}
const small = burst(100);
const huge = burst(30000);
console.log(`[bound] 100-op burst: ${small.rendered} box-shadow writes, ${small.animated} animate() calls`);
console.log(`[bound] 30000-op burst: ${huge.rendered} box-shadow writes, ${huge.animated} animate() calls`);
ok(small.animated === 0, 'a coalesced 100-read heat frame created ZERO cell animate() objects');
ok(huge.animated === 0, 'a coalesced 30000-read heat frame created ZERO cell animate() objects');
ok(huge.rendered <= 2 * geometry.sectorCount * pagesPerSector, 'per-applyFrame render is bounded by cell count (2 layers/cell)');
ok(huge.rendered === small.rendered, `render cost is op-rate INDEPENDENT: both bursts touched the same ${huge.rendered} cells`);
ok(small.rendered > 0, 'the heat frame is still VISIBLE (it renders a glow, not nothing)');

// ---- dual-channel blend (unchanged math, now fed via applyFrame) ----
function mixedOne() {
  const viz = mkViz();
  animateCount = 0; boxVals = [];
  const read = new Array(npages).fill(0), prog = new Array(npages).fill(0);
  read[0] = 1; prog[0] = 1;   // equal read+prog heat on page 0
  viz.applyFrame({ heat: { read, prog } });
  const bloom = boxVals.find((v) => v && v.includes('rgba(') && !v.includes('inset'));
  const m = bloom && bloom.match(/rgba\((\d+),(\d+),(\d+)/);
  return { rgb: m && [+m[1], +m[2], +m[3]], writes: boxVals.length, animated: animateCount };
}
const mixed = mixedOne();
console.log(`[blend] read+program on one cell → bloom rgb ${mixed.rgb}, ${mixed.writes} writes, ${mixed.animated} animate()`);
ok(mixed.animated === 0, 'a read+program overlap frame created ZERO animate() objects');
ok(mixed.writes === 2, 'the overlapped cell rendered O(cells): exactly 2 box-shadow writes (ring + bloom)');
ok(!!mixed.rgb, 'the read+program overlap RENDERS a bloom (it blends, it does not cancel)');
ok(mixed.rgb && mixed.rgb[1] > mixed.rgb[0] && mixed.rgb[1] > mixed.rgb[2],
  `the overlap glows the designed MIX (green-dominant ${mixed.rgb}), not pure read or pure program`);

// ---- heat clears once the worker reports it decayed to zero ----
function decayClears() {
  const viz = mkViz();
  const read = new Array(npages).fill(0), prog = new Array(npages).fill(0);
  read[5] = 1;
  viz.applyFrame({ heat: { read, prog } });
  boxVals = [];
  const read2 = new Array(npages).fill(0);
  viz.applyFrame({ heat: { read: read2, prog: new Array(npages).fill(0) } });
  return boxVals;
}
const cleared = decayClears();
ok(cleared.some((v) => v === ''), 'a cell whose pulled heat decayed to zero is cleared back to its resting ring');

// ---- (b) shown/wear/liveMap paint from full-state snapshots ----
function shownPaint() {
  const viz = mkViz();
  const pages = new Array(npages).fill(0);
  pages[0] = 256; pages[1] = 128;
  const wear = new Array(geometry.sectorCount).fill(0); wear[0] = 7;
  viz.applyFrame({ shown: { pages, wear } });
  return viz.metrics();
}
const m = shownPaint();
ok(m.progPages === 2, `shown snapshot painted 2 programmed pages (got ${m.progPages})`);
ok(m.displayedBytes === 384, `displayedBytes reflects the pulled shown bytes (got ${m.displayedBytes})`);

function liveMapPaint() {
  const viz = mkViz();
  const pages = new Array(npages).fill(0); pages[0] = 256; pages[1] = 256;
  viz.applyFrame({ shown: { pages } });
  const classes = new Array(npages).fill(0);
  classes[0] = 3; classes[1] = 2;   // live, obsolete
  viz.applyFrame({ liveMap: { version: 1, classes } });
  return viz.liveCounts();
}
const lc = liveMapPaint();
ok(lc.live === 1 && lc.obsolete === 1, `liveMap snapshot tags pages correctly (got ${JSON.stringify(lc)})`);

// ---- (c) erase sweep fires exactly once per 'erase' event, and clears the sector ----
function eraseEvent() {
  const viz = mkViz();
  const pages = new Array(npages).fill(0);
  for (let k = 0; k < pagesPerSector; k++) pages[k] = 256;   // sector 0 fully programmed
  viz.applyFrame({ shown: { pages } });
  animateCount = 0;
  viz.applyFrame({ events: [{ id: 1, kind: 'erase', sector: 0, ms: 500 }] });
  const after = viz.metrics();
  return { animated: animateCount, erasedPages: after.progPages };
}
const er = eraseEvent();
ok(er.animated === 1, `exactly one Element.animate() fired for one erase event (got ${er.animated})`);
ok(er.erasedPages === 0, 'the erased sector\'s pages read back as unprogrammed after the event');

// ---- reset event clears the whole die ----
function resetEvent() {
  const viz = mkViz();
  const pages = new Array(npages).fill(256);
  viz.applyFrame({ shown: { pages } });
  viz.applyFrame({ events: [{ id: 2, kind: 'reset' }] });
  return viz.metrics();
}
const rs = resetEvent();
ok(rs.progPages === 0, 'a reset event clears every page back to unprogrammed');

// ---- (d) fill-reveal transition duration scales with playback speed (setScale).
// Pre-0024 the in-process player set fillEls[p].style.transitionDuration =
// clamp(page-program-ns / scale, 110, 9000) per step; the worker rewrite dropped
// viz's scale input so the reveal froze at the fixed CSS 180ms regardless of speed.
// Assert the reveal duration now tracks scale (slow > fast), and the erase DRAIN
// rides the event's own worker-computed ms. ----
const PAGE_PROG_NS = 5937 * geometry.pageSize;   // FILL_REF_NS in viz.js
const lastTransMs = () => parseFloat(transDurs[transDurs.length - 1]);   // strip 'ms'
function revealMsAt(scale) {
  const viz = mkViz();
  viz.setScale(scale);
  transDurs = [];
  const pages = new Array(npages).fill(0); pages[0] = 256;   // reveal one page
  viz.applyFrame({ shown: { pages } });
  return lastTransMs();
}
const clamp = (v) => Math.max(110, Math.min(9000, v));
const fastReveal = revealMsAt(1e8);          // ~no-delay end: floors at MIN_ANIM
const midReveal = revealMsAt(1e6);           // ~real-time
const slowReveal = revealMsAt(3000);         // deep slow-mo
const nodelayReveal = revealMsAt(Infinity);  // no-delay = MIN_ANIM
ok(slowReveal > midReveal && midReveal >= fastReveal,
  `fill reveal duration scales with speed: fast ${fastReveal}ms <= mid ${midReveal}ms < slow ${slowReveal}ms (pre-fix: all frozen at the fixed CSS 180ms)`);
ok(Math.abs(slowReveal - clamp(PAGE_PROG_NS / 3000)) < 1,
  `slow-mo reveal = clamp(page-program-ns / scale) = ${clamp(PAGE_PROG_NS / 3000).toFixed(0)}ms (matches the pre-0024 per-page slot)`);
ok(fastReveal === 110 && nodelayReveal === 110,
  `fast + no-delay reveal floor at MIN_ANIM 110ms (got ${fastReveal}/${nodelayReveal})`);
// erase drain rides ev.ms (scale-correct from the worker), not the reveal slot
function drainMsFor(evMs) {
  const viz = mkViz();
  viz.setScale(3000);
  const pages = new Array(npages).fill(0);
  for (let k = 0; k < pagesPerSector; k++) pages[k] = 256;
  viz.applyFrame({ shown: { pages } });
  transDurs = [];
  viz.applyFrame({ events: [{ id: 9, kind: 'erase', sector: 0, ms: evMs }] });
  return lastTransMs();
}
ok(drainMsFor(7000) === 7000,
  'erase drain transition uses the event ms (7000ms), not the reveal slot');

if (failed) { console.error(`\nFAIL - ${failed} check(s) failed.`); process.exit(1); }
console.log(`\nPASS - viz.js paints pulled FRAMEs (heat/shown/liveMap/events) as a pure renderer (${pass} checks).`);
