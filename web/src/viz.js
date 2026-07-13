/*
 * The die renderer + timed player.
 *
 * Device ops arrive in synchronous bursts (one FASTFFS call → many read/prog/
 * erase events, each carrying a simulated flash-time cost `ns`). We play them
 * back over REAL time, scaled by `scale` (sim-ns spent per real-ms):
 *
 *  - Each op is split into per-page steps, so a large read/program sweeps across
 *    its pages instead of flashing at once.
 *  - A step is animated at the START of its time slot, then we hold for the slot's
 *    duration before the next — so an erase's 21 ms shows before any following read.
 *  - Animation duration tracks the slot, so slow-mo genuinely looks slow.
 *  - `scale = Infinity` means no simulated delay: drain the queue as fast as the
 *    loop runs (execution speed only).
 *
 * `shown[page]` = bytes displayed as programmed, rebuilt from played-back events.
 */
// Animation duration = the op's real-time slot (step.ns / scale), so at slow
// speeds a 1 s op animates for ~1 s. MIN keeps real-time-and-faster visible;
// MAX is just a sanity ceiling above the slowest single op (a ~7 s erase).
const MIN_ANIM = 110, MAX_ANIM = 9000;

// ---- per-frame drain cap (drain-pacing knob) ----
// Max low-level device steps (per-page runStep calls) the player simulates in ONE
// animation frame. A huge burst — e.g. a no-delay compaction of ~30k tiny reads —
// otherwise drains its entire queue in a single frame; this spreads it across
// frames instead. Excess steps are CARRIED to the next frame(s) via the persisted
// cur/curStep/queue — nothing is dropped, sampled, or coalesced; every op still
// runs and still contributes its heat exactly as before. This paces the DRAIN, it
// does not limit animation. Applies to BOTH drain paths (no-delay and timed) as a
// single shared per-frame ceiling. Sentinel: Infinity (or <= 0) ⇒ unlimited /
// disabled, so the default is byte-for-byte the current unbounded behavior.
// NOTE: a slower drain raises pending() (queue length), which the coordinator's
// raceGate/BACKLOG_CAP keys on — see the report; the coupling is benign back-
// pressure (bounds the backlog), not a regression, but keep the cap generous.
const MAX_OPS_PER_FRAME = 500;

