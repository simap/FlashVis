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

// Animations run via the Web Animations API so their duration is a direct JS
// argument (curAnimMs) — CSS `animation:` shorthand doesn't reliably honor a
// per-trigger duration, which is why erase used to flash at a fixed rate.
const PROG_KF = [
  { boxShadow: 'inset 0 0 0 1px #ffffff, 0 0 12px 1px #a9f1ff' },
  { boxShadow: 'inset 0 0 0 1px #f4cf7e, 0 0 6px -2px #eab54a55' },
];
const PING_KF = [
  { boxShadow: 'inset 0 0 0 1px #eafcff, 0 0 15px 3px #63e6ff' },
  { boxShadow: 'inset 0 0 0 1px #63e6ff, 0 0 12px 1px #63e6ff', offset: 0.45 },
  { boxShadow: 'inset 0 0 0 1px #233b44' },
];
const ERASE_KF = [
  { boxShadow: '0 0 0 1px #b978ff, 0 0 10px 0 #b978ff', background: '#1b1226' },
  { boxShadow: '0 0 0 1px #b978ff, 0 0 26px 2px #b978ff', background: '#2c1d3e', offset: 0.08 },
  { boxShadow: '0 0 0 1px #b978ff, 0 0 18px 1px #b978ff', background: '#241a34', offset: 0.9 },
  { boxShadow: 'none', background: '#0c141b' },
];

export function createViz(device) {
  const { sectorSize, sectorCount, pageSize } = device;
  const pagesPerSector = sectorSize / pageSize;
  const npages = sectorCount * pagesPerSector;
  const sectorCols = Math.ceil(Math.sqrt(sectorCount));
  const pageCols = Math.ceil(Math.sqrt(pagesPerSector));

  const shown = new Uint16Array(npages);
  const cellEls = new Array(npages);
  const fillEls = new Array(npages);
  const sectorEls = new Array(sectorCount);

  const queue = [];
  let scale = 20000;         // sim-ns spent per real-ms (Infinity ⇒ no delay)
  let cur = null;            // steps of the op currently playing
  let curStep = 0, curRem = 0, curAnimMs = MIN_ANIM, lastNow = 0;
  let rafId = 0, stopped = false;  // the frame loop's rAF handle + a stop flag (teardown)
  let heat = false, selected = -1, inspectorEl = null, onSelectCb = null;
  let lastMap = null;
  let prep = false;          // setup mode (ADR-0014): suppress animation, drain synchronously

  const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const pageOf = (off) => Math.floor(off / pageSize);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- rendering primitives ----
  function paint(p) {
    const has = shown[p] > 0;
    cellEls[p].dataset.s = has ? 'prog' : 'erased';
    fillEls[p].style.height = has ? (shown[p] / pageSize * 100) + '%' : '0';
  }
  // Duration is captured synchronously as `curAnimMs` — no class toggle, no
  // animationend listeners to race, so erases can't be cut short at fast speed.
  function glow(p, kind) {
    const el = cellEls[p];
    if (reduced || prep || !el.animate) return;
    el.animate(kind === 'ping' ? PING_KF : PROG_KF, { duration: curAnimMs, easing: 'ease' });
  }
  function sweep(s) {
    const el = sectorEls[s];
    if (reduced || prep || !el.animate) return;
    el.animate(ERASE_KF, { duration: curAnimMs, easing: 'linear' });
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
      for (let p = 0; p < npages; p++) { paint(p); cellEls[p].dataset.live = ''; }
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
    let guard = 200000;
    while (guard-- > 0) {
      if (!cur) {
        if (!queue.length) break;
        const ev = queue.shift();
        if (ev.op === 'barrier') { ev.resolve(); continue; }  // op fully played → resolve its await
        cur = stepsFor(ev);
        curStep = 0; runStep(0);
      }
      if (noDelay) {                       // finish every remaining step of this op now
        while (++curStep < cur.length) runStep(curStep);
        cur = null; continue;
      }
      if (budget >= curRem) {
        budget -= curRem;
        if (++curStep < cur.length) runStep(curStep);
        else cur = null;
      } else { curRem -= budget; break; }
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
    let progPages = 0, bytes = 0, live = 0, obs = 0, meta = 0;
    for (let k = 0; k < pagesPerSector; k++) {
      const p = base + k;
      if (shown[p] > 0) { progPages++; bytes += shown[p]; }
      if (lastMap) { const c = lastMap[p]; if (c === 3) live++; else if (c === 2) obs++; else if (c === 1) meta++; }
    }
    const role = meta > live + obs ? 'index / metadata' : obs > live ? 'obsolete' :
      live > 0 ? 'live data' : progPages > 0 ? 'in-flight' : 'erased';
    return { progPages, bytes, live, obs, meta, role, wear: device.wear[s] };
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
          const fill = document.createElement('i'); fill.className = 'fill'; cell.appendChild(fill);
          sec.appendChild(cell); cellEls[p] = cell; fillEls[p] = fill;
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
    pending() { return queue.length + (cur ? 1 : 0); },
    /** Resolve once the player has finished everything queued up to this point. */
    barrier() { return new Promise((resolve) => queue.push({ op: 'barrier', ns: 0, resolve })); },
    /** Setup mode: when on, ops animate nothing and paced awaits flush synchronously (ADR-0014). */
    setPrep(v) { prep = v; },
    /** Drain the queue to the die immediately, no animation — the prep-mode paced-await path. */
    flush() { flushQueue(); },

    applyLiveMap(states) {
      lastMap = states;
      const NAME = ['', 'meta', 'obsolete', 'live'];
      for (let p = 0; p < npages; p++) cellEls[p].dataset.live = shown[p] > 0 ? NAME[states[p]] : '';
    },
    liveCounts() {
      const t = [0, 0, 0, 0];
      if (lastMap) for (let p = 0; p < npages; p++) if (shown[p] > 0) t[lastMap[p]]++;
      return { erased: t[0], metadata: t[1], obsolete: t[2], live: t[3] };
    },

    metrics() {
      let progPages = 0, bytes = 0;
      for (let p = 0; p < npages; p++) { if (shown[p] > 0) progPages++; bytes += shown[p]; }
      return { progPages, erasedPages: npages - progPages, npages, displayedBytes: bytes, capacityBytes: npages * pageSize };
    },
  };
}
