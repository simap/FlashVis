/*
 * The die renderer (ADR-0024 §6/§7): a PURE main-thread paint layer.
 *
 * Accumulation, pacing, and the timed per-op player all moved worker-side
 * (ADR-0024 §6 "Relocations" — the mechanism is unchanged, only the locus
 * moved). This module never touches a device or a runner and never drives
 * its own animation-frame loop: it paints whatever the coordinator hands it
 * via `applyFrame(frame)`, once per pulled FRAME (nominally once/rAF for the
 * focused session — ADR-0024 §4 PULL). Heat arrives FULLY DECAYED, full-state,
 * every frame (ADR-0022's heat-conservation invariant, I8, holds by
 * construction: only the accumulation locus moved) — this file's job is to
 * turn that snapshot into pixels, in O(active cells) per call for the render
 * writes and O(geometry) for the scan that finds them (ADR-0024 §6: "pull
 * O(geometry), not O(ops)").
 *
 * The erase sweep is the one thing that still needs a discrete TRIGGER (not
 * just a state snapshot) — a `Element.animate()` per sector erase, so it
 * reads as a theatrical one-shot event, not a state diff. `applyFrame` reads
 * those triggers off `frame.events` (see the ASSUMPTION note below `applyEvents`).
 */
// Animation duration for the erase sweep. Ideally the worker-computed slot
// duration rides along on the triggering event (ev.ms — see applyEvents);
// MIN/MAX bound it the same way the old in-process player did, and also serve
// as the fallback when an event arrives with no duration hint.
const MIN_ANIM = 110, MAX_ANIM = 9000;

// ---- per-cell read/prog "heat" (glow coalescence) tunables ----
// Unchanged from the pre-0024 renderer (ADR-0022): heat is additive per-cell
// intensity rendered across two channels (read/prog) so an overlap blends
// instead of one overwriting the other. What changed is WHERE it accumulates
// and decays — worker-side now (ADR-0024 §6) — this file only paints the
// full-state snapshot `applyFrame` is handed.
//   heat[p] is the DECAYED value the worker sends each frame; nothing here
// multiplies it down over time anymore.
// The glow renders across TWO layers so the bloom sits UNIFORMLY above every
// border: the BLOOM (core + outer box-shadow) on a per-cell .glow layer lifted to
// z-index:5 (above every cell/sector body), and the heat RING on the cell body
// below it (see drawHeat). The FLOOR matters: a single op already sits
// at roughly old full strength (blur ~15px, spread ~3px, alpha ~1), driven by a
// fast-attack presence curve (so it also fades smoothly as heat decays). The
// log-compressed "burst" then pushes 30 / 300 / 30000 larger and whiter from
// that floor, so they stay distinct and 30k is a bright near-white flare.
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
// The defaults apply when there is no DOM/getComputedStyle (tests).
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
// argument — CSS `animation:` shorthand doesn't reliably honor a per-trigger
// duration, which is why erase used to flash at a fixed rate (ADR-0009).
const DEFAULT_ERASE_RGB = [185, 120, 255]; // --erase sweep
const DEFAULT_MIX_RGB = [61, 255, 176];    // --mix: the designed read+program overlap color (Aurora mint)
const DEFAULT_SECTOR_BG = '#0c141b';       // sector resting background the sweep restores to (theme --sector-bg)

// Live-map class → cell dataset.live tag. Index is the page class the driver
// emits (0 erased, 1 metadata, 2 obsolete, 3 live-data, 4 WL/FTL bookkeeping,
// 5 slack — allocated-but-empty, rendered blank per spec/ui.md). '' means "no
// live tag" so the cell reads as the erased/live default. A class beyond the
// table degrades to plain 'meta' (see liveTag) — never an unstyled name.
const LIVE_NAME = ['', 'meta', 'obsolete', 'live', 'wl', 'slack'];

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
// getComputedStyle (a fake-DOM test) or the value is missing.
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
// to the sector's resting background.
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

/**
 * @param {Object} geometry  { sectorSize, sectorCount, pageSize } — the same
 *   shape sent as InitMsg.geometry (ADR-0024 §4). No device/runner reference:
 *   this renderer never touches simulated flash, only what it's PULLED.
 */
