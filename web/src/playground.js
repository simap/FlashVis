/*
 * Playground: boots the runner + viz, wires the control panel, JS console, and a
 * self-pacing auto-workload. Every filesystem call is wrapped by timed(), which
 * captures the device ops it issued and logs the real simulated flash cost, e.g.
 *   ls() → 3.10 ms · 31 read
 *   write(boot.log, 912 B) → 24.8 ms · 1 erase 6 prog 3 read
 */
import { createRunner } from './runner.js';
import { createViz } from './viz.js';
import { createChurnModel, CHURN_CLASS, CHURN_EVENT } from './churn.js';

// Auto-workload churn config, scaled to the 256 KiB (4096×64) device. The model
// drives the FS toward a steady-state live size instead of overfilling it. Sizes
// are kept well under capacity (no 350 KiB class, forced-large disabled) so a
// single write never runs the chip out of space; deletes keep live ≤ target+slack.
const CHURN_SEED = 0x00c0ffee;
const DEVICE_BYTES = 4096 * 64;                    // 256 KiB
const CHURN_TARGET_LIVE = 96 * 1024;               // ~37.5% of the chip — leaves GC headroom
const CHURN_TARGET_SLACK = 16 * 1024;              // tolerance above target before forced deletes
const CHURN_TARGET_WRITTEN = 0xffffffff;           // effectively never "DONE" — run forever
const CHURN_FORCE_LARGE_AFTER = 0xffffffff;        // disabled: never force a large write
const churnProfile = () => ({
  namePrefix: 'w',
  replacePercent: 25,
  protectFirstLarge: false,
  classes: [
    { key: CHURN_CLASS.SMALL,  name: 'small',  weight: 800, minSize: 2 * 1024,  maxSize: 6 * 1024 },
    { key: CHURN_CLASS.MEDIUM, name: 'medium', weight: 150, minSize: 8 * 1024,  maxSize: 20 * 1024 },
    { key: CHURN_CLASS.LARGE,  name: 'large',  weight: 50,  minSize: 40 * 1024, maxSize: 40 * 1024 },
  ],
});

const $ = (id) => document.getElementById(id);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// A large, varied name pool so the workload mostly creates new files rather than
// overwriting a handful — with enough collisions to still exercise replacement.
const NAMES = (() => {
  const ri = (n) => Math.floor(Math.random() * n);
  const words = ['config', 'boot', 'fw', 'keys', 'cal', 'wifi', 'state', 'ota', 'certs',
    'index', 'event', 'fs', 'sensor', 'audio', 'image', 'model', 'graph', 'net', 'tls',
    'user', 'device', 'part', 'bank', 'trace', 'crash', 'meter', 'sched', 'queue', 'cache',
    'blob', 'map', 'font', 'theme', 'lang', 'geo', 'rtc', 'adc', 'gpio', 'uart', 'spi',
    'i2c', 'can', 'usb', 'ble', 'mqtt', 'motor', 'servo', 'battery', 'calib', 'report'];
  const exts = ['bin', 'log', 'dat', 'cfg', 'img', 'der', 'pem', 'db', 'tmp', 'map', 'json', 'raw', 'tbl', 'idx', 'nvs'];
  const set = new Set();
  while (set.size < 140) set.add(words[ri(words.length)] + (Math.random() < 0.55 ? '_' + ri(100) : '') + '.' + exts[ri(exts.length)]);
  return [...set];
})();

function randomBytes(n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(a.subarray(i, Math.min(n, i + 65536)));
  return a;
}
const rnd = (n) => Math.floor(Math.random() * n);

let currentBatch = null; // collects the device ops issued during one timed() call

boot().catch((e) => log(String(e && e.stack || e), 'err'));

