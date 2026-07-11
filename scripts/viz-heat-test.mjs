/*
 * Viz heat-coalescence bound (the no-delay compaction-lockup fix): a read/prog
 * burst must NOT create one Element.animate() per op, and the per-frame render
 * cost must be O(active cells), independent of how many ops were drained. This
 * boots the REAL web/src/viz.js against a tiny fake device + fake DOM, fires a
 * huge read burst concentrated on one sector, drains it in a single no-delay
 * frame, and asserts: (a) zero cell animate() calls for the burst, and (b) the
 * render touches a CONSTANT number of box-shadow writes per live cell (the glow
 * renders across two layers — the bloom on the .glow layer + the ring on the cell
 * body — so it's 2 writes/cell, not 1, but still O(cells)) — the SAME count for a
 * 100-op burst and a 30000-op burst on the same cells. That is the property that
 * keeps the thread free at max sim speed (was O(ops), now O(cells)).
 */
import { createViz } from '../web/src/viz.js';

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   -', m); } else { failed++; console.error('  FAIL -', m); } };

// ---- minimal fake DOM (counts what we care about: animate + boxShadow) ----
let animateCount = 0, boxWrites = 0, boxVals = [];
function makeEl() {
  const style = { _bs: '' };
  Object.defineProperty(style, 'boxShadow', { get() { return this._bs; }, set(v) { this._bs = v; boxWrites++; boxVals.push(v); } });
  Object.defineProperty(style, 'height', { set() {} });
  Object.defineProperty(style, 'transitionDuration', { set() {} });
  style.setProperty = () => {};
  return {
    dataset: {}, style, className: '', children: [],
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    animate() { animateCount++; },   // if the burst ever calls this, the bound is broken
  };
}
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.document = { createElement: () => makeEl() };
let pendingFrame = null;
globalThis.requestAnimationFrame = (cb) => { pendingFrame = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pendingFrame = null; };
const stepFrame = (ts) => { const cb = pendingFrame; pendingFrame = null; cb(ts); };

// ---- fake device: geometry + an event bus viz subscribes to ----
function makeDevice() {
  const sectorSize = 4096, sectorCount = 64, pageSize = 256;
  const listeners = [];
  return {
    sectorSize, sectorCount, pageSize,
    wear: new Uint32Array(sectorCount),
    stats: { reads: 0, simNs: 0 },
    onEvent(fn) { listeners.push(fn); },
    emitRead(off, len) { for (const fn of listeners) fn({ op: 'read', off, len, ns: 100 }); },
    emitProg(off, len) { for (const fn of listeners) fn({ op: 'prog', off, len, ns: 100 }); },
  };
}

// Fire `n` tiny reads spread across sector 0's 16 pages, drain them in one
// no-delay frame, and return how many box-shadow writes that render did.
function burst(n) {
  const device = makeDevice();
  const viz = createViz(device);
  viz.setScale(Infinity);            // no-delay: the whole burst drains in one frame
  viz.mountDie(makeEl());            // schedules the first frame
  const pageSize = device.pageSize, pagesPerSector = device.sectorSize / pageSize;
  stepFrame(0);                      // baseline lastNow (empty queue)
  animateCount = 0;
  for (let i = 0; i < n; i++) {
    const page = i % pagesPerSector;               // hammer the 16 pages of sector 0
    device.emitRead(page * pageSize, 4);           // 4 B read stays within one page -> one glow
  }
  boxWrites = 0;
  stepFrame(16);                     // drain the whole burst + render the heat once
  return { rendered: boxWrites, animated: animateCount };
}

const small = burst(100);
const huge = burst(30000);

console.log(`[bound] 100-op burst: ${small.rendered} box-shadow writes, ${small.animated} animate() calls`);
console.log(`[bound] 30000-op burst: ${huge.rendered} box-shadow writes, ${huge.animated} animate() calls`);

ok(small.animated === 0, 'a 100-read burst created ZERO cell animate() objects (coalesced into heat)');
ok(huge.animated === 0, 'a 30000-read burst created ZERO cell animate() objects (no per-op animation)');
ok(huge.rendered <= 2 * 64 * (4096 / 256), 'per-frame render is bounded by cell count (2 layers/cell, O(cells), not O(ops))');
ok(huge.rendered === small.rendered,
  `render cost is op-rate INDEPENDENT: 30000 ops rendered the same ${huge.rendered} cells as 100 ops`);
ok(small.rendered > 0, 'the burst is still VISIBLE (it renders a glow, not nothing)');

// ---- dual-channel blend: a read AND a program on the SAME cell must BLEND, not
// overwrite (the fix). Fire one read + one balanced program on page 0, drain in
// one frame, and inspect the bloom color. With no getComputedStyle in this fake
// DOM the theme mix falls back to the designed Aurora mint [61,255,176], whose
// GREEN channel dominates — a color the pure ops can never produce (pure read is
// blue-max, pure program is red-max). Green-dominant therefore proves the two
// channels combined into the mix rather than one clobbering the other, and it
// still costs O(cells) with zero animate().
function mixedOne() {
  const device = makeDevice();
  const viz = createViz(device);
  viz.setScale(Infinity);
  viz.mountDie(makeEl());
  stepFrame(0);
  animateCount = 0;
  device.emitRead(0, 4);              // read channel on page 0
  device.emitProg(0, 4);              // program channel on the SAME page 0 → equal heats
  boxVals = [];
  stepFrame(16);                      // drain both ops + render the blended heat once
  const bloom = boxVals.find((v) => v && v.includes('rgba(') && !v.includes('inset'));  // the outer glow, not the ring
  const m = bloom && bloom.match(/rgba\((\d+),(\d+),(\d+)/);
  return { rgb: m && [ +m[1], +m[2], +m[3] ], writes: boxVals.length, animated: animateCount };
}
const mixed = mixedOne();
console.log(`[blend] read+program on one cell → bloom rgb ${mixed.rgb}, ${mixed.writes} writes, ${mixed.animated} animate()`);
ok(mixed.animated === 0, 'a read+program overlap created ZERO animate() objects (dual-channel is still coalesced)');
ok(mixed.writes === 2, 'the overlapped cell rendered O(cells): exactly 2 box-shadow writes (ring + bloom)');
ok(!!mixed.rgb, 'the read+program overlap RENDERS a bloom (it blends, it does not cancel)');
ok(mixed.rgb && mixed.rgb[1] > mixed.rgb[0] && mixed.rgb[1] > mixed.rgb[2],
  `the overlap glows the designed MIX (green-dominant ${mixed.rgb}), not pure read (blue-max) or pure program (red-max) — the channels blended, not overwrote`);

if (failed) { console.error(`\nFAIL - ${failed} check(s) failed.`); process.exit(1); }
console.log(`\nPASS - read/prog glow coalesces into O(active cells)/frame heat; no per-op animation (${pass} checks).`);