export function createViz(geometry) {
  const { sectorSize, sectorCount, pageSize } = geometry;
  const pagesPerSector = sectorSize / pageSize;
  const npages = sectorCount * pagesPerSector;
  const sectorCols = Math.ceil(Math.sqrt(sectorCount));
  const pageCols = Math.ceil(Math.sqrt(pagesPerSector));

  const shown = new Uint16Array(npages);     // last-applied FRAME.shown.pages
  const wearArr = new Uint32Array(sectorCount); // last-applied FRAME.shown.wear
  const cellEls = new Array(npages);
  const fillEls = new Array(npages);
  const glowEls = new Array(npages);   // the glow's own DOM layer (see mountDie) — a sibling
                                        // appended AFTER .fillwrap so it paints ABOVE .fill
  const sectorEls = new Array(sectorCount);

  // Read/prog glow "heat" (ADR-0022) — mirrors of the LAST-APPLIED frame's
  // decayed per-cell intensity (worker-computed; see applyHeat). `glowHot` is
  // the small set of cells with live-or-fading heat, so the render pass stays
  // O(active cells) even though the scan that finds them is O(geometry) — the
  // pull itself is already O(geometry) (ADR-0024 §6), so that scan is free.
  const readHeat = new Float32Array(npages);
  const progHeat = new Float32Array(npages);
  const glowHot = new Set();

  let curAnimMs = MIN_ANIM;
  let heatmapOn = false, selected = -1, inspectorEl = null, onSelectCb = null;
  let lastMap = null;

  // Theme-sourced glow colors (re-resolved from the active [data-theme]'s CSS
  // custom properties on switch, via the exposed refreshTheme()). Defaults apply
  // when there is no DOM (tests). This re-SOURCES color only — the heat model
  // (coalescence, desaturate-to-white, ring/bloom split) is unchanged.
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

  // ---- rendering primitives ----
  // A cell's live-map tag is a pure function of the last-applied map AND its
  // fill state: a page not yet programmed (shown 0), or one with no map yet,
  // carries NO tag so it reads as erased substrate.
  function liveTag(p) {
    if (!lastMap || shown[p] === 0) return '';
    return LIVE_NAME[lastMap[p]] ?? 'meta';
  }
  function paint(p) {
    const has = shown[p] > 0;
    cellEls[p].dataset.s = has ? 'prog' : 'erased';
    fillEls[p].style.height = has ? (shown[p] / pageSize * 100) + '%' : '0';
    cellEls[p].dataset.live = liveTag(p);
  }
  // Render one cell's heat across TWO layers so the bloom sits UNIFORMLY above
  // every border: the BLOOM (white core + outer glow) goes on the .glow layer
  // (glowEls[p], z-index:5 — above every cell/sector body), and the heat RING
  // (border) goes on the cell BODY itself, BELOW that bloom.
  //   `pres` is a fast-attack presence: a single op already glows at ~old full
  // strength and fades smoothly as heat decays (worker-side now). `burst` is
  // the log-compressed sum that pushes larger + whiter, and drives the white
  // core near saturation. The ring shares this same `h`, on its own
  // earlier-clamping curve. Returns true once faded back to the resting ring
  // so the caller can drop the cell from glowHot.
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
    // progRGB. When BOTH are present, pull the dominant hue toward the
    // DESIGNED per-theme mix by co-presence `co` (a tent: 0 when one
    // dominates, 1 when the two heats are equal).
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
  function sweep(sector, ms) {
    curAnimMs = Math.max(MIN_ANIM, Math.min(MAX_ANIM, ms || MIN_ANIM));
    const el = sectorEls[sector];
    if (!el || reduced || !el.animate) return;
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
  function refreshHeatmap() {
    let ref = 1; for (let s = 0; s < sectorCount; s++) ref = Math.max(ref, wearArr[s]);
    for (let s = 0; s < sectorCount; s++)
      sectorEls[s].style.setProperty('--wc', wearColor(wearArr[s], ref));
  }

  // Sector base for an erase clear — the same page-range clear the old timed
  // player did per erase step, now driven by the event trigger instead of a
  // device 'erase' op (see applyEvents / ASSUMPTION note there).
  function eraseSectorLocal(sector) {
    const base = sector * pagesPerSector;
    for (let k = 0; k < pagesPerSector; k++) { shown[base + k] = 0; paint(base + k); }
  }

  function resetDie() {
    shown.fill(0); wearArr.fill(0);
    readHeat.fill(0); progHeat.fill(0); glowHot.clear();
    lastMap = null;
    for (let p = 0; p < npages; p++) { paint(p); cellEls[p].style.boxShadow = ''; glowEls[p].style.boxShadow = ''; }
    if (heatmapOn) refreshHeatmap();
  }

  // ---- FRAME application (ADR-0024 §4/§7) --------------------------------
  // `frame.shown`   = { pages: Array<number>[npages], wear: Array<number>[sectorCount] }  (~2.3KB on the wire)
  // `frame.heat`    = { read: Array<number>[npages], prog: Array<number>[npages] }        (~8KB, full state, already decayed)
  // `frame.liveMap` = { version, classes: Array<number>[npages] } | undefined             (~1KB, only iff version > since)
  // `frame.events`  = Array<{ id, kind: 'erase'|'reset', sector?, ms? }>                   (ASSUMPTION — see note)
  //
  // ASSUMPTION (flagged in the lane report — protocol.js does not pin the
  // shape of a FRAME.events entry): a per-sector-erase trigger is needed here
  // because the erase sweep is a discrete Element.animate() event, not a
  // state diff a full-snapshot pull can represent. `kind:'reset'` carries the
  // full-chip clear (format/reset) the same way the old 'reset' device event
  // did. `ms` is the worker-computed animated slot duration; MIN_ANIM is used
  // if absent.
  function applyShown(s) {
    if (!s) return;
    const pages = s.pages, wear = s.wear;
    for (let p = 0; p < npages; p++) {
      const v = pages[p] || 0;
      if (shown[p] !== v) { shown[p] = v; paint(p); }
    }
    if (wear) for (let s2 = 0; s2 < sectorCount; s2++) wearArr[s2] = wear[s2] || 0;
    if (heatmapOn) refreshHeatmap();
  }
  function applyHeat(h) {
    if (!h) return;
    const rh = h.read, ph = h.prog;
    for (let p = 0; p < npages; p++) if ((rh[p] || 0) > 0 || (ph[p] || 0) > 0) glowHot.add(p);
    for (const p of glowHot) {
      readHeat[p] = rh[p] || 0; progHeat[p] = ph[p] || 0;
      if (drawHeat(p)) glowHot.delete(p);
    }
  }
  function applyLiveMapFrame(lm) {
    if (!lm) return;
    lastMap = lm.classes;
    for (let p = 0; p < npages; p++) cellEls[p].dataset.live = liveTag(p);
  }
  function applyEvents(events) {
    if (!events) return;
    for (const ev of events) {
      if (ev.kind === 'erase') { eraseSectorLocal(ev.sector); sweep(ev.sector, ev.ms); if (heatmapOn) refreshHeatmap(); }
      else if (ev.kind === 'reset') resetDie();
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
      // as applyLiveMapFrame's rendering fallback — EXCEPT slack (5), allocated
      // but empty, which is tracked separately (never metadata, spec/ui.md).
      if (lastMap) { const c = lastMap[p]; if (c === 3) live++; else if (c === 2) obs++; else if (c === 5) slack++; else if (c === 1 || c >= 4) meta++; }
    }
    // Slack outranks 'in-flight' in the role fallback: a sector that is
    // programmed but all-slack is "allocated, empty", not mid-operation.
    const role = meta > live + obs ? 'index / metadata' : obs > live ? 'obsolete' :
      live > 0 ? 'live data' : slack > 0 ? 'allocated, empty' : progPages > 0 ? 'in-flight' : 'erased';
    return { progPages, bytes, live, obs, meta, slack, role, wear: wearArr[s] };
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
          // the cell body, below this layer), in one layer, regardless of DOM order.
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
    },

    /** Apply one pulled FRAME (ADR-0024 §4/§7): full-state repaint of shown
     *  bytes/wear, the decayed heat field, an (optional) liveMap tint update,
     *  and any discrete events (erase sweep trigger, full reset) since the
     *  last pull. Idempotent-ish per call — always safe to call once/rAF. */
    applyFrame(frame) {
      if (!frame) return;
      applyEvents(frame.events);
      applyShown(frame.shown);
      applyHeat(frame.heat);
      applyLiveMapFrame(frame.liveMap);
      if (selected >= 0) renderInspector(selected);
    },

    attachInspector(el) { inspectorEl = el; },
    onSelect(cb) { onSelectCb = cb; },
    setHeatmap(on, dieEl) { heatmapOn = on; dieEl.classList.toggle('heat', on); if (on) refreshHeatmap(); },
    /** Re-source the op-glow + erase-sweep colors from the active theme's CSS
     *  custom properties (called on palette switch). Color only — the heat
     *  mechanism is untouched; live cells pick up the new hue on the next
     *  applyFrame. */
    refreshTheme() { resolveTheme(); },

    /** { erased, metadata, obsolete, live } page counts over the LAST-APPLIED
     *  liveMap and shown state — a die-level readout (TELEMETRY carries the
     *  authoritative worker-side livenessCounts; this stays for the
     *  inspector/legend and for tests that want it off the renderer alone). */
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