// ---- per-cell read/prog "heat" (glow coalescence) tunables ----
// A read/prog burst used to create one Element.animate() per op; at no-delay a
// LittleFS compaction spun up ~30k of them in one un-yielded frame (native WA
// servicing froze the thread, and every glow expired before a frame painted).
// Instead each op now just ADDS to a per-cell intensity the frame() loop renders
// and decays — cost is O(active cells)/frame, never O(ops). Erase (sweep) and
// the fill height keep their own animations untouched.
//   heat[p] += HEAT_ADD per op; each frame heat[p] *= 0.5^(dt/halfLife).
// The glow renders across TWO layers so the bloom sits UNIFORMLY above every
// border: the BLOOM (core + outer box-shadow) on a per-cell .glow layer lifted to
// z-index:5 (above every cell/sector body), and the heat RING on the cell body
// below it (see drawHeat). The FLOOR matters: a single op already sits
// at roughly old full strength (blur ~15px, spread ~3px, alpha ~1), driven by a
// fast-attack presence curve (so it also fades smoothly as heat decays). The
// log-compressed "burst" then pushes 30 / 300 / 30000 larger and whiter from
// that floor, so they stay distinct and 30k is a bright near-white flare.
const HEAT_ADD = 1;                 // intensity added per read/prog page op
const HEAT_HALF_MS = 500;           // unscaled glow half-life (real ms); tune here
const HEAT_HALF_MIN = 50;          // floor so a burst stays visible at max speed
const HEAT_HALF_MAX = 3000;         // ceiling so a slow-mo glow can't linger forever
const HEAT_SCALE_REF = 20000;       // scale at which the half-life is exactly HEAT_HALF_MS
const HEAT_EPS = 0.04;              // below this a cell reverts to its resting CSS ring
const HEAT_KNEE = 0.5;              // heat for ~86% presence: single op attacks fast, fades smooth
const HEAT_ALPHA_GAIN = 1.0;       // so a single op (presence 0.86) already glows at ~full alpha
const HEAT_BURST_LOG_MAX = 2.0;     // log10(1+heat) that saturates burst growth (~30k)
const HEAT_BLUR_MIN = 10;           // outer-glow blur (px) for a single op (~old PING_KF)
const HEAT_BLUR_ADD = 3;           // extra outer-glow blur a full burst adds
const HEAT_SPREAD_MIN = 1;          // outer-glow spread (px) for a single op (~old PING_KF)
const HEAT_SPREAD_ADD = 10;          // extra outer-glow spread a full burst adds
// Op-glow base colors are DEFAULTS ONLY; the live values are re-sourced from
// the active theme's CSS custom properties by resolveTheme() (see createViz),
// so switching [data-theme] recolors the glow without touching the heat model.
// The defaults apply when there is no DOM/getComputedStyle (the viz-heat test).
const DEFAULT_READ_RGB = [99, 230, 255];   // --read (cool scan)
const DEFAULT_PROG_RGB = [255, 106, 26];   // --program (warm write), unified with the CSS var
// ---- ring (resting 1px edge) — tied to the SAME heat as the glow, not its own
// on/off switch, but clamped earlier and capped lower so it stays restrained
// (an intense glow already covers it; the ring must never look overblown). ----
const HEAT_RING_KNEE = 0.15;        // heat for the ring's presence curve — clamps much earlier than HEAT_KNEE
const HEAT_RING_ALPHA_MAX = 0.85;   // ring alpha ceiling, always < 1
const DEFAULT_RING_HOT = [244, 207, 126]; // resting hot edge under a programmed cell's glow (theme --prog-edge); alpha tracks heat
// ---- white CORE — a hard, tight, blown-out center added ON TOP of the wide
// feathered glow once burst nears saturation (a 30k-op flare), so the extreme
// end reads as an actual blow-out instead of just a wider soft near-white halo.
const HEAT_CORE_KNEE = 0.72;        // burst (0..1) where the core starts appearing
const HEAT_CORE_ALPHA_MAX = 0.95;   // core alpha ceiling once fully saturated
const HEAT_CORE_BLUR = 4;           // tight blur (px) — a hard center, not another halo
const HEAT_CORE_SPREAD = 0.5;       // tiny spread so it reads as a core, not a second ring

// Animations run via the Web Animations API so their duration is a direct JS
// argument (curAnimMs) — CSS `animation:` shorthand doesn't reliably honor a
// per-trigger duration, which is why erase used to flash at a fixed rate.
// Read/prog glow is no longer keyframed per op — it coalesces into per-cell heat
// (see glow() + the frame() render pass). Only erase keeps its Element.animate().
const DEFAULT_ERASE_RGB = [185, 120, 255]; // --erase sweep
const DEFAULT_MIX_RGB = [61, 255, 176];    // --mix: the designed read+program overlap color (Aurora mint)
const DEFAULT_SECTOR_BG = '#0c141b';       // sector resting background the sweep restores to (theme --sector-bg)

// Component-wise linear interpolation between two [r,g,b] at t (0..1).
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---- theme color resolution -------------------------------------------------
// Parse a CSS color (#rgb / #rrggbb / rgb()/rgba()) to [r,g,b]; null if not
// parseable. Tiny + dependency-free so it also runs under the test's fake DOM.
function parseColor(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = s.match(/^rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])]; }
  return null;
}
// Read a :root CSS custom property, falling back when there is no DOM /
// getComputedStyle (the viz-heat test's fake DOM) or the value is missing.
function cssVar(name) {
  try {
    const root = typeof document !== 'undefined' && document.documentElement;
    if (!root || typeof getComputedStyle !== 'function') return '';
    return getComputedStyle(root).getPropertyValue(name).trim();
  } catch { return ''; }
}
const cssRGB = (name, fallback) => parseColor(cssVar(name)) || fallback;
const cssStr = (name, fallback) => cssVar(name) || fallback;

