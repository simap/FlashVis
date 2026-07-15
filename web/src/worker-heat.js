/*
 * worker-heat.js: headless per-page heat/shown accumulator (ADR-0024 §6/§7
 * "heat" relocation). This is viz.js's numeric core, per-page read/prog heat
 * coalescence + shown fill, with every DOM/animation call stripped out. The
 * worker only ACCUMULATES; a PULL (FRAME) reads a decayed snapshot.
 *
 * This is the accumulator half; the timed player (queue + metering tick) lives
 * in session-worker.js. applyEvent() is called from that player's DRAIN, one op
 * at a time, as playback paces through the queue (§7: glow is PACED, tint leads
 * glow), NOT eagerly at execution. Every op still contributes its full HEAT_ADD
 * (I8). Heat DECAY is computed closed-form at snapshot time from wall-clock
 * elapsed (ADR-0024 §7: "decay closed-form at bump/pull, no worker rAF").
 *
 * ADR-0022 heat/render veto (I8): every op still contributes exactly HEAT_ADD
 * to its page, nothing here drops, throttles, samples, or coalesces an op
 * away. Only the accumulation LOCUS moved.
 */
const HEAT_ADD = 1;                 // intensity added per read/prog page op, same constant as viz.js
const HEAT_HALF_MS = 500;           // unscaled glow half-life (real ms)
const HEAT_HALF_MIN = 50;           // floor so a burst stays visible at max speed
const HEAT_HALF_MAX = 3000;         // ceiling so a slow-mo glow can't linger forever
const HEAT_SCALE_REF = 20000;       // scale at which the half-life is exactly HEAT_HALF_MS
const HEAT_EPS = 0.04;              // below this a cell reverts to cold (dropped from glowHot)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** @param {object} geometry  { sectorSize, sectorCount, pageSize } */
export function createHeatPlayer(geometry) {
  const { sectorSize, sectorCount, pageSize } = geometry;
  const pagesPerSector = sectorSize / pageSize;
  const npages = sectorCount * pagesPerSector;

  const shown = new Uint16Array(npages);
  const readHeat = new Float32Array(npages);
  const progHeat = new Float32Array(npages);
  const glowHot = new Set();
  let lastDecayAt = Date.now();

  const pageOf = (off) => Math.floor(off / pageSize);

  function bump(p, kind) {
    if (kind === 'read') readHeat[p] += HEAT_ADD; else progHeat[p] += HEAT_ADD;
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

  return {
    npages, pagesPerSector, sectorCount,

    /** Apply ONE device event eagerly to shown/heat (the whole op at once). Used by
     *  the §9 prep bracket (instant, unmetered) and as the geometry-less fallback.
     *  Every page the op touches gets its full HEAT_ADD (I8). `reset` clears
     *  everything (a format / chip reset). */
    applyEvent(ev) {
      if (ev.op === 'reset') { this.reset(); return; }
      if (ev.op === 'erase') { eraseSector(ev.sector); return; }
      const first = pageOf(ev.off), last = pageOf(ev.off + ev.len - 1);
      for (let p = first; p <= last; p++) {
        if (ev.op === 'prog') progPage(p, ev.off, ev.len);
        else bump(p, 'read');
      }
    },

    /** Expand a device event into per-page PLAYBACK steps (ADR-0009 "multi-page ops
     *  split to sweep page-by-page", B17). A read/prog over N pages becomes N steps
     *  of ns/N each, so the timed player lights one page per slot as it crosses the
     *  op's playback span (the whole glow no longer lands in a single frame). An
     *  erase stays one whole-sector step. The per-page ns sum to ev.ns exactly, so
     *  playback timing is unchanged, this is intra-op granularity only. Apply each
     *  returned step at the START of its slot via applyStep(). */
    stepsFor(ev) {
      if (ev.op === 'erase') return [{ ns: ev.ns || 0, op: 'erase', sector: ev.sector }];
      const first = pageOf(ev.off), last = pageOf(ev.off + ev.len - 1);
      const n = last - first + 1;
      const per = (ev.ns || 0) / n;
      const steps = new Array(n);
      for (let k = 0; k < n; k++) {
        const p = first + k;
        steps[k] = ev.op === 'prog'
          ? { ns: per, op: 'prog', page: p, off: ev.off, len: ev.len }
          : { ns: per, op: 'read', page: p };
      }
      return steps;
    },

    /** Apply ONE per-page step (from stepsFor) to shown/heat: its full HEAT_ADD (I8). */
    applyStep(ps) {
      if (ps.op === 'prog') progPage(ps.page, ps.off, ps.len);
      else if (ps.op === 'read') bump(ps.page, 'read');
      else if (ps.op === 'erase') eraseSector(ps.sector);
    },

    /** Decay (closed-form since the last snapshot) then return the current heat
     *  as {read, prog} Float32Arrays (FrameHeat, protocol.js). Call from FRAME
     *  assembly / epoch bump only, never a periodic timer. */
    snapshotHeat(scale) {
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
      return { read: readHeat.slice(), prog: progHeat.slice() };
    },

    /** Current shown fill state (FrameShown.pages). */
    shownSnapshot() { return shown.slice(); },

    reset() {
      shown.fill(0); readHeat.fill(0); progHeat.fill(0); glowHot.clear();
      lastDecayAt = Date.now();
    },
  };
}
