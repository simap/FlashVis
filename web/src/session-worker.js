/*
 * session-worker.js — the worker-per-session executor (ADR-0024). Speaks
 * ONLY protocol.js's wire: INIT/ENTRIES/GRANT/PULL/RESET in, GRANT_ACK/FRAME/
 * TELEMETRY out. On INIT it builds runner ⊕ device ⊕ heat ⊕ journal/event
 * rings for one session; ENTRIES prefetch (authorize nothing); GRANT is the
 * whole control plane (entryLimit + playLimitNs + scale); PULL returns render
 * data for a focused session; RESET halts and rebuilds.
 *
 * EXECUTION MODEL (ADR-0024 §2/§5, matched to the message-level executable
 * spec in scripts/worker-conformance-test.mjs): execution is DRAIN-SYNCHRONOUS
 * with the §2 gate. On each GRANT the pump executes entries while
 *   cursor < entryLimit  AND  (prepActive OR playbackNs < playLimitNs)
 * — each executed entry's cost is added to playbackNs immediately (one-op
 * overshoot: the entry straddling playLimitNs runs in full, then the gate
 * shuts). So playbackNs is the §2 currency, chunk-granular per frame-grant;
 * cross-frame animation smoothness is the renderer's job (heat coalescing +
 * erase EventEntries), not a worker-side timed player. entriesDrained tracks
 * cursor (execution and drain coincide in this model). A COMMAND entry is
 * atomic and async: it parks the cursor until quiescence (I1) — the ack that
 * reports quiescence IS its completion.
 *
 * Transport-agnostic: installWorkerHost(port, opts) wires onto anything
 * MessagePort-shaped — a real dedicated Worker's `self`, the mock transport's
 * workerPort in tests. A bootstrap at the bottom self-attaches to `self`.
 *
 * Relocated from the (retained) main-thread web/src/session.js: the ADR-0019
 * in-flight-counter/macrotask-quiescence (runCommand), the ADR-0019 sandbox
 * (makeSandbox/compileSource), journal + prep. Heat/shown accumulation moves
 * to worker-heat.js; viz.js keeps only the render half.
 */
import { C2W, W2C, msg } from './protocol.js';
import { createRunner as defaultCreateRunner } from './runner.js';
import { CHURN_EVENT } from './churn.js';
import { createHeatPlayer } from './worker-heat.js';
import { createRing } from './worker-rings.js';