// Build the erase-sweep keyframes from the theme's erase color: the glow uses
// the erase hue; the sector background tints toward it mid-sweep and restores
// to the sector's resting background. Same shape / offsets / opacity as before —
// only the source color is theme-driven now.
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const tintHex = (rgb, base, t) => '#' + [0, 1, 2].map((i) => hex2(base[i] + (rgb[i] - base[i]) * t)).join('');
function buildEraseKF(rgb, sectorBg) {
  const g = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  const base = parseColor(sectorBg) || [12, 20, 27];
  return [
    { boxShadow: `0 0 0 1px ${g}, 0 0 10px 0 ${g}`, background: tintHex(rgb, base, 0.16) },
    { boxShadow: `0 0 0 1px ${g}, 0 0 26px 2px ${g}`, background: tintHex(rgb, base, 0.34), offset: 0.08 },
    { boxShadow: `0 0 0 1px ${g}, 0 0 18px 1px ${g}`, background: tintHex(rgb, base, 0.26), offset: 0.9 },
    { boxShadow: 'none', background: sectorBg },
  ];
}

export function createViz(device) {
  const { sectorSize, sectorCount, pageSize } = device;
  const pagesPerSector = sectorSize / pageSize;
  const npages = sectorCount * pagesPerSector;
  const sectorCols = Math.ceil(Math.sqrt(sectorCount));
  const pageCols = Math.ceil(Math.sqrt(pagesPerSector));

  const shown = new Uint16Array(npages);
  const cellEls = new Array(npages);
  const fillEls = new Array(npages);
  const glowEls = new Array(npages);   // the glow's own DOM layer (see mountDie) — a sibling
                                        // appended AFTER .fillwrap so it paints ABOVE .fill
  const sectorEls = new Array(sectorCount);

  // Read/prog glow "heat" (coalescence — see HEAT_* tunables above). TWO
  // additive channels per cell, `readHeat` and `progHeat`, so a read and a
  // program landing on the SAME cell BLEND instead of one overwriting the other
  // (the old single-channel glowKind let the last op win the whole cell). Total
  // heat `readHeat[p] + progHeat[p]` drives all the intensity math unchanged;
  // the two channels only decide the COLOR (see drawHeat's blend toward the
  // theme --mix). `glowHot` is still the small set of cells with live heat the
  // frame() loop decays + renders — a burst of thousands of ops is still one
  // summed glow per cell, O(active cells)/frame, never a per-op animate().
  const readHeat = new Float32Array(npages);
  const progHeat = new Float32Array(npages);
  const glowHot = new Set();

  const queue = [];
  let scale = 20000;         // sim-ns spent per real-ms (Infinity ⇒ no delay)
  let cur = null;            // steps of the op currently playing
  let curStep = 0, curRem = 0, curAnimMs = MIN_ANIM, lastNow = 0;
  let rafId = 0, stopped = false;  // the frame loop's rAF handle + a stop flag (teardown)
  let heat = false, selected = -1, inspectorEl = null, onSelectCb = null;
  let lastMap = null;
  let prep = false;          // setup mode (ADR-0014): suppress animation, drain synchronously

  // Theme-sourced glow colors (re-resolved from the active [data-theme]'s CSS
  // custom properties on switch, via the exposed refreshTheme()). Defaults apply
  // when there is no DOM (tests). This re-SOURCES color only — the heat model
  // (coalescence, desaturate-to-white, ring/bloom split, decay) is unchanged.
  let readRGB = DEFAULT_READ_RGB, progRGB = DEFAULT_PROG_RGB, ringHot = DEFAULT_RING_HOT, mixRGB = DEFAULT_MIX_RGB;
  let eraseKF = buildEraseKF(DEFAULT_ERASE_RGB, DEFAULT_SECTOR_BG);
  function resolveTheme() {
    readRGB = cssRGB('--read', DEFAULT_READ_RGB);
    progRGB = cssRGB('--program', DEFAULT_PROG_RGB);
    ringHot = cssRGB('--prog-edge', DEFAULT_RING_HOT);
    mixRGB = cssRGB('--mix', DEFAULT_MIX_RGB);
    eraseKF = buildEraseKF(cssRGB('--erase', DEFAULT_ERASE_RGB), cssStr('--sector-bg', DEFAULT_SECTOR_BG));
  }
  resolveTheme();

  const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const pageOf = (off) => Math.floor(off / pageSize);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- rendering primitives ----
  function paint(p) {
    const has = shown[p] > 0;
    cellEls[p].dataset.s = has ? 'prog' : 'erased';
    fillEls[p].style.height = has ? (shown[p] / pageSize * 100) + '%' : '0';
  }
  // Read/prog glow: coalesce, don't animate. Each op just BUMPS this cell's heat
  // (O(1), no object allocated) and marks it live; the frame() loop decays and
  // renders it. So a compaction's thousands of tiny reads sum into one bright,
  // sustained flare on that sector instead of thousands of stacked, thread-
  // freezing Element.animate() calls that all expire before a frame paints.
  function glow(p, kind) {
    if (reduced || prep) return;
    if (kind === 'ping') readHeat[p] += HEAT_ADD;   // read channel
    else progHeat[p] += HEAT_ADD;                    // program channel
    glowHot.add(p);
  }
  // Render one cell's heat across TWO layers so the bloom sits UNIFORMLY above
  // every border (the screenshot fix): the BLOOM (white core + outer glow) goes on
  // the .glow layer (glowEls[p], z-index:5 — above every cell/sector body), and the
  // heat RING (border) goes on the cell BODY itself, BELOW that bloom. Keeping the
  // ring and the bloom on the same element at the same z made each cell's ring
  // interleave with neighbor blooms by DOM paint order — a later cell's bloom
  // covered its border but not the top-left corner (earlier neighbors), so borders
  // peeked through directionally. With every bloom at z:5 over every body-level
  // ring, no border can ever paint over the bloom, from any grid position/state.
  //   `pres` is a fast-attack presence: a single op already glows at ~old full
  // strength and fades smoothly as heat decays. `burst` is the log-compressed sum
  // that pushes larger + whiter, and drives the white core near saturation. The
  // ring shares this same `h`, on its own earlier-clamping curve. Returns true once
  // faded back to the resting ring so the frame loop can drop the cell.
  function drawHeat(p) {
    const rh = readHeat[p], ph = progHeat[p];
    const h = rh + ph;                                           // total heat drives ALL intensity math, unchanged
    const glowEl = glowEls[p], cell = cellEls[p];
    if (h < HEAT_EPS) {                                          // both channels faded → revert to resting ring, drop the cell
      glowEl.style.boxShadow = ''; cell.style.boxShadow = ''; return true;
    }
    const pres = 1 - Math.exp(-h / HEAT_KNEE);                    // 0..~1, ~0.86 at a single op
    const burst = Math.min(1, Math.log10(1 + h) / HEAT_BURST_LOG_MAX);
    const w = Math.pow(burst, 1.5);                              // whiten with the sum (base hue -> white)
    // COLOR = which channels are present. Pure read → readRGB, pure program →
    // progRGB (both byte-identical to the old single-channel render). When BOTH
    // are present, pull the dominant hue toward the DESIGNED per-theme mix by
    // co-presence `co` (a tent: 0 when one dominates, 1 when the two heats are
    // equal) — so an overlapped read+program reads as its own thing, routed
    // through the mix hue instead of muddying along the read↔program grey axis.
    const co = 2 * Math.min(rh, ph) / h;                         // 0..1, peaks when comparable
    const dom = ph >= rh ? progRGB : readRGB;                    // the leading channel's pure color
    const base = co > 0 ? lerp3(dom, mixRGB, co) : dom;          // continuous at rh==ph (both give mixRGB)
    const r = Math.round(base[0] + (255 - base[0]) * w);
    const g = Math.round(base[1] + (255 - base[1]) * w);
    const b = Math.round(base[2] + (255 - base[2]) * w);
    const blur = (HEAT_BLUR_MIN + burst * HEAT_BLUR_ADD).toFixed(1);
    const spread = (HEAT_SPREAD_MIN + burst * HEAT_SPREAD_ADD).toFixed(1);
    const a = Math.min(1, pres * HEAT_ALPHA_GAIN).toFixed(2);
    // Ring -> cell BODY (below the bloom). Same heat, own curve — clamps earlier
    // (HEAT_RING_KNEE < HEAT_KNEE) and holds, capped under 1 so it never overblows.
    // Inline overrides the resting CSS ring while hot; cleared to '' on fade above.
    const ringPres = 1 - Math.exp(-h / HEAT_RING_KNEE);
    const ringA = (Math.min(1, ringPres) * HEAT_RING_ALPHA_MAX).toFixed(2);
    const ringRGB = shown[p] > 0 ? ringHot : [r, g, b];    // keep the programmed cell's hot edge under a glow
    cell.style.boxShadow = `inset 0 0 0 1.5px rgba(${ringRGB[0]},${ringRGB[1]},${ringRGB[2]},${ringA})`;
    // Bloom -> .glow layer (z:5, above every border). Hard white core listed FIRST
    // so it paints on top of the wide glow; core is 0 until burst nears saturation.
    const coreT = Math.max(0, (burst - HEAT_CORE_KNEE) / (1 - HEAT_CORE_KNEE));
    const core = coreT > 0
      ? `0 0 ${HEAT_CORE_BLUR}px ${HEAT_CORE_SPREAD}px rgba(255,255,255,${(coreT * HEAT_CORE_ALPHA_MAX).toFixed(2)}), `
      : '';
    glowEl.style.boxShadow = `${core}0 0 ${blur}px ${spread}px rgba(${r},${g},${b},${a})`;
    return false;
  }
  // Glow half-life tracks the speed scale like the per-op durations do (longer in
  // slow-mo, floored so a burst is visible at any speed; the floor at no-delay).
  function glowHalfMs() {
    if (!isFinite(scale)) return HEAT_HALF_MIN;
    return clamp(HEAT_HALF_MS * HEAT_SCALE_REF / scale, HEAT_HALF_MIN, HEAT_HALF_MAX);
  }
  function sweep(s) {
    const el = sectorEls[s];
    if (reduced || prep || !el.animate) return;
    el.animate(eraseKF, { duration: curAnimMs, easing: 'linear' });
  }
  function wearColor(w, ref) {
    const t = ref > 0 ? Math.min(1, w / ref) : 0;
    const stops = [[29, 75, 82], [201, 146, 47], [229, 72, 77]];
    const seg = t < 0.5 ? 0 : 1, lt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const a = stops[seg], b = stops[seg + 1];
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * lt));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function refreshHeat() {
    let ref = 1; for (let s = 0; s < sectorCount; s++) ref = Math.max(ref, device.wear[s]);
    for (let s = 0; s < sectorCount; s++)
      sectorEls[s].style.setProperty('--wc', wearColor(device.wear[s], ref));
  }

  // ---- per-page step animations ----
  function progPage(p, off, len) {
    const ps = p * pageSize, pe = ps + pageSize;
    shown[p] = Math.min(pageSize, shown[p] + (Math.min(pe, off + len) - Math.max(ps, off)));
    fillEls[p].style.transitionDuration = curAnimMs + 'ms';
    paint(p); glow(p, 'prog');
  }
  function eraseSector(sector) {
    const base = sector * pagesPerSector;
    for (let k = 0; k < pagesPerSector; k++) {
      fillEls[base + k].style.transitionDuration = curAnimMs + 'ms'; // drain over the erase's slot
      shown[base + k] = 0; paint(base + k);
    }
    sweep(sector);
    if (heat) refreshHeat();
  }

  // expand a device event into per-page steps [{ ns, run }]
  function stepsFor(ev) {
    if (ev.op === 'erase') return [{ ns: ev.ns, run: () => eraseSector(ev.sector) }];
    const first = pageOf(ev.off), last = pageOf(ev.off + ev.len - 1);
    const n = last - first + 1, per = ev.ns / n, steps = new Array(n);
    for (let k = 0; k < n; k++) {
      const p = first + k;
      steps[k] = ev.op === 'prog'
        ? { ns: per, run: () => progPage(p, ev.off, ev.len) }
        : { ns: per, run: () => glow(p, 'ping') };
    }
    return steps;
  }
  function runStep(i) {
    const step = cur[i];
    curAnimMs = isFinite(scale) ? clamp(step.ns / scale, MIN_ANIM, MAX_ANIM) : MIN_ANIM;
    step.run();
    curRem = step.ns;
  }

  // ---- intake ----
  device.onEvent((ev) => {
    if (ev.op === 'reset') {
      for (const q of queue) if (q.op === 'barrier') q.resolve();   // don't leave awaiters hanging
      queue.length = 0; cur = null; shown.fill(0);
      readHeat.fill(0); progHeat.fill(0); glowHot.clear();
      for (let p = 0; p < npages; p++) { paint(p); cellEls[p].dataset.live = ''; cellEls[p].style.boxShadow = ''; glowEls[p].style.boxShadow = ''; }
      if (heat) refreshHeat(); return;
    }
    queue.push(ev);
  });

  // ---- timed frame loop ----
  function frame(now) {
    if (!lastNow) lastNow = now;
    let dt = now - lastNow; lastNow = now;
    if (dt > 100) dt = 100;
    const noDelay = !isFinite(scale);
    let budget = noDelay ? Infinity : dt * scale;
    // Per-frame drain cap (see MAX_OPS_PER_FRAME): a step ceiling shared by both
    // paths. Infinity when disabled, so the loop below is byte-identical to the
    // uncapped drain (Infinity - 1 === Infinity, `stepBudget > 0` always true).
    let stepBudget = MAX_OPS_PER_FRAME > 0 ? MAX_OPS_PER_FRAME : Infinity;
    let guard = 200000;
    while (guard-- > 0) {
      if (stepBudget <= 0) break;          // per-frame cap hit — carry the rest (cur/curStep/queue persist) to next frame
      if (!cur) {
        if (!queue.length) break;
        const ev = queue.shift();
        if (ev.op === 'barrier') { ev.resolve(); continue; }  // op fully played → resolve its await
        cur = stepsFor(ev);
        curStep = 0; runStep(0); stepBudget--;
      }
      if (noDelay) {                       // finish this op's remaining steps, up to the frame cap
        while (stepBudget > 0 && ++curStep < cur.length) { runStep(curStep); stepBudget--; }
        if (curStep >= cur.length) { cur = null; continue; }  // op done → next op
        break;                             // cap hit mid-op: curStep/curRem intact, resume next frame
      }
      if (budget >= curRem) {
        budget -= curRem;
        if (++curStep < cur.length) { runStep(curStep); stepBudget--; }
        else cur = null;
      } else { curRem -= budget; break; }
    }
    // Decay + render the read/prog glow heat. Cost is O(live cells), independent
    // of how many ops the drain above enqueued — a 30k-read burst is one summed
    // intensity per cell, not 30k animation objects. Deleting the current entry
    // mid-iteration is safe over a Set.
    if (glowHot.size) {
      const k = Math.pow(0.5, dt / glowHalfMs());
      for (const p of glowHot) {
        readHeat[p] *= k; progHeat[p] *= k;                     // decay BOTH channels on the same half-life
        if (drawHeat(p)) { readHeat[p] = 0; progHeat[p] = 0; glowHot.delete(p); }  // drop only when both < EPS
      }
    }
    if (selected >= 0) renderInspector(selected);
    if (!stopped) rafId = requestAnimationFrame(frame);   // don't reschedule once stopped (teardown)
  }

  // Setup mode (ADR-0014): drain the whole queue to the die NOW, with no timed
  // pacing and no glow/sweep animation (the `prep` guard suppresses those), so
  // bulk console ops run at full speed while the die stays current. Fills snap
  // (curAnimMs = 0). Barriers still resolve so no awaiter is left hanging.
  function flushQueue() {
    while (queue.length || cur) {
      if (!cur) {
        const ev = queue.shift();
        if (ev.op === 'barrier') { ev.resolve(); continue; }
        cur = stepsFor(ev); curStep = 0;
      }
      curAnimMs = 0;
      for (; curStep < cur.length; curStep++) cur[curStep].run();
      cur = null;
    }
  }

  // ---- inspector ----
  function sectorInfo(s) {
    const base = s * pagesPerSector;
    let progPages = 0, bytes = 0, live = 0, obs = 0, meta = 0, slack = 0;
    for (let k = 0; k < pagesPerSector; k++) {
      const p = base + k;
      if (shown[p] > 0) { progPages++; bytes += shown[p]; }
      // WL (class 4) and any unknown higher class count as metadata here, same
      // as applyLiveMap's rendering fallback — EXCEPT slack (5), allocated but
      // empty, which is tracked separately (never metadata, spec/ui.md).
      if (lastMap) { const c = lastMap[p]; if (c === 3) live++; else if (c === 2) obs++; else if (c === 5) slack++; else if (c === 1 || c >= 4) meta++; }
    }
    // Slack outranks 'in-flight' in the role fallback: a sector that is
    // programmed but all-slack is "allocated, empty", not mid-operation.
    const role = meta > live + obs ? 'index / metadata' : obs > live ? 'obsolete' :
      live > 0 ? 'live data' : slack > 0 ? 'allocated, empty' : progPages > 0 ? 'in-flight' : 'erased';
    return { progPages, bytes, live, obs, meta, slack, role, wear: device.wear[s] };
  }
  function renderInspector(s) {
    if (!inspectorEl) return;
    const i = sectorInfo(s);
    const addr = (s * sectorSize).toString(16).toUpperCase().padStart(5, '0');
    inspectorEl.innerHTML =
      `<div class="addr">sector ${s} · 0x${addr}</div>` +
      `<div class="row"><span>role</span><span>${i.role}</span></div>` +
      `<div class="row"><span>erase cycles</span><span>${i.wear}</span></div>` +
      `<div class="row"><span>live · obsolete · meta pages</span><span>${i.live} · ${i.obs} · ${i.meta}</span></div>` +
      // Only when present (FAT+WL): otherwise the row is noise for every other FS.
      (i.slack > 0 ? `<div class="row"><span>slack pages (allocated, empty)</span><span>${i.slack}</span></div>` : '') +
      `<div class="row"><span>bytes programmed</span><span>${i.bytes} / ${sectorSize}</span></div>`;
  }

  return {
    npages, pagesPerSector,

    mountDie(dieEl) {
      dieEl.style.setProperty('--sector-cols', sectorCols);
      dieEl.style.setProperty('--page-cols', pageCols);
      for (let s = 0; s < sectorCount; s++) {
        const sec = document.createElement('div');
        sec.className = 'sector'; sec.dataset.cls = 'erased';
        for (let k = 0; k < pagesPerSector; k++) {
          const p = s * pagesPerSector + k;
          const cell = document.createElement('div'); cell.className = 'cell'; cell.dataset.s = 'erased';
          // .fillwrap clips the rectangular .fill to the cell's rounded shape.
          // .glow carries only the BLOOM (core + outer glow): it has a positive
          // z-index and — because no ancestor up to .diewrap makes a stacking
          // context — ALL blooms paint in the diewrap's context above EVERY opaque
          // cell/sector body AND above every cell's border (the heat ring lives on
          // the cell body, below this layer), in one layer, regardless of DOM order
          // (bloom-on-bloom blends, so their order never matters). See the CSS.
          const fillwrap = document.createElement('i'); fillwrap.className = 'fillwrap';
          const fill = document.createElement('i'); fill.className = 'fill'; fillwrap.appendChild(fill);
          const glowEl = document.createElement('i'); glowEl.className = 'glow';
          cell.appendChild(fillwrap); cell.appendChild(glowEl);
          sec.appendChild(cell); cellEls[p] = cell; fillEls[p] = fill; glowEls[p] = glowEl;
        }
        sec.addEventListener('click', () => {
          if (selected >= 0) sectorEls[selected].classList.remove('sel');
          selected = s; sec.classList.add('sel'); renderInspector(s); onSelectCb?.(s);
        });
        dieEl.appendChild(sec); sectorEls[s] = sec;
      }
      rafId = requestAnimationFrame(frame);
    },

    /** Stop the frame loop for good — cancels the pending rAF and blocks any
     *  reschedule, so a torn-down session's player stops pinning its device +
     *  WASM module and detached cells instead of animating forever (ADR-0015). */
    stop() {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      // Resolve any queued barriers before going dark, mirroring the reset
      // intake — else a torn-down session removed mid-paceStep() leaves the
      // coordinator's Promise.all(barrier) awaiter hanging forever (paceBusy
      // wedged, Pace frozen), since this player will never drain them.
      for (const q of queue) if (q.op === 'barrier') q.resolve();
      queue.length = 0;
    },

    attachInspector(el) { inspectorEl = el; },
    onSelect(cb) { onSelectCb = cb; },
    /** scale = simulated nanoseconds spent per real millisecond (Infinity ⇒ no delay). */
    setScale(simNsPerRealMs) { scale = simNsPerRealMs; },
    setHeatmap(on, dieEl) { heat = on; dieEl.classList.toggle('heat', on); if (on) refreshHeat(); },
    /** Re-source the op-glow + erase-sweep colors from the active theme's CSS
     *  custom properties (called on palette switch). Color only — the heat
     *  mechanism is untouched; live cells pick up the new hue on the next frame. */
    refreshTheme() { resolveTheme(); },
    pending() { return queue.length + (cur ? 1 : 0); },
    /** Resolve once the player has finished everything queued up to this point. */
    barrier() { return new Promise((resolve) => queue.push({ op: 'barrier', ns: 0, resolve })); },
    /** Setup mode: when on, ops animate nothing and paced awaits flush synchronously (ADR-0014). */
    setPrep(v) { prep = v; },
    /** Drain the queue to the die immediately, no animation — the prep-mode paced-await path. */
    flush() { flushQueue(); },

    applyLiveMap(states) {
      lastMap = states;
      // Driver-declared extra classes (FAT+WL): 4 = WL/FTL bookkeeping (shade
      // of metadata), 5 = slack — allocated but carrying no data, which must
      // READ as erased/blank (spec/ui.md). Slack pages are physically
      // programmed (shown > 0), so an EMPTY name would leave the default
      // full-height fill in the live gold — pixel-identical to live data. It
      // therefore gets its own 'slack' name, and index.html's
      // [data-live="slack"] rules suppress the fill + hot edge so the cell
      // shows the erased substrate. Any class beyond the table degrades to
      // plain 'meta' — never an unstyled name, never a throw — so an FS
      // emitting a class this UI doesn't know about stays legible.
      const NAME = ['', 'meta', 'obsolete', 'live', 'wl', 'slack'];
      for (let p = 0; p < npages; p++) cellEls[p].dataset.live = shown[p] > 0 ? (NAME[states[p]] ?? 'meta') : '';
    },
    liveCounts() {
      const t = [0, 0, 0, 0, 0];
      // WL (4) is a species of metadata for every counter that predates it;
      // slack (5) counts as erased-equivalent (spec/ui.md: allocated-but-empty
      // folds into no metadata or garbage metric).
      if (lastMap) for (let p = 0; p < npages; p++) if (shown[p] > 0) {
        const c = lastMap[p];
        t[c === 5 ? 0 : Math.min(c, 4)]++;
      }
      return { erased: t[0], metadata: t[1] + t[4], obsolete: t[2], live: t[3] };
    },

    metrics() {
      let progPages = 0, bytes = 0;
      for (let p = 0; p < npages; p++) { if (shown[p] > 0) progPages++; bytes += shown[p]; }
      return { progPages, erasedPages: npages - progPages, npages, displayedBytes: bytes, capacityBytes: npages * pageSize };
    },
  };
}