async function boot() {
  const geometry = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
  log('loading FASTFFS (WASM)…', 'sys');
  const runner = await createRunner(geometry);
  const churn = createChurnModel({
    seed: CHURN_SEED,
    targetLiveBytes: CHURN_TARGET_LIVE,
    targetWrittenBytes: CHURN_TARGET_WRITTEN,
    targetSlackBytes: CHURN_TARGET_SLACK,
    forceLargeAfterBytes: CHURN_FORCE_LARGE_AFTER,
    profile: churnProfile(),
    slotCount: 256,
  });
  const viz = createViz(runner.device);
  viz.mountDie($('die'));
  viz.attachInspector($('insp'));

  let mapDirty = true; // liveness needs a re-walk — only set on program/erase/reset
  runner.device.onEvent((ev) => {
    if (currentBatch && ev.op !== 'reset') currentBatch.push(ev);
    if (ev.op === 'prog' || ev.op === 'erase' || ev.op === 'reset') mapDirty = true;
  });

  $('specGeo').textContent =
    `${(runner.device.size / 1024) | 0} KB · ${geometry.sectorCount}×${geometry.sectorSize / 1024} KB · ESP32-S3 timing`;

  // timed FS facade — logs each op's simulated flash cost
  const timed = (label, fn) => {
    currentBatch = [];
    let res, err = null;
    try { res = fn(); } catch (e) { err = e; }
    const batch = currentBatch; currentBatch = null;
    logOp(label, batch, err);
    return res;
  };
  const sizeOf = (d) => (typeof d === 'string' ? new TextEncoder().encode(d).length : d.length);
  const fs = {
    write: (n, d) => timed(`write(${n}, ${sizeOf(d)} B)`, () => runner.write(n, d)),
    read: (n) => timed(`read(${n})`, () => runner.read(n)),
    cat: (n) => timed(`cat(${n})`, () => runner.cat(n)),
    remove: (n) => timed(`delete(${n})`, () => runner.remove(n)),
    list: () => timed('ls()', () => runner.list()),
    gcStep: () => timed('gc()', () => runner.gcStep()),
    exists: (n) => runner.exists(n),
    fsinfo: () => runner.fsinfo(),
    device: runner.device, geometry: runner.geometry, get hostBytes() { return runner.hostBytes; },
  };

  // Run an op, then resolve after the player finishes playing it (await = pace to sim time).
  const pace = (fn) => { const res = fn(); return viz.barrier().then(() => res); };
  const names = () => runner.names();

  // Streaming ls: open, then await each fffs_dir_read and print the entry as it arrives.
  const lsStream = async (printEach) => {
    const files = [];
    await pace(() => runner.dirOpen());
    for (;;) {
      const e = await pace(() => runner.dirRead());
      if (!e) break;
      if (printEach) log(`  ${e.name}  ${e.size} B`, 'out');
      files.push(e);
    }
    await pace(() => runner.dirClose());
    if (printEach && !files.length) log('  (empty)', 'out');
    return files;
  };

  freshFilesystem(runner, churn);   // empty + paused — nothing is written until Run or a console op
  log('formatted + mounted — empty and paused. Press Run, or drive it from the console.', 'sys');

  setInterval(() => refreshHUD(runner, viz), 160);
  // The liveness walk re-scans the on-flash index (mount-like), so only run it
  // when the flash actually changed — not on a fixed timer while idle/reading.
  setInterval(() => { if (mapDirty) { mapDirty = false; refreshLiveness(runner, viz); } }, 250);

  // ---- auto-workload: one op at a time, only once the last has fully played ----
  let running = false;   // start paused — the initial seed animates in, then it idles
  const setRunning = (v) => {
    running = v;
    $('runLabel').textContent = v ? 'Pause' : 'Run';
    $('btnRun').querySelector('.dot').style.background = v ? 'currentColor' : '#241a06';
  };
  setRunning(false);
  let gcRatio = 0.5, atMax = false;
  // Finite speed: one op at a time, gated on the player draining (paced by the
  // animation). "max · no delay": a wall-clock-bounded burst with no gate, so the
  // sim runs at execution speed instead of one op per frame.
  setInterval(() => {
    if (!running) return;
    if (atMax) {
      const t0 = performance.now();
      while (performance.now() - t0 < 8 && viz.pending() < 3000) workloadStep(fs, gcRatio, churn);
    } else if (viz.pending() === 0) {
      workloadStep(fs, gcRatio, churn);
    }
  }, 16);

  // ---- controls ----
  $('btnRun').addEventListener('click', () => setRunning(!running));
  $('btnStep').addEventListener('click', () => workloadStep(fs, gcRatio, churn));
  $('btnWrite').addEventListener('click', () => fs.write(NAMES[rnd(NAMES.length)], randomBytes(300 + rnd(4000))));
  $('btnLs').addEventListener('click', () => lsStream(true));
  $('btnDelete').addEventListener('click', () => {
    const known = names();
    if (known.length) fs.remove(known[rnd(known.length)]);
    else log('  (nothing to delete)', 'sys');
  });
  $('btnGC').addEventListener('click', () => fs.gcStep());
  $('btnFormat').addEventListener('click', () => { freshFilesystem(runner, churn); log('re-formatted + mounted (empty chip)', 'sys'); });

  atMax = applySpeed(+$('speed').value, viz);
  $('speed').addEventListener('input', (e) => { atMax = applySpeed(+e.target.value, viz); });

  const applyGc = (v) => { gcRatio = v / 100; $('gcRead').textContent = v === 0 ? 'off' : `${v}%`; };
  applyGc(+$('gc').value);
  $('gc').addEventListener('input', (e) => applyGc(+e.target.value));

  $('gran').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...$('gran').children].forEach((x) => x.classList.toggle('on', x === b));
    runner.config({ granule: +b.dataset.g });
    freshFilesystem(runner, churn);
    log(`program granule → ${b.dataset.g} B (re-formatted)`, 'sys');
  });
  $('heat').addEventListener('change', (e) => viz.setHeatmap(e.target.checked, $('die')));

  // ---- JS console ----
  // Paced console facade: `await fs.write(...)` waits for the op to play out (its
  // simulated flash time), so an awaited loop steps through one op at a time.
  // The internal auto-workload keeps using the synchronous `fs`.
  // Paced console facade: `await fs.write(...)` blocks for the op's simulated time
  // (scaled by SPEED), locking a console loop to the animation. `list` streams.
  const pfs = {
    write: (n, d) => pace(() => fs.write(n, d)),
    read: (n) => pace(() => fs.read(n)),
    cat: (n) => pace(() => fs.cat(n)),
    remove: (n) => pace(() => fs.remove(n)),
    gcStep: () => pace(() => fs.gcStep()),
    list: () => lsStream(false),
    exists: (n) => fs.exists(n),
    fsinfo: () => fs.fsinfo(),
    device: runner.device, geometry: runner.geometry, get hostBytes() { return runner.hostBytes; },
  };
  const scope = {
    fs: pfs, device: runner.device, viz, randomBytes, help,
    ls: () => lsStream(true),
    cat: (n) => pace(() => fs.cat(n)),
    gc: async (n = 1) => { let a; for (let i = 0; i < Math.max(1, n | 0); i++) a = await pace(() => fs.gcStep()); return a; },
    print: (...a) => log(a.map(formatVal).join(' '), 'out'),
    text: (s) => new TextEncoder().encode(s),
  };
  // ---- command history: up/down cycles, persisted to localStorage (last 20) ----
  const HKEY = 'flashvis.console.history', HMAX = 20;
  // Only a real browser gets persistence: the headless fake-DOM never defines `window`
  // (emscripten sniffs it), so gating on it skips localStorage — and its stubs/warnings — there.
  const store = typeof window !== 'undefined' ? window.localStorage : null;
  const loadHist = () => { try { const h = JSON.parse(store.getItem(HKEY)); return Array.isArray(h) ? h : []; } catch { return []; } };
  const saveHist = () => { try { store.setItem(HKEY, JSON.stringify(cmdHist)); } catch { /* no storage / private mode */ } };
  let cmdHist = loadHist();
  let hidx = cmdHist.length;   // == length means the live draft line (past the newest entry)
  let draft = '';              // the in-progress line, stashed while browsing up
  const input = $('terminput');
  const setInput = (v) => { input.value = v; input.setSelectionRange(v.length, v.length); };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const src = input.value.trim(); if (!src) return;
      input.value = '';
      if (cmdHist[cmdHist.length - 1] !== src) {   // skip consecutive duplicates
        cmdHist.push(src);
        if (cmdHist.length > HMAX) cmdHist = cmdHist.slice(-HMAX);
        saveHist();
      }
      hidx = cmdHist.length; draft = '';
      runConsole(src, scope);
    } else if (e.key === 'ArrowUp') {
      if (!cmdHist.length) return;
      e.preventDefault();
      if (hidx === cmdHist.length) draft = input.value;   // stash the draft before leaving it
      hidx = Math.max(0, hidx - 1);
      setInput(cmdHist[hidx]);
    } else if (e.key === 'ArrowDown') {
      if (hidx === cmdHist.length) return;
      e.preventDefault();
      hidx += 1;
      setInput(hidx === cmdHist.length ? draft : cmdHist[hidx]);
    }
  });
  log('console ready — await fs.write(...) paces to simulated time.', 'sys');
  help();
}