// ---- local tunables (worker-internal; NOT wire fields) ----
const TELEMETRY_MS = 250;           // W2C.TELEMETRY cadence (§4/§8: unconditional heartbeat)
const JOURNAL_MAX = 2000;           // ring bound; protocol.js's JOURNAL_MIN (400) is the wire floor
const MIN_ANIM = 110, MAX_ANIM = 9000;   // erase-sweep animated-slot bounds (viz.js parity), for EventEntry.ms

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
// command ⇒ real (see LANE-REPORT: the two coexist so the WASM-free conformance
// suite drives the same state machine production does). ----
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
  let cursor = 0;                                  // next unexecuted entry index (== count executed AND drained, this model)
  let entryLimit = 0, playLimitNs = 0, scale = 20000, round = -1;
  let playbackNs = 0;                              // §2 currency (only an epoch reset zeroes it)
  let dispFileOps = 0, dispFlashNs = 0;            // DISPLAYED drained counters (§9 zeroes these at prep(false))
  let execFileOps = 0;                             // execution total (telemetry) — NOT reset by prep
  let prepActive = false;
  let pendingTick = null;                          // synthetic multi-tick command settling: { index, rem }
  let realCmd = null;                              // real async command in flight: { index, done, startSimNs }
  let telemetryTimer = null;
  let mapDirty = true, cachedMap = null, cachedCounts = { live: 0, obsolete: 0, metadata: 0 }, livenessGen = 0;

  function send(type, payload) { port.postMessage(msg(type, { epoch, ...payload })); }
  const eraseMs = (ns) => (isFinite(scale) ? Math.max(MIN_ANIM, Math.min(MAX_ANIM, ns / scale)) : MIN_ANIM);

  // ---- liveness (ADR-0008/0015): one reachability walk per flash change ----
  function ensureLiveness() {
    if (!mapDirty || !runner) return;
    mapDirty = false;
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
      round, playbackNs, cursor, entriesDrained: cursor,
      drainedCounters: { fileOpCount: dispFileOps, flashTimeNs: dispFlashNs },
    });
  }

  // ---- real execution helpers (production path; require a runner) ----
  function bumpFileOp() { execFileOps++; dispFileOps++; }
  function runRealChurn(ev) {
    if (ev.type === CHURN_EVENT.WRITE) { bumpFileOp(); runner.write(ev.name, deterministicBytes(ev.writeSeed, ev.size)); }
    else if (ev.type === CHURN_EVENT.DELETE) { bumpFileOp(); runner.remove(ev.name); }
    // DONE / NO_SLOT: nothing to issue
  }

  // Per-session inner API a compiled command runs against (ADR-0014/0019). No
  // pacing hooks: cross-session lockstep is the coordinator's (off-thread); a
  // command is atomic and runs to quiescence, its whole cost landing at the
  // quiescence ack (I1). Ops execute for real against runner+device; heat
  // accumulates via the host's device.onEvent subscription.
  function buildLocalApi(rng, entryIndex, myGen) {
    const guard = () => { if (myGen !== gen) throw new Error('epoch superseded'); if (!runner) throw new Error('no runner'); };
    function op(label, work) {
      // A microtask hop keeps every op async (a command's `await writeFile()`),
      // so quiescence's macrotask re-check has real boundaries to observe (I1).
      return Promise.resolve().then(() => {
        guard();
        let res;
        try { res = work(); }
        catch (e) { journal.push({ entryIndex, kind: 'op', text: `${label} → ${e.message || e}` }); throw e; }
        journal.push({ entryIndex, kind: 'op', text: label });
        return res;
      });
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
    const ls = (prefix) => { bumpFileOp(); return op(`ls(${prefix || ''})`, () => runner.list().filter((f) => f.name.startsWith(prefix || ''))); };
    const stat = (name) => { bumpFileOp(); return op(`stat(${name})`, () => runner.stat(name)); };
    const gc = (n = 1) => { const steps = Math.max(1, n | 0); return op('gc()', () => { let r; for (let i = 0; i < steps; i++) r = runner.gcStep(); return r; }); };
    const print = (...args) => { const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '); for (const line of text.split('\n')) journal.push({ entryIndex, kind: 'op', text: line }); };
    const fs = {
      format: () => { bumpFileOp(); return op('format()', () => runner.format()); },
      mount: () => { bumpFileOp(); return op('mount()', () => runner.mount()); },
      unmount: () => { bumpFileOp(); return op('unmount()', () => runner.unmount()); },
      write: (n, d) => op(`write(${n})`, () => runner.write(n, d)),
      read: (n) => op(`read(${n})`, () => runner.read(n)),
      remove: (n) => op(`delete(${n})`, () => runner.remove(n)),
      exists: (n) => op(`exists(${n})`, () => runner.exists(n)),
      fsinfo: () => op('fsinfo()', () => runner.fsinfo()),
      gcStep: gc,
    };
    // Console conveniences layered over the per-session api (ADR-0019 buildConsoleApi
    // parity): prep drives the §9 bracket; format/text/randomBytes are UX sugar.
    return {
      writeFile, readFile, deleteFile, mkdir, ls, getFiles: ls, stat, gc, print, fs,
      prep: (v) => setPrep(!!v),
      format: async () => { await fs.format(); await fs.mount(); },
      text: (s) => new TextEncoder().encode(s),
      randomBytes: (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (rng() * 256) & 0xff; return a; },
    };
  }

  // §9: prep(true) opens the instant-execution bracket; prep(false) closes it
  // and ZEROES the displayed (drained) counters (the reseat's coordinator-side
  // baseline is never sent). playbackNs (currency) is NOT reset here.
  function setPrep(v) {
    prepActive = v;
    if (!v) { dispFileOps = 0; dispFlashNs = 0; }
  }

  // Synthetic entries (no runner): the pump credits playbackNs + counters from
  // the entry's declared cost. `commit` is the shared "executed AND drained" step.
  function commit(index, cost, fileOps) {
    playbackNs += cost;
    dispFlashNs += cost;
    dispFileOps += fileOps;
    execFileOps += fileOps;
    cursor = index + 1;
  }

  // ---- the execution pump: runs on GRANT and on real-command quiescence ----
  function pump() {
    while (cursor < entryLimit) {
      const entry = entries[cursor];
      if (!entry) return;                          // not shipped yet (ENTRIES is prefetch-only, §4)
      const p = entry.payload;

      if (entry.kind === 'command') {
        if (isSyntheticCommand(p)) {
          if (p.prep === true) { setPrep(true); commit(cursor, 0, 0); continue; }
          if (p.prep === false) { const at = cursor; playbackNs += p.costNs || 0; dispFlashNs += p.costNs || 0; setPrep(false); cursor = at + 1; continue; }
          if (p.ticks > 1) {                        // multi-round settling (I1): nothing moves until quiesced
            if (!pendingTick || pendingTick.index !== cursor) pendingTick = { index: cursor, rem: p.ticks };
            pendingTick.rem -= 1;
            if (pendingTick.rem > 0) return;        // still in flight; this GRANT does no more
            const cost = p.costNs || 0; pendingTick = null; commit(cursor, cost, p.fileOps ?? 1); continue;
          }
          if (!prepActive && playbackNs >= playLimitNs) return;   // single-round synthetic command: gate on start
          commit(cursor, p.costNs || 0, p.fileOps ?? 1); continue;
        }
        // REAL command (SOURCE string): async, spans grants, completes at quiescence
        if (!realCmd || realCmd.index !== cursor) {
          if (!prepActive && playbackNs >= playLimitNs) return;   // gate on START only (atomic)
          if (!runner) return;                     // runner not ready — park; re-pump when it lands
          startRealCommand(cursor, entry);
          return;                                  // parked until quiescence re-pumps
        }
        if (!realCmd.done) return;                 // still in flight
        const at = realCmd.index;
        const cost = device.stats.simNs - realCmd.startSimNs;
        realCmd = null;
        journal.push({ entryIndex: at, kind: 'done', text: 'command' });
        // fileOps were bumped live during execution (bumpFileOp); credit cost + advance.
        playbackNs += cost; dispFlashNs += cost; cursor = at + 1;
        continue;
      }

      // event / gc — §2 gate (prep bypasses metering)
      if (!prepActive && playbackNs >= playLimitNs) return;
      if (isSyntheticEvent(p)) {
        const fileOps = p.fileOps ?? (entry.kind === 'gc' ? 0 : 1);
        commit(cursor, p.costNs || 0, fileOps);
      } else {
        if (!runner) return;                       // real entry needs a runner — park
        const beforeSim = device.stats.simNs;
        if (entry.kind === 'event') runRealChurn(p);
        else runner.gcStep();                      // gc: background maintenance, not a file op
        const cost = device.stats.simNs - beforeSim;
        // bumpFileOp already advanced disp/exec counters for churn; credit cost + advance.
        playbackNs += cost; dispFlashNs += cost; cursor += 1;
      }
    }
  }

  function startRealCommand(index, entry) {
    realCmd = { index, done: false, startSimNs: device.stats.simNs };
    const myGen = gen;
    const rng = mulberry32((entry.seed ?? 0) >>> 0);
    const api = buildLocalApi(rng, index, myGen);
    journal.push({ entryIndex: index, kind: 'started', text: 'command' });
    let inFlight = 0, fnDone = false, settled = false;
    const check = () => setTimeout(() => {
      if (settled || myGen !== gen) return;
      if (fnDone && inFlight === 0) { settled = true; if (realCmd && realCmd.index === index) { realCmd.done = true; pump(); ack(); } }
    }, 0);
    // Wrap every api method so the in-flight counter tracks issued-but-unsettled
    // ops (quiescence = fn returned AND no op pending, ADR-0019). A thrown op is
    // logged, still counted settled — a runaway command can't wedge the pump.
    const tracked = wrapForQuiescence(api, () => { inFlight++; }, () => { inFlight--; check(); });
    let fn;
    try { fn = compileSource(entry.payload); }
    catch (e) { journal.push({ entryIndex: index, kind: 'done', text: `command compile error: ${e?.message || e}` }); realCmd.done = true; return; }
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

  // ---- player: no timed drain (drain is synchronous on GRANT). Only the
  // telemetry heartbeat runs on a timer (§4/§8). ----
  function startTimers() {
    stopTimers();
    telemetryTimer = setInterval(sendTelemetry, TELEMETRY_MS);
  }
  function stopTimers() { if (telemetryTimer) clearInterval(telemetryTimer); telemetryTimer = null; }

  function sendTelemetry() {
    ensureLiveness();
    send(W2C.TELEMETRY, {
      fsinfo: runner ? runner.fsinfo() : { files: 0, bytes: 0 },
      livenessCounts: { ...cachedCounts },
      exec_fileOpCount: execFileOps,
      exec_simNs: device ? device.stats.simNs : 0,
      programBytes: device ? device.stats.programBytes : 0,
      hostBytes: runner ? runner.hostBytes : 0,
    });
  }

  // Reset the EXECUTION/protocol state — shared by INIT (after the runner is
  // built) and RESET (reusing the built runner/device, à la session.js
  // blankChip(): device.reset(), no WASM reload). Journal/event ids stay
  // monotonic across the clear (never reused).
  function resetLocalState(newEpoch) {
    stopTimers();
    epoch = newEpoch;
    if (!heat) heat = createHeatPlayer(geometry); else heat.reset();
    if (!journal) journal = createRing(JOURNAL_MAX); else journal.clear();
    if (!events) events = createRing(JOURNAL_MAX); else events.clear();
    entries = []; cursor = 0; entryLimit = 0; playLimitNs = 0; round = -1; scale = 20000;
    playbackNs = 0; dispFileOps = 0; dispFlashNs = 0; execFileOps = 0;
    prepActive = false; pendingTick = null; realCmd = null;
    mapDirty = true; cachedMap = null; cachedCounts = { live: 0, obsolete: 0, metadata: 0 }; livenessGen = 0;
    startTimers();
  }

  // Wire the device's op stream into heat (eager accumulation) + the event ring
  // (one-shot erase/reset sweeps the renderer animates). Subscribed once per
  // device; the `heat`/`events` closure vars are read live so a RESET-rebuilt
  // heat/ring is picked up without re-subscribing.
  function subscribeDevice() {
    device.onEvent((ev) => {
      if (ev.op === 'prog' || ev.op === 'erase' || ev.op === 'reset') mapDirty = true;
      if (heat) heat.applyEvent(ev);
      if (!events) return;
      if (ev.op === 'erase') events.push({ kind: 'erase', sector: ev.sector, ms: eraseMs(ev.ns) });
      else if (ev.op === 'reset') events.push({ kind: 'reset' });
    });
  }

  async function buildFresh(myGen, newEpoch, fsIdV, geometryV) {
    fsId = fsIdV; geometry = geometryV;
    // Establish the epoch + state machine SYNCHRONOUSLY (so a same-turn GRANT is
    // accepted, and the WASM-free conformance suite never needs a runner). The
    // runner builds in the background; a build failure (e.g. no dist module for
    // a synthetic-only test fsId) is non-fatal — real entries simply park until
    // a runner exists (they never arrive in the synthetic suite).
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
      device.reset();                              // flash→0xFF, stats/wear zeroed; fires 'reset' → heat/event ring
    }
    resetLocalState(m.epoch);
  }

  port.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    // INIT and RESET both carry the epoch they TRANSITION TO (ResetMsg.epoch is
    // "the NEW epoch") — exempt from I5's equality discard; every in-epoch
    // message is discarded on mismatch.
    if (m.type === C2W.INIT) { handleInit(m); return; }
    if (m.type === C2W.RESET) { handleReset(m); return; }
    if (m.epoch !== epoch) return;                 // I5 epoch coherence
    if (m.type === C2W.ENTRIES) handleEntries(m);
    else if (m.type === C2W.GRANT) handleGrant(m);
    else if (m.type === C2W.PULL) handlePull(m);
  };

  return {
    /** Test/teardown hook — not part of the wire; stops the telemetry timer. */
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
