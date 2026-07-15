/*
 * session-worker.js — the worker-per-session executor (ADR-0024). Speaks
 * ONLY protocol.js's wire: INIT/ENTRIES/GRANT/PULL/RESET in, GRANT_ACK/FRAME/
 * TELEMETRY out. On INIT it builds runner ⊕ device ⊕ heat ⊕ journal/event
 * rings for one session; ENTRIES prefetch (authorize nothing); GRANT is the
 * whole control plane (entryLimit + playLimitNs + scale); PULL returns render
 * data for a focused session; RESET halts and rebuilds.
 *
 * EXECUTION MODEL (ADR-0024 §2/§5/§6 — the WORKER-SIDE TIMED PLAYER, relocated
 * from viz.js's frame() drain + session.js's timed()/runCommand). Two layers,
 * exactly ADR-0009's split, now both worker-side:
 *
 *   1. EXECUTION — synchronous, eager. A churn event / gc step / command runs
 *      to completion in WASM the instant it is authorized (cursor < entryLimit,
 *      bounded only by TAPE_CAP/BACKLOG so it can't outrun playback without
 *      limit — I3). simNs (device telemetry) vaults on a sync WASM call; that's
 *      fine, simNs is NEVER the currency. Every device op the run emits is
 *      CAPTURED (per op, for the tape's time+breakdown line — B5) and QUEUED
 *      onto the playback queue, not applied to heat yet.
 *   2. PLAYBACK — a metered ~16ms tick (relocated viz.frame()). Each tick spends
 *      a real-time budget realBudgetMs × grant.scale, CAPPED at playLimitNs
 *      (§2), draining the queue CONTINUOUSLY intra-event (a 21ms erase holds
 *      across frames, not one flash — curRem carries forward) and applying heat
 *      as it drains. playbackNs — the §2 currency reported in grantAck — advances
 *      only here, so it paces to real-time: 5× slow-mo ⇒ ~1/5 real-time, no-delay
 *      ⇒ flat-out but chunked at MAX_OPS_PER_FRAME (ADR-0022 drain pacing,
 *      carry-forward — paces the drain, drops nothing; the I8 heat veto holds).
 *      Race honours a finite scale because the same playLimitNs ceiling gates it
 *      (B9). entriesDrained = highest entry INDEX whose queued events have all
 *      drained; a Pace step ack needs entry executed ∧ metered playback drained.
 *
 * SYNTHETIC entries (message-level conformance suite: { costNs, ... } payloads,
 * no runner) have no device events, so they can't be metered by a real tick —
 * they COMMIT synchronously on GRANT against playLimitNs (per-entry, one-op
 * overshoot), which is execution==playback for a costless-to-run entry. The two
 * paths coexist; a session is all-synthetic (runner-less) or all-real.
 *
 * Transport-agnostic: installWorkerHost(port, opts) wires onto anything
 * MessagePort-shaped — a real dedicated Worker's `self`, the mock transport's
 * workerPort in tests. A bootstrap at the bottom self-attaches to `self`.
 *
 * Relocated from the (retired) main-thread session.js/viz.js: the ADR-0019
 * in-flight-counter/macrotask-quiescence (runCommand), the ADR-0019 sandbox
 * (makeSandbox/compileSource), timed() op capture, journal + prep, and the
 * viz.js timed player (frame()/MAX_OPS_PER_FRAME/continuous intra-event).
 */
import { C2W, W2C, msg } from './protocol.js';
import { createRunner as defaultCreateRunner } from './runner.js';
import { CHURN_EVENT } from './churn.js';
import { createHeatPlayer } from './worker-heat.js';
import { createRing } from './worker-rings.js';

// ---- local tunables (worker-internal; NOT wire fields) ----
const TELEMETRY_MS = 250;           // W2C.TELEMETRY cadence (§4/§8: unconditional heartbeat)
const METER_MS = 16;                // playback metering tick (~one frame; relocated viz.frame cadence)
const JOURNAL_MAX = 2000;           // ring bound; protocol.js's JOURNAL_MIN (400) is the wire floor
const MIN_ANIM = 110, MAX_ANIM = 9000;   // erase-sweep animated-slot bounds (viz.js parity), for EventEntry.ms
// ADR-0022 drain pacing (relocated verbatim from viz.js): cap device steps drained
// per playback tick, carrying the remainder forward — so a huge burst (a no-delay
// compaction of ~30k tiny reads) stays visibly lit across frames instead of mushing
// into one decay flash. Paces the DRAIN; drops nothing (I8 veto holds).
const MAX_OPS_PER_FRAME = 500;
// I3 execution backpressure: how far EXECUTION (executedTapeNs) may run ahead of
// paced PLAYBACK (playbackNs) before the pump parks. A single sync WASM call may
// still vault past this in one macrotask (accepted, ADR-0019/§5 I3); this only
// stops the pump from starting the NEXT entry. Keeps the queue bounded at deep
// slow-mo where a frame's budget is ≪ one op.
const TAPE_CAP = 1_000_000_000;     // 1 sim-second of executed-but-unplayed flash
const BACKLOG_CAP = 100_000;        // hard cap on queued device steps (event-count guard)