function freshFilesystem(runner, churn) {
  runner.format();
  runner.mount();
  if (churn) churn.reset();   // start the churn model over from its seed, matching the empty chip
}

// gcRatio = share of steps spent on a background GC step vs a foreground file op.
// Turn it down and FASTFFS falls back to inline (foreground) GC during writes —
// watch individual write() times spike in the log and garbage pile up.
// Churn model: the ported FASTFFS generator (churn.js) decides the next op and
// drives the FS toward a steady-state live size. Each step is either a background
// GC step or one model event (a write or a delete), applied to the model only
// after the FS op so the model's slot table stays in lockstep with the chip.
function workloadStep(fs, gcRatio, churn) {
  if (Math.random() < gcRatio) { try { fs.gcStep(); } catch { /* logged by timed() */ } return; }
  const ev = churn.next();
  if (ev.type === CHURN_EVENT.WRITE) {
    try { fs.write(ev.name, randomBytes(ev.size)); } catch { /* logged by timed() */ }
    churn.apply(ev);
  } else if (ev.type === CHURN_EVENT.DELETE) {
    try { fs.remove(ev.name); } catch { /* logged by timed() */ }
    churn.apply(ev);
  }
  // DONE / NO_SLOT: nothing to issue this step.
}

// slider 0..100 → sim-ns per real-ms on a log scale. Real flash time = 1e6.
// Low = slow-mo, mid ≈ real-time, high = faster than real-time, 100 = no delay.
function applySpeed(v, viz) {
  let scale, label;
  if (v >= 100) { scale = Infinity; label = 'max · no delay'; }
  else {
    const lo = Math.log10(3000), hi = Math.log10(1e8);
    scale = Math.pow(10, lo + (hi - lo) * (v / 99));
    const x = scale / 1e6; // >1 faster than real flash, <1 slower
    label = (x >= 0.9 && x <= 1.15) ? '≈ real-time'
      : x < 1 ? `${(1 / x < 10 ? (1 / x).toFixed(1) : Math.round(1 / x))}× slow-mo`
      : `${x < 10 ? x.toFixed(1) : Math.round(x)}× real-time`;
  }
  viz.setScale(scale);
  $('speedRead').textContent = label;
  return !isFinite(scale);
}

