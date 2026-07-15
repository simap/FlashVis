/*
 * session-worker.js — the worker-per-session executor (ADR-0024). Speaks
 * ONLY protocol.js's wire: INIT/ENTRIES/GRANT/PULL/RESET in, GRANT_ACK/FRAME/
 * TELEMETRY out. On INIT it builds runner ⊕ device ⊕ player(heat) ⊕
 * journal/event rings for one session; ENTRIES prefetch (authorize nothing);
 * GRANT is the whole control plane (entryLimit + playLimitNs + scale); PULL
 * returns render data for a focused session; RESET halts and rebuilds.
 *
 * This module is transport-agnostic: `createWorkerHost(port, opts)` wires
 * onto anything shaped like a MessagePort (`.postMessage`/`.onmessage`) — a
 * real dedicated-worker's `self`, or scripts/mock-worker-transport.mjs's
 * `workerPort` in tests. The bootstrap at the bottom attaches to `self` when
 * this module is loaded as an actual Worker.
 *
 * Relocated from web/src/session.js (main-thread executor, ADR-0015): the
 * ADR-0019 in-flight counter + macrotask-boundary quiescence (now
 * `runCommand`), and journal/prep plumbing. Heat/shown accumulation moves to
 * worker-heat.js (viz.js keeps ONLY the render/DOM half — another lane's
 * concern, not edited here). Race/Pace pace hooks (the old `{before,after}`
 * pair session.js accepted from the coordinator) are gone: this module
 * implements ONLY the local §2 gate + I3's op-level barrier; cross-session
 * lockstep (Pace's join / Race's shared ceiling) is the coordinator's,
 * entirely off this thread (I9).
 */
import { C2W, W2C, msg } from './protocol.js';
import { createRunner as defaultCreateRunner } from './runner.js';
import { CHURN_EVENT } from './churn.js';
import { createHeatPlayer } from './worker-heat.js';
import { createRing } from './worker-rings.js';

// ---- local tunables (worker-internal; NOT wire fields — like protocol.js's
// deferred ENTRIES window-size knob, these are sizeable-by-measurement later) ----
const TICK_MS = 16;                 // player-drain / capacity-recheck cadence (~frame rate)
const TELEMETRY_MS = 250;           // W2C.TELEMETRY cadence (ADR-0024 §4/§8: unconditional heartbeat)
const JOURNAL_MAX = 2000;           // ring bound; protocol.js's JOURNAL_MIN (400) is the wire floor
const BACKLOG_CAP_OPS = 3000;       // I3 `pending < BACKLOG_CAP` — was lockstep.js's BACKLOG_CAP
const TAPE_CAP_NS = 250 * 1e6;      // I3 `executedTapeNs - playbackNs < TAPE_CAP` (sim-ns)

// ---- deterministic content generation (ADR-0015/0019) — copied verbatim
// from session.js; pure functions, no DOM, so they relocate unchanged. ----
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
const fmtTime = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };

/**
 * @param {{postMessage:Function, onmessage:*}} port  the worker-side port (self, or a mock)
 * @param {Object} [opts]
 * @param {Function} [opts.createRunner]  injectable runner factory — defaults to
 *   runner.js's real WASM loader; tests inject a stub (dist/ is gitignored, not
 *   present in every worktree — see scripts/*-worker-test.mjs).
 */
