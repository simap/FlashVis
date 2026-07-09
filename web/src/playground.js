/*
 * Playground: the SESSION MANAGER (ADR-0015), now driving N sessions through a
 * lockstep coordinator (ADR-0016) instead of exactly one. Boots the shared
 * shell — control panel, HUD, JS console — owns the FS registry, ONE churn
 * generator, and the coordinator that fans it out to every PARTICIPATING
 * session. Exactly one session is DISPLAYED at a time: its die is shown, its
 * op-log feeds the console, and its HUD/liveness numbers drive the shared
 * stat DOM. Every filesystem call a session issues is wrapped by its own
 * timed(), which captures the device ops it issued and logs the real
 * simulated flash cost, e.g.
 *   ls() → 3.10 ms · 31 read
 *   write(boot.log, 912 B) → 24.8 ms · 1 erase 6 prog 3 read
 *
 * The churn *generator* and the gc-vs-event decision live in lockstep.js, not
 * here and not in any session — this file just wires the shared controls
 * (Run/Step/SPEED/BG-GC/mode/participants) to the coordinator, and the
 * display switch to whichever session is currently shown.
 */
import { createSession } from './session.js';
import { createChurnModel, CHURN_CLASS } from './churn.js';
import { createLockstep } from './lockstep.js';
import { FF_CAP_GC, FF_CAP_LIVE_MAP } from './runner.js';

// FS registry (ADR-0015): fsId → display name. Adding a driver is: a new entry
// here, a matching picker button + compare row in index.html (ids
// "fsPick-<fsId>" / "cmpRow-<fsId>"), and dist/<fsId>.mjs built (ADR-0011) —
// the manager, the session, and the coordinator need nothing else.
const FS_REGISTRY = { fastffs: 'FASTFFS', littlefs: 'LittleFS' };
const DEFAULT_FS = 'fastffs';

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
const fmtTime = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };

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
const enc = new TextEncoder();
const sizeOf = (d) => (typeof d === 'string' ? enc.encode(d).length : d.length);

boot().catch((e) => log(String(e && e.stack || e), 'err'));