// Cheap, frequent: device counters + display fractions (no flash re-scan).
function refreshHUD(runner, viz) {
  const m = viz.metrics();
  const s = runner.device.stats;
  const info = runner.fsinfo();
  const wa = runner.hostBytes ? (s.programBytes / runner.hostBytes) : 1;
  let peakWear = 0; for (const w of runner.device.wear) if (w > peakWear) peakWear = w;

  set('sAmp', wa.toFixed(1) + '×'); set('fAmp', wa.toFixed(1) + '×');
  set('fProg', Math.round(100 * m.displayedBytes / m.capacityBytes) + '%');
  set('fFree', m.erasedPages);
  set('sFiles', info.files);
  set('sBytes', (info.bytes / 1024).toFixed(1) + ' KB');
  set('sErase', s.erases); set('fErase', s.erases);
  set('sRead', s.reads); set('sWear', peakWear);
  set('fSim', fmtTime(s.simNs));
  $('specLive').textContent = `mounted · ${info.files} files · ${fmtTime(s.simNs)} of flash time`;
}

// Expensive, on-change only: reachability walk → die tint + precise live/garbage.
function refreshLiveness(runner, viz) {
  const map = runner.liveMap();
  if (!map) return;
  viz.applyLiveMap(map);
  const c = viz.liveCounts();
  const programmed = c.live + c.obsolete + c.metadata;
  set('sObs', programmed ? Math.round(100 * c.obsolete / programmed) + '%' : '0%');
  $('uProg').style.width = (100 * c.live / viz.npages) + '%';
  $('uObs').style.width = (100 * c.obsolete / viz.npages) + '%';
  let liveSectors = 0; const pps = viz.pagesPerSector;
  for (let sec = 0; sec * pps < map.length; sec++)
    for (let k = 0; k < pps; k++) if (map[sec * pps + k] === 3) { liveSectors++; break; }
  set('sLive', liveSectors);
}

