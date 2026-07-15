/*
 * worker-heat.js — headless per-page heat/shown accumulator (ADR-0024 §6/§7
 * "heat" relocation). This is viz.js's numeric core — per-page read/prog heat
 * coalescence + shown fill — with every DOM/animation call stripped out. The
 * worker only ACCUMULATES; a PULL (FRAME) reads a decayed snapshot.
 *
 * This is the accumulator half; the timed player (queue + metering tick) lives
 * in session-worker.js. applyEvent() is called from that player's DRAIN, one op
 * at a time, as playback paces through the queue (§7: glow is PACED — tint leads
 * glow) — NOT eagerly at execution. Every op still contributes its full HEAT_ADD
 * (I8). Heat DECAY is computed closed-form at snapshot time from wall-clock
 * elapsed (ADR-0024 §7: "decay closed-form at bump/pull, no worker rAF").
 *
 * ADR-0022 heat/render veto (I8): every op still contributes exactly HEAT_ADD
 * to its page — nothing here drops, throttles, samples, or coalesces an op
 * away. Only the accumulation LOCUS moved.
 */
const HEAT_ADD = 1;                 // intensity added per read/prog page op — same constant as viz.js
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

    /** Apply ONE device event eagerly to shown/heat. Every page the op touches
     *  gets its full HEAT_ADD (I8) — no per-page timed drain, the whole op lands
     *  now. `reset` clears everything (a format / chip reset). */
    applyEvent(ev) {
      if (ev.op === 'reset') { this.reset(); return; }
      if (ev.op === 'erase') { eraseSector(ev.sector); return; }
      const first = pageOf(ev.off), last = pageOf(ev.off + ev.len - 1);
      for (let p = first; p <= last; p++) {
        if (ev.op === 'prog') progPage(p, ev.off, ev.len);
        else bump(p, 'read');
      }
    },

    /** Decay (closed-form since the last snapshot) then return the current heat
     *  as {read, prog} Float32Arrays (FrameHeat, protocol.js). Call from FRAME
     *  assembly / epoch bump only — never a periodic timer. */
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