export function createWorkerHost(port, opts = {}) {
  const createRunnerFn = opts.createRunner || defaultCreateRunner;

  let epoch = -1, gen = 0;                         // I5: gen bumps on every (re)build; stale async work checks it and starves
  let runner = null, device = null, heat = null, journal = null, events = null;
  let fsId = null, geometry = null;
  let entries = [];                                // entries[i] = {index, kind, payload, seed}, consecutive
  let cursor = 0;                                   // next unexecuted entry index ("executed" count, per grantAck.cursor)
  let entryLimit = 0, playLimitNs = 0, scale = 20000, round = -1;
  let entryBoundaryNs = [], entryBoundaryFileOps = [];   // per-entry cumulative markers, for entriesDrained/drainedCounters
  let drainedPtr = 0;                               // next entry index to test for "tape-drained"
  let fileOpCount = 0;                              // ADR-0023 file-granular count
  let pumping = false;
  let capacityWaiters = [], playbackWaiters = [];
  let tickTimer = null, telemetryTimer = null, lastTickAt = 0;
  let mapDirty = true, cachedMap = null, cachedCounts = { live: 0, obsolete: 0, metadata: 0 }, livenessGen = 0;
  let lastAcked = { playbackNs: -1, cursor: -1, entriesDrained: -2, round: -2 };

  function send(type, payload) { port.postMessage(msg(type, { epoch, ...payload })); }

  // ---- liveness (ADR-0008/0015): one reachability walk per actual flash
  // change, shared by TELEMETRY's livenessCounts and a `liveMap` PULL. ----
  function ensureLiveness() {
    if (!mapDirty) return;
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

  // ---- §2 local gate (I3) — capacity: don't execute the next op/entry while
  // the executed-but-undrained tape is too deep, or the drain backlog is too
  // long. Both caps are local tunables (BACKLOG_CAP_OPS/TAPE_CAP_NS above). ----
  function hasCapacity() {
    return (device.stats.simNs - heat.playbackNs) < TAPE_CAP_NS && heat.pendingOps() < BACKLOG_CAP_OPS;
  }
  function waitForCapacity() {
    if (hasCapacity()) return Promise.resolve();
    return new Promise((resolve) => capacityWaiters.push(resolve));
  }
  // ---- I3's "awaited op covered by playback" barrier (ADR-0009, relocated):
  // a command op's promise doesn't resolve to its continuation until the
  // player has actually PLAYED that op (playbackNs reached its boundary). ----
  function waitPlaybackAtLeast(targetNs) {
    if (heat.playbackNs >= targetNs) return Promise.resolve();
    return new Promise((resolve) => playbackWaiters.push({ targetNs, resolve }));
  }
  function releaseWaiters() {
    if (capacityWaiters.length && hasCapacity()) {
      const w = capacityWaiters; capacityWaiters = [];
      for (const r of w) r();
    }
    if (playbackWaiters.length) {
      playbackWaiters = playbackWaiters.filter((w) => {
        if (heat.playbackNs >= w.targetNs) { w.resolve(); return false; }
        return true;
      });
    }
  }

  function advanceDrainedPtr() {
    while (drainedPtr < cursor && entryBoundaryNs[drainedPtr] <= heat.playbackNs) drainedPtr++;
  }
  // "highest entry index executed AND tape-drained"; -1 when nothing has drained yet.
  function entriesDrainedIdx() { return drainedPtr - 1; }
  function drainedCounters() {
    const i = entriesDrainedIdx();
    return { fileOpCount: i >= 0 ? entryBoundaryFileOps[i] : 0, flashTimeNs: i >= 0 ? entryBoundaryNs[i] : 0 };
  }

  function ack(force) {
    const ed = entriesDrainedIdx();
    const same = !force && round === lastAcked.round && heat.playbackNs === lastAcked.playbackNs
      && cursor === lastAcked.cursor && ed === lastAcked.entriesDrained;
    if (same) return;
    lastAcked = { playbackNs: heat.playbackNs, cursor, entriesDrained: ed, round };
    send(W2C.GRANT_ACK, { round, playbackNs: heat.playbackNs, cursor, entriesDrained: ed, drainedCounters: drainedCounters() });
  }

  // ---- churn / gc (synchronous, single-op entries — ADR-0015/0023) ----
  function bumpFileOp() { fileOpCount++; }
  function timed(fn) { return fn(); }
  function runChurn(ev) {
    if (ev.type === CHURN_EVENT.WRITE) { bumpFileOp(); return timed(() => runner.write(ev.name, deterministicBytes(ev.writeSeed, ev.size))); }
    if (ev.type === CHURN_EVENT.DELETE) { bumpFileOp(); return timed(() => runner.remove(ev.name)); }
    return undefined; // DONE / NO_SLOT
  }

  // ---- the LOCAL inner API a compiled command runs against (ADR-0014/0019,
  // relocated). Every call funnels through runOp(): capacity gate (before) ->
  // execute for real (instant; device time jumps) -> playback barrier (after)
  // -> resolve. No viz/DOM here — device events already flow into `heat`
  // via worker-heat.js's own device.onEvent subscription. ----
  function buildLocalApi(rng, entryIndex, myGen, onIssue, onSettle) {
    function runOp(label, work) {
      onIssue();
      const p = (async () => {
        await waitForCapacity();
        if (myGen !== gen) return undefined;               // I5: reset landed mid-op — starve, touch nothing
        let res, err = null;
        try { res = work(); } catch (e) { err = e; }
        const boundaryNs = device.stats.simNs;
        journal.push({ entryIndex, kind: 'op', text: err ? `${label} → ${err.message || err}` : label, costNs: null });
        await waitPlaybackAtLeast(boundaryNs);
        if (myGen !== gen) return undefined;
        if (err) throw err;
        return res;
      })();
      // Settle bookkeeping is a SEPARATE promise chain from `p` (mirrors
      // session.js): if `work` threw, that rejection still rides `p` to the
      // caller, but nothing awaits the .finally() chain, so neutralize its
      // own rejection branch or it leaks an unhandledRejection.
      p.finally(onSettle).catch(() => {});
      return p;
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

    function writeFile(name, size) {
      const n = name ?? randomName(); const sz = size ?? randomSize();
      bumpFileOp();
      return runOp(`write(${n}, ${sz} B)`, () => { runner.write(n, deterministicBytes(hashNameSize(n, sz), sz)); return { name: n, size: sz }; });
    }
    function readFile(arg) {
      const n = resolveName(arg); bumpFileOp();
      return runOp(`read(${n})`, () => ({ name: n, size: runner.read(n).length }));
    }
    function deleteFile(arg) {
      const n = resolveName(arg); bumpFileOp();
      return runOp(`delete(${n})`, () => { const st = runner.stat(n); runner.remove(n); return { name: n, size: st ? st.size : 0 }; });
    }
    async function mkdir(path) {
      bumpFileOp();
      let cur = '';
      for (const part of String(path).split('/').filter(Boolean)) {
        cur += (cur ? '/' : '') + part;
        await runOp(`mkdir(${cur})`, () => runner.mkdir(cur));
      }
      return 'ok';
    }
    // NOTE (scope reduction vs session.js): ls/getFiles use runner.list() as one
    // paced op rather than the ADR-0014 streaming per-entry dir scan (open/read.../
    // close, each its own paced op) — the "simple command" bound doesn't need the
    // tier-2 streaming surface. Flag if the coordinator/UI actually needs the
    // per-entry stream animated.
    const ls = (prefix) => { bumpFileOp(); return runOp(`ls(${prefix || ''})`, () => runner.list().filter((f) => f.name.startsWith(prefix || ''))); };
    const getFiles = ls;
    const stat = (name) => { bumpFileOp(); return runOp(`stat(${name})`, () => runner.stat(name)); };
    function gc(n = 1) {
      const steps = Math.max(1, n | 0);
      return runOp('gc()', () => { let r; for (let i = 0; i < steps; i++) r = runner.gcStep(); return r; });
    }
    const print = (...args) => {
      const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
      for (const line of text.split('\n')) journal.push({ entryIndex, kind: 'op', text: line });
    };
    const fs = {
      format: () => { bumpFileOp(); return runOp('format()', () => runner.format()); },
      mount: () => { bumpFileOp(); return runOp('mount()', () => runner.mount()); },
      unmount: () => { bumpFileOp(); return runOp('unmount()', () => runner.unmount()); },
      write: (n, d) => runOp(`write(${n})`, () => runner.write(n, d)),
      read: (n) => runOp(`read(${n})`, () => runner.read(n)),
      remove: (n) => runOp(`delete(${n})`, () => runner.remove(n)),
      exists: (n) => runOp(`exists(${n})`, () => runner.exists(n)),
      fsinfo: () => runOp('fsinfo()', () => runner.fsinfo()),
    };
    return { writeFile, readFile, deleteFile, mkdir, ls, getFiles, stat, gc, print, fs };
  }

  // SOURCE ships as text (ADR-0024 §4: "commands ship as SOURCE"); compiled
  // worker-side. Expected shape: an async-function EXPRESSION, e.g.
  // "async (api) => { await api.writeFile(); }".
  function compileCommand(source) {
    // eslint-disable-next-line no-eval
    return (0, eval)(`(${source})`);
  }

  /** Run one atomic COMMAND to quiescence (ADR-0019 relocated) — resolves once
   *  fn has settled AND no op it issued is still in flight, re-checked at a
   *  macrotask boundary. Never rejects. The quiescence resolution IS the
   *  command's completion ack (I1). */
  function runCommand(source, seed, entryIndex, myGen) {
    return new Promise((resolveQuiescent) => {
      let inFlight = 0, fnDone = false, settled = false;
      const rng = mulberry32(seed >>> 0);
      const check = () => {
        setTimeout(() => {
          if (!settled && fnDone && inFlight === 0) { settled = true; resolveQuiescent(); }
        }, 0);
      };
      journal.push({ entryIndex, kind: 'started', text: 'command' });
      events.push({ entryIndex, kind: 'started', text: 'command' });
      let fn;
      try { fn = compileCommand(source); }
      catch (e) {
        journal.push({ entryIndex, kind: 'done', text: `command compile error: ${e?.message || e}` });
        events.push({ entryIndex, kind: 'done', text: 'command' });
        resolveQuiescent();
        return;
      }
      const api = buildLocalApi(rng, entryIndex, myGen, () => { inFlight++; }, () => { inFlight--; check(); });
      Promise.resolve().then(() => fn(api)).then(
        () => { fnDone = true; check(); },
        (err) => { journal.push({ entryIndex, kind: 'done', text: `command error: ${err?.message || err}` }); fnDone = true; check(); },
      );
    });
  }

  async function executeEntry(entry, index, myGen) {
    if (entry.kind === 'event') {
      runChurn(entry.payload);
      journal.push({ entryIndex: index, kind: 'op', text: 'churn' });
    } else if (entry.kind === 'gc') {
      timed(() => runner.gcStep());
      journal.push({ entryIndex: index, kind: 'gc', text: 'gc()' });
    } else if (entry.kind === 'command') {
      await runCommand(entry.payload, entry.seed, index, myGen);
      if (myGen !== gen) return;
      journal.push({ entryIndex: index, kind: 'done', text: 'command' });
      events.push({ entryIndex: index, kind: 'done', text: 'command' });
    }
    if (myGen !== gen) return;
    entryBoundaryNs[index] = device.stats.simNs;
    entryBoundaryFileOps[index] = fileOpCount;
  }

  // ---- pump: the entry-execution loop (I3: index < entryLimit ∧ capacity) ----
  async function pump() {
    if (pumping) return;
    pumping = true;
    const myGen = gen;
    try {
      while (myGen === gen && cursor < entries.length && cursor < entryLimit) {
        if (!hasCapacity()) { await waitForCapacity(); continue; }
        if (myGen !== gen) break;
        const entry = entries[cursor];
        await executeEntry(entry, cursor, myGen);
        if (myGen !== gen) break;
        cursor++;
        ack();
      }
    } finally {
      if (myGen === gen) pumping = false;
    }
  }

  // ---- player tick: real-time-paced drain (§6) + waiter release + re-ack ----
  function tick() {
    if (!heat) return;
    const now = Date.now();
    const dt = lastTickAt ? now - lastTickAt : 0;
    lastTickAt = now;
    if (dt > 0) heat.drain(dt, scale, playLimitNs);
    advanceDrainedPtr();
    releaseWaiters();
    ack();
  }

  function startTimers() {
    stopTimers();
    lastTickAt = 0;
    tickTimer = setInterval(tick, TICK_MS);
    telemetryTimer = setInterval(sendTelemetry, TELEMETRY_MS);
  }
  function stopTimers() {
    if (tickTimer) clearInterval(tickTimer);
    if (telemetryTimer) clearInterval(telemetryTimer);
    tickTimer = null; telemetryTimer = null;
  }

  function sendTelemetry() {
    if (!runner) return;
    ensureLiveness();
    send(W2C.TELEMETRY, {
      fsinfo: runner.fsinfo(),
      livenessCounts: { ...cachedCounts },
      exec_fileOpCount: fileOpCount,
      exec_simNs: device.stats.simNs,
    });
  }

  // Reset the EXECUTION/protocol state (entries/cursor/heat/rings/waiters) —
  // shared by both a fresh INIT (after the runner/device are built) and a
  // RESET (reusing the already-built runner/device, mirroring session.js's
  // blankChip(): no WASM reload, just wipe flash + local bookkeeping).
  function resetLocalState(newEpoch) {
    stopTimers();
    epoch = newEpoch;
    // Reuse the existing heat player / rings across a RESET (device.reset()
    // already cleared the heat/shown state via its own 'reset' event) — a
    // fresh createHeatPlayer would leave the OLD one still subscribed to
    // device.onEvent forever (device.js has no unsubscribe call site here).
    // Journal/event ids stay monotonic across the clear (never reused), same
    // as session.js's clearJournal not resetting journalSeq.
    if (!heat) heat = createHeatPlayer(device, geometry); else heat.reset();
    if (!journal) journal = createRing(JOURNAL_MAX); else journal.clear();
    if (!events) events = createRing(JOURNAL_MAX); else events.clear();
    entries = []; cursor = 0; entryLimit = 0; playLimitNs = 0; round = -1; scale = 20000;
    entryBoundaryNs = []; entryBoundaryFileOps = []; drainedPtr = 0; fileOpCount = 0;
    capacityWaiters = []; playbackWaiters = []; pumping = false;
    mapDirty = true; cachedMap = null; cachedCounts = { live: 0, obsolete: 0, metadata: 0 }; livenessGen = 0;
    lastAcked = { playbackNs: -1, cursor: -1, entriesDrained: -2, round: -2 };
    startTimers();
  }

  async function buildFresh(myGen, newEpoch, fsIdV, geometryV) {
    fsId = fsIdV; geometry = geometryV;
    const nextRunner = await createRunnerFn(geometry, fsId);
    if (myGen !== gen) return;                    // superseded before the async load finished
    runner = nextRunner;
    device = runner.device;
    device.onEvent((ev) => { if (ev.op === 'prog' || ev.op === 'erase' || ev.op === 'reset') mapDirty = true; });
    resetLocalState(newEpoch);
  }

  // ---- message handlers ----
  function handleInit(m) {
    gen++;
    const myGen = gen;
    buildFresh(myGen, m.epoch, m.fsId, m.geometry);
  }
  function handleEntries(m) {
    for (const e of m.entries) {
      if (e.index !== entries.length) continue;   // out-of-order / duplicate — drop (index gaps are detectable, I6)
      entries.push(e);
    }
    pump();
  }
  function handleGrant(m) {
    round = m.round; entryLimit = m.entryLimit; playLimitNs = m.playLimitNs; scale = m.scale;
    ack(true);          // I10: EVERY grant acked on receipt, even a no-op (idle = parked position)
    pump();
  }
  function handlePull(m) {
    const payload = {};
    if (m.heat) { const h = heat.snapshotHeat(scale); payload.heat = { readHeat: Array.from(h.readHeat), progHeat: Array.from(h.progHeat) }; }
    if (m.wear) payload.shown = { shown: Array.from(heat.shownSnapshot()), wear: Array.from(device.wear) };
    if (m.liveMap) {
      ensureLiveness();
      if (livenessGen > m.liveMap.since) payload.liveMap = { map: cachedMap ? Array.from(cachedMap) : null, version: livenessGen };
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
    gen++;                          // I5: void in-flight state; stale awaits starve
    if (!runner) return;            // reset before any init landed — nothing to do
    try { runner.unmount(); } catch { /* already unmounted / driver-specific */ }
    device.reset();                 // flash -> 0xFF, stats/wear zeroed (also clears heat via its own onEvent('reset'))
    resetLocalState(m.epoch);
  }

  port.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    // INIT and RESET both carry the epoch they are TRANSITIONING TO (protocol.js:
    // ResetMsg.epoch is documented "the NEW epoch (epoch')"), so neither can pass
    // an equality check against the CURRENT epoch — they are exempt from I5,
    // which governs every other (in-epoch) message.
    if (m.type === C2W.INIT) { handleInit(m); return; }
    if (m.type === C2W.RESET) { handleReset(m); return; }
    if (m.epoch !== epoch) return;                 // I5: epoch coherence — discard stale-epoch messages
    if (m.type === C2W.ENTRIES) handleEntries(m);
    else if (m.type === C2W.GRANT) handleGrant(m);
    else if (m.type === C2W.PULL) handlePull(m);
  };

  return {
    /** Test/teardown hook — not part of the wire; stops local timers. */
    _stop() { stopTimers(); },
  };
}

// ---- bootstrap: attach to `self` when actually running as a dedicated worker ----
/* c8 ignore start */
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof importScripts !== 'undefined') {
  createWorkerHost(self);
}
/* c8 ignore stop */