const fmtTime = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };
function set(id, v) { const e = $(id); if (e) e.textContent = v; }

function logOp(label, batch, err) {
  if (err) { log(`${label} → ${err.message || err}`, 'err'); return; }
  const ns = batch.reduce((a, e) => a + e.ns, 0);
  const c = { read: 0, prog: 0, erase: 0 };
  for (const e of batch) c[e.op] = (c[e.op] || 0) + 1;
  const parts = [];
  if (c.erase) parts.push(`${c.erase} erase`);
  if (c.prog) parts.push(`${c.prog} prog`);
  if (c.read) parts.push(`${c.read} read`);
  log(`${label} → ${fmtTime(ns)}${parts.length ? ' · ' + parts.join(' ') : ''}`, 'out');
}

function runConsole(src, scope) {
  log('› ' + src, 'in');
  const names = Object.keys(scope), vals = Object.values(scope);
  let fn;
  try { fn = new AsyncFunction(...names, 'return (' + src + ')'); }
  catch { try { fn = new AsyncFunction(...names, src); } catch (e) { log(String(e), 'err'); return; } }
  Promise.resolve().then(() => fn(...vals))
    .then((r) => { if (r !== undefined) log(formatVal(r), 'out'); })
    .catch((e) => log(String(e && e.message || e), 'err'));
}

function formatVal(v) {
  if (v instanceof Uint8Array) {
    const head = [...v.slice(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return `Uint8Array(${v.length}) ${head}${v.length > 24 ? ' …' : ''}`;
  }
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); }
}

function help() {
  [
    'FILES  (prefix with await to pace to simulated flash time):',
    '  fs.write(name, data)    create/replace — data = string | Uint8Array',
    '  fs.read(name) → bytes   ·  cat(name) → text   ·  fs.remove(name)',
    '  ls() / fs.list() → [{name,size}]   ·  fs.exists(name) → bool',
    '  gc(n=1) / fs.gcStep()   run n background GC steps',
    '  fs.fsinfo() → { files, bytes }',
    'DEVICE / VIEW:',
    '  device   flash, wear[], stats{reads,programs,erases,simNs,programBytes}',
    '  fs.geometry   { sectorSize, sectorCount, pageSize, granule }',
    '  viz   pending(), setScale(nsPerMs), liveCounts()',
    'HELPERS:  randomBytes(n) → bytes   ·   text(s) → bytes   ·   print(x)   ·   help()',
    'example:  for (let i=0;i<10;i++) print(await ls())      // stream results',
    'example:  for (let i=0;i<10;i++) await fs.write(`log_${i}.dat`, randomBytes(500))',
  ].forEach((l) => log(l, 'sys'));
}

function log(msg, cls = 'out') {
  const out = $('termout');
  const line = document.createElement('div');
  line.className = 'line ' + cls;
  line.textContent = msg;
  out.appendChild(line);
  while (out.children.length > 300) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}