const fmtTime = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };

// Console help text (ADR-0019 buildConsoleApi parity, restored verbatim from the
// retired playground.js HELP_TEXT). Worker-side because the wire ships RAW console
// source (`help()`) that the sandbox compiles here — help() prints against the
// per-session api.print, so every per-FS tape shows it.
const HELP_TEXT = [
  'POKES  (friendly, all paced — prefix with await):',
  '  writeFile(name?, size?)  ·  readFile(name?)  ·  deleteFile(name?)  → {name,size}   ·   stat(name) → {name,size}|null',
  '    (no-arg read/delete lands on a tracked file; deleteFile also takes a prior result, e.g. deleteFile(last))',
  '  ls(prefix?)   ·   getFiles(prefix?) → [{name,size}]   ·   mkdir(path)  (mkdir -p; no-op on flat FASTFFS)',
  'RAW fs.  (await to pace to simulated flash time):',
  '  fs.write(name, data)  ·  fs.read(name)  ·  fs.remove(name)  ·  fs.stat(name)  ·  fs.mkdir(name)  ·  fs.format()/mount()/unmount()',
  "HANDLES:  const f = await fs.open(name, 'r'|'w')  → f.read(n), f.write(bytes), f.seek(off, 'set'|'cur'|'end'), f.stat(), f.close()",
  '          const d = await fs.openDir(prefix?)  → d.read() → {name,size}|null, d.close()',
  'HELPERS:  gc(n=1)  ·  format()  ·  randomBytes(n)  ·  text(s) → bytes  ·  print(x)  ·  help()',
  'ONE LINE = ONE ATOMIC COMMAND (queued → live → done); an undeclared loop var (for (i=0;…)) stays local to the line.',
  "example:  let f = await writeFile(); for (i=0;i<5;i++) await writeFile('n'+i, 64); await deleteFile(f)",
].join('\n');

// ---- deterministic content generation (ADR-0015/0019) — pure, relocated verbatim ----
function deterministicBytes(seed, n) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashNameSize(name, size) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= size; h = Math.imul(h, 0x01000193);
  return h >>> 0;
}
const enc = new TextEncoder();
const sizeOf = (d) => (typeof d === 'string' ? enc.encode(d).length : (d ? d.length : 0));

// ---- ADR-0019 command sandbox (ported from playground.js's makeSandbox /
// compileCommand — the wire ships RAW console source text; the worker compiles
// it). has-trap true for every name; get resolves api → per-invocation bag →
// globalThis; set writes undeclared assignments to the bag. `with(scope){…}`
// needs sloppy mode, hence new AsyncFunction (never a strict/module compile). ----
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function makeSandbox(api) {
  const bag = Object.create(null);
  return new Proxy(Object.create(null), {
    has() { return true; },
    get(_t, key) {
      if (api && key in api) return api[key];
      if (key in bag) return bag[key];
      return Reflect.get(globalThis, key, globalThis);
    },
    set(_t, key, value) { bag[key] = value; return true; },
  });
}
function compileSource(src) {
  let fn;
  try { fn = new AsyncFunction('scope', 'with(scope){ return (\n' + src + '\n); }'); }
  catch { fn = new AsyncFunction('scope', 'with(scope){\n' + src + '\n}'); }
  return (api) => fn(makeSandbox(api));
}

// ---- synthetic-payload detection (message-level test contract, NOT protocol.js)
// event/gc: { costNs, fileOps? } · command: { costNs?, fileOps?, ticks?, prep? }.
// A real event ships a churn object ({type,name,...}); a real command ships a
// SOURCE string. So `costNs`/`prep`/`ticks` present ⇒ synthetic; a string
// command ⇒ real (the two coexist so the WASM-free conformance suite drives the
// same state machine production does). ----
const isSyntheticEvent = (p) => p && typeof p === 'object' && typeof p.costNs === 'number';
const isSyntheticCommand = (p) => p && typeof p === 'object' && (typeof p.costNs === 'number' || 'prep' in p || 'ticks' in p);

/**
 * @param {{postMessage:Function, onmessage:*}} port  the worker-side port (self, or a mock)
 * @param {Object} [opts]
 * @param {Function} [opts.createRunner]  injectable runner factory; defaults to
 *   runner.js's real WASM loader. A build failure is non-fatal — the session
 *   runs runner-less, which is exactly how the WASM-free conformance suite
 *   (synthetic-cost entries only) exercises the §2/§5/§9 state machine.
 */