async function boot() {
  const geometry = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
  let granule = geometry.granule;
  let prepMode = false;

  const churn = createChurnModel({
    seed: CHURN_SEED,
    targetLiveBytes: CHURN_TARGET_LIVE,
    targetWrittenBytes: CHURN_TARGET_WRITTEN,
    targetSlackBytes: CHURN_TARGET_SLACK,
    forceLargeAfterBytes: CHURN_FORCE_LARGE_AFTER,
    profile: churnProfile(),
    slotCount: 256,
  });
  // The coordinator (ADR-0016) owns the ONE canonical step sequence generated
  // from this churn model + its own seeded gc-vs-event coin — sessions never
  // decide what runs next, they only execute what they're handed.
  const coordinator = createLockstep({ churn });

  // Participating sessions (fsId → session) and which one is DISPLAYED. Every
  // control below that used to read a single `activeSession` still does —
  // it's just reassigned by setDisplayed() instead of by an exclusive switch.
  const sessions = new Map();
  let displayedFsId = DEFAULT_FS;
  let activeSession = null;

  async function mkSession(fsId) {
    return createSession(fsId, {
      geometry: { ...geometry, granule },
      container: $('dieStack'),
      // Route this session's op-log only while it's the displayed one — a
      // session's onLog is fixed at creation (session.js has no setter), so
      // the check happens live against the outer `displayedFsId` on every
      // call instead of needing to rebind anything.
      onLog: (msg, cls) => { if (fsId === displayedFsId) log(msg, cls); },
      name: FS_REGISTRY[fsId],
    });
  }

  log(`loading ${FS_REGISTRY[DEFAULT_FS]} (WASM)…`, 'sys');
  const first = await mkSession(DEFAULT_FS);
  sessions.set(DEFAULT_FS, first);
  coordinator.setSessions([...sessions.values()]);

  // ---- display switch: show one session's die/HUD/log/console, hide the rest ----
  function setDisplayed(fsId) {
    // Detach the outgoing session's inspector so its still-running rAF loop
    // (sessions keep animating while hidden — Race/Pace both need that) stops
    // writing into the shared #insp panel the moment it's no longer shown.
    if (activeSession) activeSession.attachInspector(null);
    displayedFsId = fsId;
    activeSession = sessions.get(fsId);
    for (const [id, s] of sessions) s.setActive(id === fsId);
    activeSession.attachInspector($('insp'));
    activeSession.setPrep(prepMode);
    $('insp').innerHTML = '<span class="hint">Click a sector to inspect it.</span>';
    applyCapsGating(activeSession.caps);
    $('tagFsName').textContent = activeSession.name;
    for (const id of Object.keys(FS_REGISTRY)) {
      $('fsPick-' + id)?.classList.toggle('on', sessions.has(id));
      $('cmpRow-' + id)?.classList.toggle('sel', id === fsId);
    }
  }
  setDisplayed(DEFAULT_FS);

  $('specGeo').textContent =
    `${(activeSession.device.size / 1024) | 0} KB · ${geometry.sectorCount}×${geometry.sectorSize / 1024} KB · ESP32-S3 timing`;

  coordinator.reset();   // empty + paused — nothing is written until Run or a console op
  log('formatted + mounted — empty and paused. Press Run, or drive it from the console.', 'sys');

  setInterval(() => activeSession.refreshHUD($), 160);
  // The liveness walk re-scans the on-flash index (mount-like); refreshLiveness
  // itself no-ops unless the DISPLAYED session's flash changed since the last call.
  setInterval(() => activeSession.refreshLiveness($), 250);
  // Compare strip: every participant, not just the displayed one (ADR-0016) —
  // this is the only place that reads every session's numbers at once.
  setInterval(() => renderCompareRows(), 250);
  function renderCompareRows() {
    const snaps = coordinator.snapshots();
    for (const snap of snaps) {
      const row = $('cmpRow-' + snap.fsId);
      if (!row) continue;
      row.classList.remove('hidden');
      const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      set('cmpStep-' + snap.fsId, String(snap.stepCursor));
      set('cmpSim-' + snap.fsId, fmtTime(snap.simNs));
      set('cmpWa-' + snap.fsId, snap.wa.toFixed(1) + '×');
      set('cmpFiles-' + snap.fsId, String(snap.files));
      set('cmpGarbage-' + snap.fsId, Math.round(100 * snap.garbagePct) + '%');
    }
    for (const id of Object.keys(FS_REGISTRY)) {
      if (!sessions.has(id)) $('cmpRow-' + id)?.classList.add('hidden');
    }
  }
  renderCompareRows();

  // ---- Run/Pause, Step: act on the WHOLE participating set via the coordinator ----
  const setRunning = (v) => {
    if (v) coordinator.start(); else coordinator.stop();
    $('runLabel').textContent = v ? 'Pause' : 'Run';
    $('btnRun').querySelector('.dot').style.background = v ? 'currentColor' : '#241a06';
  };
  setRunning(false);   // start paused — the initial seed animates in, then it idles

  // ---- participants (ROADMAP: lockstep multiple filesystems) ----
  // Clicking a picker button TOGGLES that FS's participation (multi-select) —
  // at least one must always stay selected. Any change resets every
  // participant to a fresh chip (ADR-0015's "no carryover" rule, extended).
  for (const fsId of Object.keys(FS_REGISTRY)) {
    $('fsPick-' + fsId)?.addEventListener('click', () => toggleParticipant(fsId));
  }
  async function toggleParticipant(fsId) {
    const willJoin = !sessions.has(fsId);
    if (!willJoin && sessions.size === 1) {
      log('at least one filesystem must stay selected', 'sys');
      return;
    }
    if (willJoin) {
      log(`loading ${FS_REGISTRY[fsId]} (WASM)…`, 'sys');
      let s;
      try { s = await mkSession(fsId); }
      catch (e) { log(`failed to add ${FS_REGISTRY[fsId]}: ${(e && e.message) || e}`, 'err'); return; }
      sessions.set(fsId, s);
      s.setHeatmap($('heat').checked);
      s.setPrep(prepMode);
    } else {
      sessions.get(fsId).teardown();
      sessions.delete(fsId);
      if (displayedFsId === fsId) displayedFsId = sessions.keys().next().value;
    }
    coordinator.setSessions([...sessions.values()]);
    coordinator.reset();
    applySpeed(+$('speed').value);   // re-fan the current scale to the new set
    setDisplayed(displayedFsId);
    renderCompareRows();
    const names = [...sessions.values()].map((s) => s.name).join(', ');
    log(`participants: ${names} — fresh, empty chip${sessions.size > 1 ? 's' : ''}.`, 'sys');
  }

  // ---- Race / Pace mode ----
  const markMode = (m) => {
    $('modePick-race')?.classList.toggle('on', m === 'race');
    $('modePick-pace')?.classList.toggle('on', m === 'pace');
  };
  markMode(coordinator.mode);   // reflect the coordinator's default ('race') at boot
  for (const m of ['race', 'pace']) {
    $('modePick-' + m)?.addEventListener('click', () => {
      coordinator.setMode(m);
      markMode(m);
      log(`lockstep mode → ${m}`, 'sys');
    });
  }

  // ---- controls ----
  $('btnRun').addEventListener('click', () => setRunning(!coordinator.running));
  $('btnStep').addEventListener('click', () => coordinator.step());
  $('btnWrite').addEventListener('click', () => activeSession.fs.write(NAMES[rnd(NAMES.length)], randomBytes(300 + rnd(4000))));
  $('btnLs').addEventListener('click', () => activeSession.lsStream(true));
  $('btnDelete').addEventListener('click', () => {
    const known = activeSession.names();
    if (known.length) activeSession.fs.remove(known[rnd(known.length)]);
    else log('  (nothing to delete)', 'sys');
  });
  $('btnGC').addEventListener('click', () => activeSession.fs.gcStep());
  $('btnFormat').addEventListener('click', () => {
    coordinator.reset();
    log(`re-formatted + mounted (empty chip${sessions.size > 1 ? 's' : ''})`, 'sys');
  });

  // slider 0..100 → sim-ns per real-ms on a log scale. Real flash time = 1e6.
  // Low = slow-mo, mid ≈ real-time, high = faster than real-time, 100 = no delay.
  function applySpeed(v) {
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
    coordinator.setSpeed(scale);
    $('speedRead').textContent = label;
  }
  applySpeed(+$('speed').value);
  $('speed').addEventListener('input', (e) => applySpeed(+e.target.value));

  const applyGc = (v) => { coordinator.setGcRatio(v / 100); $('gcRead').textContent = v === 0 ? 'off' : `${v}%`; };
  applyGc(+$('gc').value);
  $('gc').addEventListener('input', (e) => applyGc(+e.target.value));

  $('gran').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...$('gran').children].forEach((x) => x.classList.toggle('on', x === b));
    granule = +b.dataset.g;
    for (const s of sessions.values()) s.runner.config({ granule });
    coordinator.reset();
    log(`program granule → ${granule} B (re-formatted)`, 'sys');
  });
  $('heat').addEventListener('change', (e) => { for (const s of sessions.values()) s.setHeatmap(e.target.checked); });

  // ---- JS console ----
  // Paced console facade: `await fs.write(...)` waits for the op to play out (its
  // simulated flash time), so an awaited loop steps through one op at a time.
  // The coordinator's auto-workload keeps using each session's synchronous
  // runChurnEvent/runGcStep. Every helper below reads `activeSession` live, so
  // the display switch rebinds the whole console surface for free.
  // Raw handle proxy (ADR-0014 Tier 2): each op is logged by timed() and paced by
  // pace(), so `await f.read(n)` blocks for the partial read's simulated flash time.
  const pacedFile = (h) => ({
    read: (n) => activeSession.pace(() => activeSession.timed(`file.read(${n} B)`, () => h.read(n))),
    write: (d) => activeSession.pace(() => activeSession.timed(`file.write(${sizeOf(d)} B)`, () => h.write(d))),
    seek: (o, w = 'set') => activeSession.pace(() => activeSession.timed(`file.seek(${o}, ${w})`, () => h.seek(o, w))),
    stat: () => activeSession.pace(() => activeSession.timed('file.stat()', () => h.stat())),
    close: () => activeSession.pace(() => activeSession.timed('file.close()', () => h.close())),
  });
  const pacedDir = (d) => ({
    read: () => activeSession.pace(() => d.read()),
    close: () => activeSession.pace(() => d.close()),
  });
  const pfs = {
    write: (n, d) => activeSession.pace(() => activeSession.fs.write(n, d)),
    read: (n) => activeSession.pace(() => activeSession.fs.read(n)),
    cat: (n) => activeSession.pace(() => activeSession.fs.cat(n)),
    remove: (n) => activeSession.pace(() => activeSession.fs.remove(n)),
    stat: (n) => activeSession.pace(() => activeSession.fs.stat(n)),
    mkdir: (n) => activeSession.pace(() => activeSession.fs.mkdir(n)),
    gcStep: () => activeSession.pace(() => activeSession.fs.gcStep()),
    list: (prefix) => activeSession.lsStream(false, prefix),
    exists: (n) => activeSession.fs.exists(n),
    open: async (name, mode = 'r') => pacedFile(await activeSession.pace(() => activeSession.timed(`open(${name}, ${mode})`, () => activeSession.runner.open(name, mode)))),
    openDir: async (prefix = '') => pacedDir(await activeSession.pace(() => activeSession.runner.openDir(prefix))),
    format: () => activeSession.runner.format(),
    mount: () => activeSession.runner.mount(),
    unmount: () => activeSession.runner.unmount(),
    sectorClasses: () => activeSession.runner.sectorClasses(),
    liveMap: () => activeSession.runner.liveMap(),
    fsinfo: () => activeSession.fs.fsinfo(),
    get device() { return activeSession.device; },
    get geometry() { return activeSession.geometry; },
    get hostBytes() { return activeSession.fs.hostBytes; },
  };

  // Tier-1 friendly pokes (ADR-0014): optional args, data-agnostic, all paced, each
  // returning a descriptor so a console script self-tracks its file set with no
  // runner.names() backdoor. A no-arg read/delete lands on a tracked file and reports it.
  let fileSeq = 0;
  const STOCK_SIZE = 1024;
  const autoName = () => `f${(fileSeq++).toString(36).padStart(3, '0')}.dat`;
  const pickKnown = () => { const k = activeSession.names(); if (!k.length) throw new Error('no files yet — write one first'); return k[rnd(k.length)]; };
  const writeFile = async (name, size = STOCK_SIZE) => { const n = name ?? autoName(); await pfs.write(n, randomBytes(size)); return { name: n, size }; };
  const readFile = async (name) => { const n = name ?? pickKnown(); const bytes = await pfs.read(n); return { name: n, size: bytes.length }; };
  const deleteFile = async (name) => { const n = name ?? pickKnown(); const st = await pfs.stat(n); await pfs.remove(n); return { name: n, size: st ? st.size : 0 }; };
  // mkdir -p: create each missing parent by looping the single-level shim primitive
  // (a no-op success on flat FASTFFS; real on LittleFS later). See ADR-0014 Namespace.
  const mkdirP = async (path) => { let cur = ''; for (const p of String(path).split('/').filter(Boolean)) { cur += (cur ? '/' : '') + p; await pfs.mkdir(cur); } return 'ok'; };
  const getFiles = (prefix) => activeSession.lsStream(false, prefix);

  const scope = {
    fs: pfs, get device() { return activeSession.device; }, get viz() { return activeSession.viz; }, randomBytes, help,
    writeFile, readFile, deleteFile, mkdir: mkdirP, getFiles,
    ls: (prefix) => activeSession.lsStream(true, prefix),
    cat: (n) => activeSession.pace(() => activeSession.fs.cat(n)),
    gc: async (n = 1) => { let a; for (let i = 0; i < Math.max(1, n | 0); i++) a = await activeSession.pace(() => activeSession.fs.gcStep()); return a; },
    // Setup mode: full speed, no animation, still logs — for bulk seed/framework code.
    // Applies to every participant (not just the displayed one) so a bulk script
    // seeds the whole lockstep set uniformly.
    prep: (enable = true) => {
      prepMode = !!enable;
      for (const s of sessions.values()) s.setPrep(prepMode);
      log(`prep ${prepMode ? 'on — full speed, no animation (still logging)' : 'off — paced + animated'}`, 'sys');
    },
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

  // ---- display switch: clicking a compare row shows that participant ----
  for (const fsId of Object.keys(FS_REGISTRY)) {
    $('cmpRow-' + fsId)?.addEventListener('click', () => {
      if (!sessions.has(fsId) || fsId === displayedFsId) return;
      setDisplayed(fsId);
      renderCompareRows();
      log(`${activeSession.name} displayed.`, 'sys');
    });
  }
}

