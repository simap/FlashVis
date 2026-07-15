/*
 * worker-heat.js — headless per-page heat/shown accumulator + timed player
 * (ADR-0024 §6 "player"/"heat" relocation). This is viz.js's numeric core —
 * queue drain, per-page step expansion, read/prog heat coalescence — with
 * every DOM/animation call stripped out: the worker only ACCUMULATES state;
 * a PULL (FRAME) reads it. Heat decay is computed CLOSED-FORM at snapshot
 * time (no worker rAF, ADR-0024 §7) — this module never ticks its own decay.
 *
 * ADR-0022 heat/render veto: every op still contributes exactly HEAT_ADD to
 * its page — nothing here drops, throttles, samples, or coalesces an op away.
 * Only the accumulation LOCUS moved (I8).
 */
const HEAT_ADD = 1;                 // intensity added per read/prog page op — same constant as viz.js
const HEAT_HALF_MS = 500;           // unscaled glow half-life (real ms)
const HEAT_HALF_MIN = 50;           // floor so a burst stays visible at max speed
const HEAT_HALF_MAX = 3000;         // ceiling so a slow-mo glow can't linger forever
const HEAT_SCALE_REF = 20000;       // scale at which the half-life is exactly HEAT_HALF_MS
const HEAT_EPS = 0.04;              // below this a cell reverts to cold (dropped from glowHot)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {object} device    a device.js instance (real NOR or a stub) — read for
 *                            geometry/stats/wear and subscribed via onEvent().
 * @param {object} geometry  { sectorSize, sectorCount, pageSize }
 */
export function createHeatPlayer(device, geometry) {
  const { sectorSize, sectorCount, pageSize } = geometry;
  const pagesPerSector = sectorSize / pageSize;
  const npages = sectorCount * pagesPerSector;

  const shown = new Uint16Array(npages);
  const readHeat = new Float32Array(npages);
  const progHeat = new Float32Array(npages);
  const glowHot = new Set();

  const queue = [];              // device events awaiting playback (each ≈ one physical op)
  let cur = null, curStep = 0, curRem = 0;   // the op currently mid-playback
  let playbackNs = 0;            // §2's currency — cumulative ns actually PLAYED, not executed
  let lastDecayAt = Date.now();

  const pageOf = (off) => Math.floor(off / pageSize);

  function bump(p, kind) {
    if (kind === 'ping') readHeat[p] += HEAT_ADD; else progHeat[p] += HEAT_ADD;
    glowHot.add(p);
  }
  function progPage(p, off, len) {
    const ps = p * pageSize, pe = ps + pageSize;
    shown[p] = Math.min(pageSize, shown[p] + (Math.min(pe, off + len) - Math.max(ps, off)));
    bump(p, 'prog');
  }
  function eraseSector(sector) {
    const base = sector * pagesPerSector;
    for (let k = 0; k < pagesPerSector; k++) shown[base + k] = 0;
  }
  // Expand one device event into per-page steps [{ ns, run }] — identical
  // shape/split to viz.js's stepsFor, minus the DOM paint/animate calls.
  function stepsFor(ev) {
    if (ev.op === 'erase') return [{ ns: ev.ns, run: () => eraseSector(ev.sector) }];
    const first = pageOf(ev.off), last = pageOf(ev.off + ev.len - 1);
    const n = last - first + 1, per = ev.ns / n, steps = new Array(n);
    for (let k = 0; k < n; k++) {
      const p = first + k;
      steps[k] = ev.op === 'prog'
        ? { ns: per, run: () => progPage(p, ev.off, ev.len) }
        : { ns: per, run: () => bump(p, 'ping') };
    }
    return steps;
  }

  device.onEvent((ev) => {
    if (ev.op === 'reset') {
      queue.length = 0; cur = null; shown.fill(0);
      readHeat.fill(0); progHeat.fill(0); glowHot.clear();
      playbackNs = 0; lastDecayAt = Date.now();
      return;
    }
    queue.push(ev);
  });

  /**
   * Drain the queue over `dtMs` of real time at `scale` (sim-ns per real-ms),
   * never STARTING a new op once playbackNs >= playLimitNs — but an op already
   * in flight always finishes (§2's one-op overshoot tolerance; a 21ms erase
   * holds continuously across many drain() calls, matching the old rAF loop's
   * "continuous intra-event" pacing, ADR-0024 §6). Returns the new playbackNs.
   */
  function drain(dtMs, scale, playLimitNs) {
    let budget = isFinite(scale) ? dtMs * scale : Infinity;
    let guard = 200000;
    while (guard-- > 0) {
      if (!cur) {
        if (playbackNs >= playLimitNs) break;     // gate: don't START a new op past the watermark
        if (!queue.length) break;
        const ev = queue.shift();
        cur = stepsFor(ev); curStep = 0;
        cur[0].run(); curRem = cur[0].ns;
      }
      if (budget <= 0) break;
      if (budget >= curRem) {
        budget -= curRem; playbackNs += curRem;
        if (++curStep < cur.length) { cur[curStep].run(); curRem = cur[curStep].ns; }
        else cur = null;
      } else {
        playbackNs += budget; curRem -= budget; budget = 0;
        break;
      }
    }
    return playbackNs;
  }

  /**
   * Decay + snapshot, closed-form from wall-clock elapsed since the last call
   * (ADR-0024 §7: "decay computes closed-form at bump/pull time, no worker
   * rAF") — call this from FRAME assembly (a `heat` PULL) or an epoch bump,
   * never from a periodic timer. Returns fresh copies (safe to postMessage).
   */
  function snapshotHeat(scale) {
    const now = Date.now();
    const dt = Math.max(0, now - lastDecayAt);
    lastDecayAt = now;
    if (dt > 0 && glowHot.size) {
      const halfLife = isFinite(scale)
        ? clamp(HEAT_HALF_MS * HEAT_SCALE_REF / scale, HEAT_HALF_MIN, HEAT_HALF_MAX)
        : HEAT_HALF_MIN;
      const k = Math.pow(0.5, dt / halfLife);
      for (const p of glowHot) {
        readHeat[p] *= k; progHeat[p] *= k;
        if (readHeat[p] + progHeat[p] < HEAT_EPS) { readHeat[p] = 0; progHeat[p] = 0; glowHot.delete(p); }
      }
    }
    return { readHeat: readHeat.slice(), progHeat: progHeat.slice() };
  }

  return {
    npages, pagesPerSector,
    get playbackNs() { return playbackNs; },
    /** Backlog depth in QUEUED OPS (queue length + the in-flight op, if any) —
     *  the local stand-in for the old viz.js `pending()` / I3's `pending`. */
    pendingOps() { return queue.length + (cur ? 1 : 0); },
    drain,
    snapshotHeat,
    shownSnapshot() { return shown.slice(); },
    reset() {
      queue.length = 0; cur = null; shown.fill(0);
      readHeat.fill(0); progHeat.fill(0); glowHot.clear();
      playbackNs = 0; lastDecayAt = Date.now();
    },
  };
}