export function installWorkerHost(port, opts = {}) {
  const createRunnerFn = opts.createRunner || defaultCreateRunner;

  let epoch = -1, gen = 0;                         // I5: gen bumps on every (re)build; stale async work checks it and starves
  let runner = null, device = null, heat = null, journal = null, events = null;
  let fsId = null, geometry = null;
  let entries = [];                                // entries[i] = {index, kind, payload, seed}
  let cursor = 0;                                  // next unexecuted entry index (EXECUTION frontier)
  let entriesDrained = -1;                         // highest entry index whose playback has fully drained
  let entryLimit = 0, playLimitNs = 0, scale = 20000, round = -1;
  let playbackNs = 0;                              // §2 currency — advances ONLY on the paced drain (or synthetic commit)
  let dispFileOps = 0, dispFlashNs = 0;            // DISPLAYED drained counters (§9 zeroes these at prep(false))
  let execFileOps = 0;                             // execution total (telemetry) — NOT reset by prep
  let prepActive = false;
  let pendingTick = null;                          // synthetic multi-tick command settling: { index, rem }
  let realCmd = null;                              // real async command in flight: { index, done }
  let telemetryTimer = null, meterTimer = null;
  let mapDirty = true, cachedMap = null, cachedCounts = { live: 0, obsolete: 0, metadata: 0 }, livenessGen = 0;
  let lastLivenessWalk = 0;                        // §7/A4: throttle the walk to ≥250ms since last

  // ---- the worker-side timed player's playback queue (relocated viz.js `queue`) ----
  // Each step: { entryIndex, ns, ev|null, fileOps, last, started?, curRem? }. Device
  // events are queued here at EXECUTION and applied to heat at DRAIN. A terminal
  // marker (ns:0, ev:null, last:true, fileOps:N) closes each entry so entriesDrained
  // / dispFileOps advance exactly when an entry's whole playback has elapsed.
  let pbQueue = [];
  let executedTapeNs = 0;                          // cumulative ns of EXECUTED-but-maybe-unplayed events (I3 backpressure)
  let lastTickAt = Date.now();
  let captureBatch = null;                         // active timed() capture sink (set synchronously around a work() call)
  let entryFileOps = 0;                            // file ops accrued by the entry currently executing (credited at drain)

  function send(type, payload) { port.postMessage(msg(type, { epoch, ...payload })); }
  const eraseMs = (ns) => (isFinite(scale) ? Math.max(MIN_ANIM, Math.min(MAX_ANIM, ns / scale)) : MIN_ANIM);
  const backpressured = () => (executedTapeNs - playbackNs) >= TAPE_CAP || pbQueue.length >= BACKLOG_CAP;

  // ---- liveness (ADR-0008/0015 §7): one reachability walk per flash change,
  // throttled to ≥250ms since the last walk (§7/A4 — the walk is real work). ----
  function ensureLiveness() {
    if (!mapDirty || !runner) return;
    const now = Date.now();
    if (now - lastLivenessWalk < 250) return;      // §7: walk iff dirty AND ≥250ms since last
    mapDirty = false;
    lastLivenessWalk = now;
    livenessGen++;
    cachedMap = runner.liveMap();
    if (!cachedMap) { cachedCounts = { live: 0, obsolete: 0, metadata: 0 }; return; }
    let live = 0, obsolete = 0, metadata = 0;
    for (let p = 0; p < cachedMap.length; p++) {
      const c = cachedMap[p];
      if (c === 3) live++; else if (c === 2) obsolete++; else if (c === 1 || c >= 4) metadata++;
    }
    cachedCounts = { live, obsolete, metadata };
  }

  function ack() {
    send(W2C.GRANT_ACK, {
      round, playbackNs, cursor, entriesDrained,
      drainedCounters: { fileOpCount: dispFileOps, flashTimeNs: dispFlashNs },
    });
  }

  // ---- op-log capture (relocated session.js timed()/logOp) ----
  // Build the tape line for one executed op: label + total flash time + device-op
  // breakdown (ADR-0018/0023 observability: `write(f.bin, 28226 B) → 176 ms · 131
  // prog 19 read`). Carries {costNs, flashOps} so a renderer can restyle it (B5).
  function opLogFields(entryIndex, label, batch) {
    let costNs = 0; const c = { read: 0, prog: 0, erase: 0 };
    for (const e of batch) { costNs += e.ns || 0; c[e.op] = (c[e.op] || 0) + 1; }
    const parts = [];
    if (c.erase) parts.push(`${c.erase} erase`);
    if (c.prog) parts.push(`${c.prog} prog`);
    if (c.read) parts.push(`${c.read} read`);
    const text = `${label} → ${fmtTime(costNs)}${parts.length ? ' · ' + parts.join(' ') : ''}`;
    return { entryIndex, kind: 'op', text, costNs, flashOps: { ...c } };
  }

  // Queue a captured batch of device events for paced playback (or, in prep,
  // apply it eagerly — §9: instant, metering off, still measured). `last` closes
  // the entry with a terminal marker carrying its file-op credit.
  function enqueueBatch(entryIndex, batch, last, fileOps) {
    if (prepActive) {
      for (const ev of batch) {
        if (heat) heat.applyEvent(ev);
        if (ev.op === 'erase' && events) events.push({ kind: 'erase', sector: ev.sector, ms: eraseMs(ev.ns) });
        playbackNs += ev.ns || 0; dispFlashNs += ev.ns || 0;
      }
      if (last) { entriesDrained = entryIndex; dispFileOps += fileOps; }
      return;
    }
    for (const ev of batch) { executedTapeNs += ev.ns || 0; pbQueue.push({ entryIndex, ns: ev.ns || 0, ev, fileOps: 0, last: false }); }
    if (last) pbQueue.push({ entryIndex, ns: 0, ev: null, fileOps, last: true });
  }

  // ---- real execution helpers (production path; require a runner) ----
  function bumpFileOp() { execFileOps++; entryFileOps++; }

  // Execute one real (non-synthetic) event/gc entry synchronously, capturing its
  // device ops for the tape + the playback queue. cursor advances immediately
  // (execution); the entry drains later on the metering tick.
  function execRealEntry(index, entry) {
    const ev = entry.payload;
    captureBatch = []; entryFileOps = 0;
    let label = null, err = null;
    // B1: a churn op that throws (over-capacity write, ENOSPC, a remove of a
    // missing file) must NOT crash the worker — the retired in-process path
    // swallowed it. Journal the error, keep the session alive, advance past it.
    try {
      if (entry.kind === 'gc') { runner.gcStep(); label = 'gc()'; }
      else if (ev && ev.type === CHURN_EVENT.WRITE) { bumpFileOp(); runner.write(ev.name, deterministicBytes(ev.writeSeed, ev.size)); label = `write(${ev.name}, ${ev.size} B)`; }
      else if (ev && ev.type === CHURN_EVENT.DELETE) { bumpFileOp(); runner.remove(ev.name); label = `delete(${ev.name})`; }
      // DONE / NO_SLOT: nothing issued, empty batch, no tape line.
    } catch (e) { err = e; }
    const batch = captureBatch; captureBatch = null;
    if (err) journal.push({ entryIndex: index, kind: 'op', text: `${label || 'op'} → ${err.message || err}` });
    else if (label && batch.length) journal.push(opLogFields(index, label, batch));
    enqueueBatch(index, batch, true, entryFileOps);
    cursor = index + 1;
  }

  // Per-session inner API a compiled command runs against (ADR-0014/0019). Every
  // op executes for real (simNs vaults synchronously), its device events captured
  // for the tape + queued for paced playback; the command is atomic and runs to
  // quiescence (I1), its terminal marker pushed at the quiescence ack.
  function buildLocalApi(rng, entryIndex, myGen) {
    const guard = () => { if (myGen !== gen) throw new Error('epoch superseded'); if (!runner) throw new Error('no runner'); };
    // op(): a microtask hop keeps every op async (so quiescence's macrotask
    // re-check has real boundaries — I1), then runs work() synchronously with a
    // timed() capture, journals its time+breakdown line, and queues its events.
    function op(label, work) {
      return Promise.resolve().then(() => {
        guard();
        captureBatch = [];
        let res;
        try { res = work(); }
        catch (e) { captureBatch = null; journal.push({ entryIndex, kind: 'op', text: `${label} → ${e.message || e}` }); throw e; }
        const batch = captureBatch; captureBatch = null;
        journal.push(opLogFields(entryIndex, label, batch));
        enqueueBatch(entryIndex, batch, false, 0);
        return res;
      });
    }
    // Shared dir-scan (ADR-0019): opens a pooled handle, paces each dir.read
    // individually (streaming ls) — real device traffic, driver order. `sorted`
    // (getFiles) sorts the RETURNED array at the JS boundary only (A1); the
    // streamed scan itself always plays driver order.
    async function scanDir(prefix, { printEach = false, sorted = false } = {}) {
      const dir = await op(`openDir(${prefix || ''})`, () => runner.openDir(prefix || ''));
      const files = [];
      for (;;) {
        const e = await op('dir.read()', () => dir.read());
        if (!e) break;
        if (printEach) journal.push({ entryIndex, kind: 'op', text: `  ${e.name}  ${e.size} B` });
        files.push(e);
      }
      await op('dir.close()', () => dir.close());
      if (printEach && !files.length) journal.push({ entryIndex, kind: 'op', text: '  (empty)' });
      if (sorted) files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return files;
    }
    let nameSeq = 0;
    const randomName = () => `f${(nameSeq++).toString(36).padStart(3, '0')}-${((rng() * 0x100000000) >>> 0).toString(16).padStart(8, '0')}.bin`;
    const randomSize = () => 1024 + Math.floor(rng() * (32 * 1024 - 1024));
    function pickExisting() {
      const names = runner.names().sort();
      if (!names.length) throw new Error('no files yet — write one first');
      return names[Math.floor(rng() * names.length)];
    }
    const resolveName = (arg) => (arg && typeof arg === 'object' ? arg.name : (arg ?? undefined)) ?? pickExisting();
    const writeFile = (name, size) => { const n = name ?? randomName(); const sz = size ?? randomSize(); bumpFileOp(); return op(`write(${n}, ${sz} B)`, () => { runner.write(n, deterministicBytes(hashNameSize(n, sz), sz)); return { name: n, size: sz }; }); };
    const readFile = (arg) => { const n = resolveName(arg); bumpFileOp(); return op(`read(${n})`, () => ({ name: n, size: runner.read(n).length })); };
    const deleteFile = (arg) => { const n = resolveName(arg); bumpFileOp(); return op(`delete(${n})`, () => { const st = runner.stat(n); runner.remove(n); return { name: n, size: st ? st.size : 0 }; }); };
    async function mkdir(path) { bumpFileOp(); let cur = ''; for (const part of String(path).split('/').filter(Boolean)) { cur += (cur ? '/' : '') + part; await op(`mkdir(${cur})`, () => runner.mkdir(cur)); } return 'ok'; }
    const ls = (prefix) => { bumpFileOp(); return scanDir(prefix, { printEach: true, sorted: false }); };
    const getFiles = (prefix) => { bumpFileOp(); return scanDir(prefix, { printEach: false, sorted: true }); };
    const stat = (name) => { bumpFileOp(); return op(`stat(${name})`, () => runner.stat(name)); };
    const gc = (n = 1) => { const steps = Math.max(1, n | 0); return op('gc()', () => { let r; for (let i = 0; i < steps; i++) r = runner.gcStep(); return r; }); };
    const print = (...args) => { const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '); for (const line of text.split('\n')) journal.push({ entryIndex, kind: 'op', text: line }); };
    // ---- tier-2 raw fs.* handle/dir API (ADR-0014 RAW tier; restored A2) ----
    function wrapHandle(h, lbl) {
      return {
        read: (n) => op(`read ${lbl}`, () => h.read(n)),
        write: (data) => op(`write ${lbl}`, () => h.write(data)),
        seek: (off, whence) => op(`seek ${lbl}`, () => h.seek(off, whence)),
        stat: () => op(`stat ${lbl}`, () => h.stat()),
        close: () => op(`close ${lbl}`, () => h.close()),
      };
    }
    function wrapDir(d, lbl) {
      return { read: () => op(`dir.read ${lbl}`, () => d.read()), close: () => op(`dir.close ${lbl}`, () => d.close()) };
    }
    const fs = {
      format: () => { bumpFileOp(); return op('format()', () => runner.format()); },
      mount: () => { bumpFileOp(); return op('mount()', () => runner.mount()); },
      unmount: () => { bumpFileOp(); return op('unmount()', () => runner.unmount()); },
      write: (n, d) => op(`write(${n}, ${sizeOf(d)} B)`, () => runner.write(n, d)),
      read: (n) => op(`read(${n})`, () => runner.read(n)),
      cat: (n) => op(`cat(${n})`, () => runner.cat(n)),
      remove: (n) => op(`delete(${n})`, () => runner.remove(n)),
      exists: (n) => op(`exists(${n})`, () => runner.exists(n)),
      fsinfo: () => op('fsinfo()', () => runner.fsinfo()),
      stat: (n) => op(`stat(${n})`, () => runner.stat(n)),
      list: () => op('list()', () => runner.list()),
      mkdir: (n) => op(`mkdir(${n})`, () => runner.mkdir(n)),
      sectorClasses: () => op('sectorClasses()', () => runner.sectorClasses()),
      liveMap: () => op('liveMap()', () => runner.liveMap()),
      gcStep: gc,
      open: async (n, mode) => wrapHandle(await op(`open(${n})`, () => runner.open(n, mode)), n),
      openDir: async (prefix) => wrapDir(await op(`openDir(${prefix || ''})`, () => runner.openDir(prefix || '')), prefix || ''),
    };
    return {
      writeFile, readFile, deleteFile, mkdir, ls, getFiles, stat, gc, print, fs,
      prep: (v) => setPrep(!!v),
      format: async () => { await fs.format(); await fs.mount(); },
      text: (s) => new TextEncoder().encode(s),
      // I7 determinism: randomBytes is SEEDED from the entry's per-command seed
      // (rng = mulberry32(entry.seed)), NEVER crypto.
      randomBytes: (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (rng() * 256) & 0xff; return a; },
      help: () => { print(HELP_TEXT); return HELP_TEXT; },
    };
  }

  // §9: prep(true) opens the instant-execution bracket; prep(false) closes it and
  // ZEROES the displayed (drained) counters (the reseat's coordinator-side baseline
  // is never sent). playbackNs (currency) is NOT reset here.
  function setPrep(v) {
    prepActive = v;
    if (!v) { dispFileOps = 0; dispFlashNs = 0; }
  }

  // Synthetic entries (no runner): the pump credits playbackNs + counters from the
  // entry's declared cost. Execution == playback for a costless-to-run entry, so
  // this both executes AND drains atomically. `commit` is that shared step.
  function commit(index, cost, fileOps) {
    playbackNs += cost;
    dispFlashNs += cost;
    dispFileOps += fileOps;
    execFileOps += fileOps;
    entriesDrained = index;
    cursor = index + 1;
  }

  // ---- the EXECUTION pump: runs on GRANT / ENTRIES / quiescence / post-drain ----
  function pump() {
    while (cursor < entryLimit) {
      const entry = entries[cursor];
      if (!entry) return;                          // not shipped yet (ENTRIES is prefetch-only, §4)
      const p = entry.payload;

      if (entry.kind === 'command') {
        if (isSyntheticCommand(p)) {
          if (p.prep === true) { setPrep(true); commit(cursor, 0, 0); continue; }
          if (p.prep === false) { const at = cursor; playbackNs += p.costNs || 0; dispFlashNs += p.costNs || 0; setPrep(false); entriesDrained = at; cursor = at + 1; continue; }
          if (p.ticks > 1) {                        // multi-round settling (I1): nothing moves until quiesced
            if (!pendingTick || pendingTick.index !== cursor) pendingTick = { index: cursor, rem: p.ticks };
            pendingTick.rem -= 1;
            if (pendingTick.rem > 0) return;        // still in flight; this GRANT does no more
            const cost = p.costNs || 0; pendingTick = null; commit(cursor, cost, p.fileOps ?? 1); continue;
          }
          if (!prepActive && playbackNs >= playLimitNs) return;   // single-round synthetic command: gate on start
          commit(cursor, p.costNs || 0, p.fileOps ?? 1); continue;
        }
        // REAL command (SOURCE string): async, spans grants, executed at quiescence.
        if (!realCmd || realCmd.index !== cursor) {
          if (!runner) return;                     // runner not ready — park; re-pump when it lands
          if (!prepActive && backpressured()) return;   // I3: don't outrun playback without bound
          startRealCommand(cursor, entry);
          return;                                  // parked until quiescence advances cursor + re-pumps
        }
        return;                                    // command in flight — quiescence will advance cursor
      }

      // event / gc
      if (isSyntheticEvent(p)) {
        if (!prepActive && playbackNs >= playLimitNs) return;     // §2 gate (prep bypasses metering)
        const fileOps = p.fileOps ?? (entry.kind === 'gc' ? 0 : 1);
        commit(cursor, p.costNs || 0, fileOps);
        continue;
      }
      // REAL event/gc
      if (!runner) return;                         // real entry needs a runner — park
      if (!prepActive && backpressured()) return;  // I3 backpressure
      execRealEntry(cursor, entry);                // executes, queues, advances cursor
    }
  }

  function startRealCommand(index, entry) {
    realCmd = { index, done: false };
    entryFileOps = 0;
    const myGen = gen;
    const rng = mulberry32((entry.seed ?? 0) >>> 0);
    const api = buildLocalApi(rng, index, myGen);
    // Echo the RAW source to the journal (playground renders a leading '›' line as
    // console input) + a started marker.
    if (typeof entry.payload === 'string') journal.push({ entryIndex: index, kind: 'echo', text: '› ' + entry.payload });
    journal.push({ entryIndex: index, kind: 'started', text: 'command' });
    let inFlight = 0, fnDone = false, settled = false;
    const finish = () => {
      settled = true;
      journal.push({ entryIndex: index, kind: 'done', text: 'command' });
      // Terminal marker closes the entry: entriesDrained + dispFileOps land when
      // the command's whole playback has drained (§6 "executed ∧ metered drained").
      enqueueBatch(index, [], true, entryFileOps);
      realCmd = null;
      cursor = index + 1;                          // EXECUTION frontier advances at quiescence
      pump();                                       // authorize the next entry
      ack();
    };
    const check = () => setTimeout(() => {
      if (settled || myGen !== gen) return;
      if (fnDone && inFlight === 0 && realCmd && realCmd.index === index) finish();
    }, 0);
    const tracked = wrapForQuiescence(api, () => { inFlight++; }, () => { inFlight--; check(); });
    let fn;
    try { fn = compileSource(entry.payload); }
    catch (e) { journal.push({ entryIndex: index, kind: 'done', text: `command compile error: ${e?.message || e}` }); enqueueBatch(index, [], true, 0); realCmd = null; cursor = index + 1; return; }
    Promise.resolve().then(() => fn(tracked)).then(
      () => { fnDone = true; check(); },
      (err) => { journal.push({ entryIndex: index, kind: 'done', text: `command error: ${err?.message || err}` }); fnDone = true; check(); },
    );
  }
  // Wrap api + api.fs methods so each returned promise increments/decrements the
  // in-flight counter (ADR-0019 quiescence). Non-function members pass through.
  function wrapForQuiescence(api, onIssue, onSettle) {
    const wrapFn = (f) => (...args) => {
      onIssue();
      let r;
      try { r = f(...args); } catch (e) { onSettle(); throw e; }
      if (r && typeof r.then === 'function') { const pr = Promise.resolve(r); pr.then(onSettle, onSettle); return pr; }
      onSettle(); return r;
    };
    const out = {};
    for (const k of Object.keys(api)) {
      const v = api[k];
      if (typeof v === 'function') out[k] = wrapFn(v);
      else if (k === 'fs' && v && typeof v === 'object') { out.fs = {}; for (const fk of Object.keys(v)) out.fs[fk] = typeof v[fk] === 'function' ? wrapFn(v[fk]) : v[fk]; }
      else out[k] = v;
    }
    return out;
  }

  // ---- the PLAYBACK metering tick (relocated viz.js frame()) ----
  // Spend a real-time budget (dt × scale) against playLimitNs, draining the queue
  // CONTINUOUSLY intra-event with MAX_OPS_PER_FRAME carry-forward. playbackNs — the
  // §2 currency — advances only here, so it paces to real-time.
  function meterTick() {
    lastTickAt = Date.now();                        // keep dt honest even on an empty tick
    if (!runner || !pbQueue.length) return;         // synthetic/idle: nothing to pace, no ack (I10)
    const now = lastTickAt;
    let dtMs = now - meterTick._last; meterTick._last = now;
    if (!(dtMs >= 0)) dtMs = 0;
    if (dtMs > 100) dtMs = 100;                      // cap a stalled/backgrounded gap (viz parity)
    const noDelay = !isFinite(scale);
    let budget = noDelay ? Infinity : dtMs * scale;
    const ceil = playLimitNs - playbackNs;          // §2: never play past the granted watermark
    if (ceil <= 0) return;                           // ceiling reached — hold (paces Race + slow-mo)
    budget = Math.min(budget, ceil);
    const pb0 = playbackNs, ed0 = entriesDrained;
    let stepBudget = MAX_OPS_PER_FRAME;
    while (pbQueue.length && stepBudget > 0) {
      const step = pbQueue[0];
      if (!step.started) {                           // apply the op's heat/sweep at the START of its slot (viz parity)
        if (step.ev) {
          if (heat) heat.applyEvent(step.ev);
          if (step.ev.op === 'erase' && events) events.push({ kind: 'erase', sector: step.ev.sector, ms: eraseMs(step.ev.ns) });
        }
        step.curRem = step.ns; step.started = true; stepBudget--;
      }
      if (noDelay) { playbackNs += step.curRem; dispFlashNs += step.curRem; step.curRem = 0; }
      else if (budget >= step.curRem) { budget -= step.curRem; playbackNs += step.curRem; dispFlashNs += step.curRem; step.curRem = 0; }
      else { step.curRem -= budget; playbackNs += budget; dispFlashNs += budget; budget = 0; }
      if (step.curRem === 0) {
        pbQueue.shift();
        if (step.last) { entriesDrained = step.entryIndex; dispFileOps += step.fileOps; }
      } else {
        break;   // budget exhausted mid-step — carry curRem forward to the next tick (continuous intra-event)
      }
    }
    if (playbackNs !== pb0 || entriesDrained !== ed0) {
      pump();                                         // draining released I3 backpressure — authorize more
      ack();                                          // re-ack at frame cadence with the paced currency
    }
  }
  meterTick._last = Date.now();

  function startTimers() {
    stopTimers();
    telemetryTimer = setInterval(sendTelemetry, TELEMETRY_MS);
    meterTimer = setInterval(meterTick, METER_MS);
    meterTick._last = Date.now();
  }
  function stopTimers() {
    if (telemetryTimer) clearInterval(telemetryTimer); telemetryTimer = null;
    if (meterTimer) clearInterval(meterTimer); meterTimer = null;
  }

  function sendTelemetry() {
    ensureLiveness();
    send(W2C.TELEMETRY, {
      fsinfo: runner ? runner.fsinfo() : { files: 0, bytes: 0 },
      livenessCounts: { ...cachedCounts },
      exec_fileOpCount: execFileOps,
      exec_simNs: device ? device.stats.simNs : 0,
      programBytes: device ? device.stats.programBytes : 0,
      hostBytes: runner ? runner.hostBytes : 0,
      // A3: caps ride telemetry so the UI gates off ff_caps() (ADR-0011 single
      // source of truth), never a hardcoded per-fsId table. Static per epoch.
      caps: runner ? (runner.caps | 0) : 0,
    });
  }

  // Reset the EXECUTION/protocol state — shared by INIT (after the runner is
  // built) and RESET (reusing the built runner/device, à la session.js
  // blankChip()). Journal/event ids stay monotonic across the clear.
  function resetLocalState(newEpoch) {
    stopTimers();
    epoch = newEpoch;
    if (!heat) heat = createHeatPlayer(geometry); else heat.reset();
    if (!journal) journal = createRing(JOURNAL_MAX); else journal.clear();
    if (!events) events = createRing(JOURNAL_MAX); else events.clear();
    entries = []; cursor = 0; entriesDrained = -1; entryLimit = 0; playLimitNs = 0; round = -1; scale = 20000;
    playbackNs = 0; dispFileOps = 0; dispFlashNs = 0; execFileOps = 0;
    prepActive = false; pendingTick = null; realCmd = null;
    pbQueue = []; executedTapeNs = 0; captureBatch = null; entryFileOps = 0;
    mapDirty = true; cachedMap = null; cachedCounts = { live: 0, obsolete: 0, metadata: 0 }; livenessGen = 0; lastLivenessWalk = 0;
    startTimers();
  }

  // Wire the device's op stream. Device events are CAPTURED into the executing
  // entry's timed() batch (later queued for paced playback), NOT applied to heat
  // here — the glow is PACED (§7: tint execution-current, glow paced). Only
  // mapDirty (liveness tint, execution-current) is set eagerly; a 'reset' clears
  // the player. Subscribed once per device; `captureBatch`/`heat`/`events` are
  // read live so a RESET-rebuilt sink is picked up without re-subscribing.
  function subscribeDevice() {
    device.onEvent((ev) => {
      if (ev.op === 'prog' || ev.op === 'erase' || ev.op === 'reset') mapDirty = true;
      if (ev.op === 'reset') {
        pbQueue = []; executedTapeNs = 0;
        if (heat) heat.reset();
        if (events) events.push({ kind: 'reset' });
        return;
      }
      if (captureBatch) captureBatch.push(ev);
    });
  }

  async function buildFresh(myGen, newEpoch, fsIdV, geometryV) {
    fsId = fsIdV; geometry = geometryV;
    heat = null; journal = null; events = null;   // force a fresh geometry-sized heat/rings
    resetLocalState(newEpoch);
    try {
      const nextRunner = await createRunnerFn(geometry, fsId);
      if (myGen !== gen) return;                   // superseded before the async load finished
      runner = nextRunner;
      device = runner.device;
      subscribeDevice();
      pump();                                       // real entries that were parked awaiting the runner
    } catch {
      // runner-less mode (synthetic conformance suite): leave runner/device null
    }
  }

  // ---- message handlers ----
  function handleInit(m) {
    gen++; runner = null; device = null;
    buildFresh(gen, m.epoch, m.fsId, m.geometry);
  }
  function handleEntries(m) {
    for (const e of m.entries) {
      if (e.index !== entries.length) continue;    // out-of-order / duplicate — drop (I6: gaps detectable)
      entries.push(e);
    }
    pump();                                          // execute newly-covered prefetch; ENTRIES itself never acks (I5 test)
  }
  function handleGrant(m) {
    round = m.round; entryLimit = m.entryLimit; playLimitNs = m.playLimitNs; scale = m.scale;
    pump();
    ack();                                          // I10: EVERY grant acked on receipt (no-op or not)
  }
  function handlePull(m) {
    const payload = {};
    payload.heat = heat ? heat.snapshotHeat(scale) : { read: new Float32Array(0), prog: new Float32Array(0) };
    payload.shown = { pages: heat ? heat.shownSnapshot() : new Uint16Array(0), wear: device ? device.wear.slice() : new Uint32Array(0) };
    if (m.liveMap) {
      ensureLiveness();
      if (cachedMap && livenessGen > (m.liveMap.since ?? -1)) payload.liveMap = { version: livenessGen, classes: cachedMap.slice() };
    }
    payload.journal = m.journal
      ? (m.journal.newest ? journal.newest(m.journal.limit) : journal.since(m.journal.since, m.journal.limit))
      : [];
    payload.events = m.events
      ? (m.events.newest ? events.newest(m.events.limit) : events.since(m.events.since, m.events.limit))
      : [];
    payload.journalHead = journal.head;
    payload.eventHead = events.head;
    send(W2C.FRAME, payload);
  }
  function handleReset(m) {
    gen++;                                          // I5: void in-flight state; stale awaits starve
    if (runner) {
      try { runner.unmount(); } catch { /* driver-specific */ }
      device.reset();                              // flash→0xFF, stats/wear zeroed; fires 'reset' → heat/queue/event ring
    }
    resetLocalState(m.epoch);
  }

  port.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    // INIT and RESET both carry the epoch they TRANSITION TO — exempt from I5's
    // equality discard; every in-epoch message is discarded on mismatch.
    if (m.type === C2W.INIT) { handleInit(m); return; }
    if (m.type === C2W.RESET) { handleReset(m); return; }
    if (m.epoch !== epoch) return;                 // I5 epoch coherence
    if (m.type === C2W.ENTRIES) handleEntries(m);
    else if (m.type === C2W.GRANT) handleGrant(m);
    else if (m.type === C2W.PULL) handlePull(m);
  };

  return {
    /** Test/teardown hook — not part of the wire; stops the timers. */
    _stop() { stopTimers(); },
  };
}

// Back-compat alias: earlier lane-W tests import createWorkerHost.
export const createWorkerHost = installWorkerHost;

// ---- bootstrap: attach to `self` when actually running as a dedicated worker ----
/* c8 ignore start */
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof importScripts !== 'undefined') {
  installWorkerHost(self);
}
/* c8 ignore stop */