// Caps-gating (ADR-0011/0015): hide controls the DISPLAYED FS disclaims instead
// of showing a dead/no-op control. Driven off the runtime `caps` bitmask, never
// assumed from the fsId — a driver's advertised capabilities are the contract.
function applyCapsGating(caps) {
  const toggle = (id, hide) => { const e = $(id); if (e) e.classList.toggle('hidden', hide); };
  toggle('ctlGc', !(caps & FF_CAP_GC));
  toggle('statGarbage', !(caps & FF_CAP_LIVE_MAP));
  toggle('utilBar', !(caps & FF_CAP_LIVE_MAP));
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
    'POKES  (friendly, optional args, all paced — prefix with await):',
    '  writeFile(name?, size?) → {name,size}    random bytes; random name / stock size when omitted',
    '  readFile(name?) → {name,size}   ·   deleteFile(name?) → {name,size}   (no-arg lands on a tracked file)',
    '  mkdir(path)  mkdir -p (no-op on flat FASTFFS)   ·   getFiles(prefix?) → [{name,size}]   ·   ls(prefix?)',
    'FILES  (raw fs. layer — await to pace to simulated flash time):',
    '  fs.write(name, data)    create/replace — data = string | Uint8Array',
    '  fs.read(name) → bytes   ·  cat(name) → text   ·  fs.remove(name)   ·  fs.stat(name) → {name,size}|null',
    '  fs.list(prefix?) → [{name,size}]   ·  fs.exists(name) → bool   ·  fs.mkdir(name)',
    '  gc(n=1) / fs.gcStep()   run n background GC steps   ·   fs.fsinfo() → { files, bytes }',
    'HANDLES  (partial / positioned I/O — every op paced):',
    "  const f = await fs.open(name, 'r'|'w')   → f.read(n), f.write(bytes), f.seek(off, 'set'|'cur'|'end'), f.stat(), f.close()",
    '  const d = await fs.openDir(prefix?)      → d.read() → {name,size}|null, d.close()',
    'MODES:  fs.format() / fs.mount() / fs.unmount()   ·   fs.sectorClasses() / fs.liveMap()',
    '  prep(true)   full-speed setup: no animation, no await-pacing, still logs; prep(false) resumes',
    'FS:  the FS row (top of the transport bar) toggles which filesystems PARTICIPATE — 2+ selected runs',
    '  them lockstep (RACE/PACE); click a Compare row to pick which one is DISPLAYED. Fresh, empty chips,',
    '  no carryover, on every participant change. A control disappears when the displayed FS disclaims',
    '  that capability (ADR-0011).',
    'DEVICE / VIEW:',
    '  device   flash, wear[], stats{reads,programs,erases,simNs,programBytes}',
    '  fs.geometry   { sectorSize, sectorCount, pageSize, granule }',
    '  viz   pending(), setScale(nsPerMs), liveCounts()',
    'HELPERS:  randomBytes(n) → bytes   ·   text(s) → bytes   ·   print(x)   ·   help()',
    'example:  for (let i=0;i<10;i++) print(await writeFile())      // self-tracking set',
    "example:  const f = await fs.open('log.dat','w'); await f.write(text('hi')); await f.close()",
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
