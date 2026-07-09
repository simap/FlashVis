/*
 * Session: one filesystem instance, fully self-contained — its own runner,
 * viz, die DOM, op-log capture (timed()), and liveness tracking (ADR-0015).
 *
 * A session is a pure EXECUTOR: it runs whatever op it's handed (a churn
 * event, a broadcast poke, a GC step, a console call) and paces/logs/animates
 * it, but never decides what to run next. The churn *generator*, the
 * gc-vs-churn ratio, and the one canonical broadcast sequence (ADR-0017) all
 * live one layer up, in the coordinator, so it can drive N sessions off one
 * shared timeline without touching session internals — see runChurnEvent() /
 * runPoke() / runGcStep() below, the seam that coordinator calls through.
 *
 * Each session owns its own tape too: a per-FS journal buffer (ADR-0018), since
 * every filesystem has its own timing, results, and pending state.
 */
import { createRunner } from './runner.js';
import { createViz } from './viz.js';
import { CHURN_EVENT } from './churn.js';

const enc = new TextEncoder();
const sizeOf = (d) => (typeof d === 'string' ? enc.encode(d).length : d.length);
const fmtTime = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };

// Tiny seeded PRNG (mulberry32) — fills a buffer deterministically from a
// single uint32 seed. NOT crypto.getRandomValues: the whole point is that the
// same (writeSeed, size) produces byte-identical content on every driver, so
// a churn event written to two different filesystems is byte-comparable (a
// later cross-FS feature depends on this).
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

/**
 * @param {string} fsId               registry key — picks dist/<fsId>.mjs (ADR-0011)
 * @param {Object} opts
 * @param {Object} opts.geometry      { sectorSize, sectorCount, pageSize, granule }
 * @param {Object} opts.container     DOM node this session's own .die gets appended into
 * @param {(msg:string, cls?:string) => void} [opts.onLog]  op-log / streaming-ls sink
 * @param {string} [opts.name]        display name (defaults to fsId)
 */
export async function createSession(fsId, { geometry, container, onLog, name }) {
  const runner = await createRunner(geometry, fsId);
  const device = runner.device;
  const viz = createViz(device);

  const dieEl = document.createElement('div');
  dieEl.className = 'die';
  container.appendChild(dieEl);
  viz.mountDie(dieEl);

  // Own timed() capture + liveness dirty-flag: each session's device.onEvent
  // feeds only its own batch/mapDirty, so switching the active FS mid-flight
  // can never cross-contaminate another session's op log or live map.
  let currentBatch = null;
  let mapDirty = true;
  device.onEvent((ev) => {
    if (currentBatch && ev.op !== 'reset') currentBatch.push(ev);
    if (ev.op === 'prog' || ev.op === 'erase' || ev.op === 'reset') mapDirty = true;
  });

  // Liveness cache (ADR-0015): ONE reachability walk (runner.liveMap(), a
  // mount-like re-scan) per actual flash change, shared by refreshLiveness (die
  // tint + HUD, displayed session only) and livenessCounts (a cheap page-count
  // readout any session can poll — e.g. a lockstep compare-strip). ensureLiveness
  // walks only when this session's own mapDirty is set, so neither caller can
  // trigger a redundant walk; livenessGen bumps on each fresh walk so
  // refreshLiveness knows when there's a new map to paint.
  let cachedMap = null;                                  // last liveMap() (null ⇒ FS lacks live-map)
  let cachedCounts = { live: 0, obsolete: 0, metadata: 0 };
  let livenessGen = 0;
  let appliedGen = -1;                                   // the livenessGen refreshLiveness last painted
  function ensureLiveness() {
    if (!mapDirty) return;
    mapDirty = false;
    livenessGen++;
    cachedMap = runner.liveMap();
    if (!cachedMap) { cachedCounts = { live: 0, obsolete: 0, metadata: 0 }; return; }
    let live = 0, obsolete = 0, metadata = 0;
    for (let p = 0; p < cachedMap.length; p++) {
      const c = cachedMap[p];
      if (c === 3) live++; else if (c === 2) obsolete++; else if (c === 1) metadata++;
    }
    cachedCounts = { live, obsolete, metadata };
  }

  // Per-session journal / tape (ADR-0017/0018): this session owns its own op-log
  // scrollback — each FS has its own timing, results, and pending state, so the
  // tape is per-FS and follows focus. Entries carry a lifecycle `state` the
  // coordinator advances ('queued' → 'live' → 'done'); a result line emitted by
  // an already-executed op defaults to 'done'. The legacy onLog sink still fires
  // for every line, so existing callers (the shared termout) are unaffected —
  // the journal is purely additive.
  const journal = [];
  const journalSubs = [];
  let journalSeq = 0;
  const notifyJournal = (change) => { for (const cb of journalSubs) cb(change); };
  /** Append one line to the journal and the legacy onLog sink. Returns the entry
   *  so its `state` can later be advanced in place via setJournalState. */
  function appendJournal(text, cls = 'out', state = 'done') {
    const entry = { id: journalSeq++, text, cls, state };
    journal.push(entry);
    onLog?.(text, cls);
    notifyJournal({ type: 'append', entry, journal });
    return entry;
  }
  /** Advance an existing entry's lifecycle state and notify subscribers. No-op
   *  when the state is unchanged. Returns the entry. */
  function setJournalState(entry, state) {
    if (!entry || entry.state === state) return entry;
    entry.state = state;
    notifyJournal({ type: 'update', entry, journal });
    return entry;
  }

  function logOp(label, batch, err) {
    if (err) { appendJournal(`${label} → ${err.message || err}`, 'err'); return; }
    const ns = batch.reduce((a, e) => a + e.ns, 0);
    const c = { read: 0, prog: 0, erase: 0 };
    for (const e of batch) c[e.op] = (c[e.op] || 0) + 1;
    const parts = [];
    if (c.erase) parts.push(`${c.erase} erase`);
    if (c.prog) parts.push(`${c.prog} prog`);
    if (c.read) parts.push(`${c.read} read`);
    appendJournal(`${label} → ${fmtTime(ns)}${parts.length ? ' · ' + parts.join(' ') : ''}`, 'out');
  }

  // Logs each op's simulated flash cost. Swallows a thrown error (logs it
  // instead) rather than rethrowing — callers that care check the return.
  function timed(label, fn) {
    currentBatch = [];
    let res, err = null;
    try { res = fn(); } catch (e) { err = e; }
    const batch = currentBatch; currentBatch = null;
    logOp(label, batch, err);
    return res;
  }

  const fs = {
    write: (n, d) => timed(`write(${n}, ${sizeOf(d)} B)`, () => runner.write(n, d)),
    read: (n) => timed(`read(${n})`, () => runner.read(n)),
    cat: (n) => timed(`cat(${n})`, () => runner.cat(n)),
    remove: (n) => timed(`delete(${n})`, () => runner.remove(n)),
    stat: (n) => timed(`stat(${n})`, () => runner.stat(n)),
    mkdir: (n) => timed(`mkdir(${n})`, () => runner.mkdir(n)),
    list: () => timed('ls()', () => runner.list()),
    gcStep: () => timed('gc()', () => runner.gcStep()),
    exists: (n) => runner.exists(n),
    fsinfo: () => runner.fsinfo(),
    device, geometry: runner.geometry, get hostBytes() { return runner.hostBytes; },
  };

  // Run an op, then resolve after the player finishes playing it (await =
  // pace to sim time). In prep/setup mode (ADR-0014) skip the barrier and
  // flush the die synchronously — full speed, no animation, still logged.
  let prepMode = false;
  const pace = (fn) => {
    const res = fn();
    if (prepMode) { viz.flush(); return Promise.resolve(res); }
    return viz.barrier().then(() => res);
  };

  // Streaming ls: open a pooled dir handle, then await each fffs_dir_read and
  // print the entry as it arrives. `prefix` scopes the scan (empty ⇒ whole FS).
  const lsStream = async (printEach, prefix = '') => {
    const files = [];
    const dir = await pace(() => runner.openDir(prefix));
    for (;;) {
      const e = await pace(() => dir.read());
      if (!e) break;
      if (printEach) appendJournal(`  ${e.name}  ${e.size} B`, 'out');
      files.push(e);
    }
    await pace(() => dir.close());
    if (printEach && !files.length) appendJournal('  (empty)', 'out');
    return files;
  };

  let active = true;

  const session = {
    fsId, name: name || fsId, caps: runner.caps, runner, device, viz, geometry: runner.geometry,

    /** Execute one churn event (WRITE/DELETE); DONE/NO_SLOT are no-ops. Content is
     *  deterministic from ev.writeSeed, so the same event is byte-identical on any FS. */
    runChurnEvent(ev) {
      if (ev.type === CHURN_EVENT.WRITE) {
        return timed(`write(${ev.name}, ${ev.size} B)`, () => runner.write(ev.name, deterministicBytes(ev.writeSeed, ev.size)));
      }
      if (ev.type === CHURN_EVENT.DELETE) {
        return timed(`delete(${ev.name})`, () => runner.remove(ev.name));
      }
      return undefined; // DONE / NO_SLOT: nothing to issue this step
    },
    /** One opportunistic GC step, timed + logged; null no-op when unsupported. */
    runGcStep() { return fs.gcStep(); },

    /** Execute ONE broadcast filesystem operation on this session (ADR-0017):
     *  timed + logged + animated exactly like runChurnEvent, landing in this
     *  session's journal and costing simulated flash time. `op` and its `args`:
     *    write  { name, size, seed }  content = deterministicBytes(seed, size),
     *                                 so the same poke is byte-identical on every FS
     *    read   { name }
     *    ls     { }                   whole-FS listing (its dir scan is the traffic)
     *    delete { name }
     *    stat   { name }
     *    mkdir  { name }
     *    gc     { }                   one GC step (null no-op when unsupported)
     *    format { }                   re-format + mount (fresh, empty chip)
     *  Returns whatever the underlying op yields. Throws on an unknown op. */
    runPoke(op, args = {}) {
      switch (op) {
        case 'write': {
          const size = args.size >>> 0;
          return timed(`write(${args.name}, ${size} B)`, () => runner.write(args.name, deterministicBytes(args.seed >>> 0, size)));
        }
        case 'read':   return fs.read(args.name);
        case 'ls':     return fs.list();
        case 'delete': return fs.remove(args.name);
        case 'stat':   return fs.stat(args.name);
        case 'mkdir':  return fs.mkdir(args.name);
        case 'gc':     return fs.gcStep();
        case 'format': return timed('format()', () => { runner.format(); runner.mount(); });
        default: throw new Error(`runPoke: unknown op '${op}'`);
      }
    },
    /** Fresh, empty chip. Churn-model reset is the manager's job, not the session's. */
    freshFormat() { runner.format(); runner.mount(); },

    pace, barrier: () => viz.barrier(), pending: () => viz.pending(),
    /** Log + pace primitive, exposed so the manager can build the console's
     *  paced handle/dir proxies (fs.open/openDir) on top of this session. */
    timed,

    /** Cheap, frequent: device counters + display fractions (no flash re-scan). */
    refreshHUD($) {
      const m = viz.metrics();
      const s = device.stats;
      const info = runner.fsinfo();
      const wa = runner.hostBytes ? (s.programBytes / runner.hostBytes) : 1;
      let peakWear = 0; for (const w of device.wear) if (w > peakWear) peakWear = w;
      const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      set('sAmp', wa.toFixed(1) + '×'); set('fAmp', wa.toFixed(1) + '×');
      set('fProg', Math.round(100 * m.displayedBytes / m.capacityBytes) + '%');
      set('fFree', m.erasedPages);
      set('sFiles', info.files);
      set('sBytes', (info.bytes / 1024).toFixed(1) + ' KB');
      set('sErase', s.erases); set('fErase', s.erases);
      set('sRead', s.reads); set('sWear', peakWear);
      set('fSim', fmtTime(s.simNs));
      const specLive = $('specLive');
      if (specLive) specLive.textContent = `mounted · ${info.files} files · ${fmtTime(s.simNs)} of flash time`;
    },
    /** Expensive, on-change only: reachability walk → die tint + precise live/garbage.
     *  Shares the single cached walk with livenessCounts; repaints the die + HUD
     *  only when a new walk has happened since the last paint (appliedGen). */
    refreshLiveness($) {
      ensureLiveness();
      if (appliedGen === livenessGen) return;   // nothing new to paint since last call
      appliedGen = livenessGen;
      if (!cachedMap) return;
      viz.applyLiveMap(cachedMap);
      const c = viz.liveCounts();
      const programmed = c.live + c.obsolete + c.metadata;
      const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      set('sObs', programmed ? Math.round(100 * c.obsolete / programmed) + '%' : '0%');
      const uProg = $('uProg'); if (uProg) uProg.style.width = (100 * c.live / viz.npages) + '%';
      const uObs = $('uObs'); if (uObs) uObs.style.width = (100 * c.obsolete / viz.npages) + '%';
      let liveSectors = 0; const pps = viz.pagesPerSector;
      for (let sec = 0; sec * pps < cachedMap.length; sec++)
        for (let k = 0; k < pps; k++) if (cachedMap[sec * pps + k] === 3) { liveSectors++; break; }
      set('sLive', liveSectors);
    },
    /** Cheap cached page-count readout — { live, obsolete, metadata } — for any
     *  session (displayed or not) without mutating viz. Walks (runner.liveMap())
     *  only when this session's own flash changed since the last computation,
     *  sharing that one walk with refreshLiveness; { live:0, obsolete:0,
     *  metadata:0 } when the FS lacks a live map. */
    livenessCounts() {
      ensureLiveness();
      return { live: cachedCounts.live, obsolete: cachedCounts.obsolete, metadata: cachedCounts.metadata };
    },

    /** Show/hide this session's die element (inactive sessions stay mounted but hidden). */
    setActive(v) { active = v; dieEl.classList.toggle('hidden', !active); },
    setScale(simNsPerRealMs) { viz.setScale(simNsPerRealMs); },
    setPrep(v) { prepMode = !!v; viz.setPrep(prepMode); },
    setHeatmap(on) { viz.setHeatmap(on, dieEl); },
    attachInspector(el) { viz.attachInspector(el); },

    names: () => runner.names(),
    lsStream,
    fs,

    // ---- per-session journal / tape (ADR-0017/0018) ----
    /** This session's op-log scrollback: [{ id, text, cls, state }], newest last.
     *  `state` ∈ 'queued' | 'live' | 'done'. Read-only for the UI; mutate state
     *  through setJournalState so subscribers are notified. */
    journal,
    /** Subscribe to journal changes. cb({ type: 'append'|'update', entry, journal })
     *  fires on every append and every state change. Returns an unsubscribe fn. */
    onJournal(cb) { journalSubs.push(cb); return () => { const i = journalSubs.indexOf(cb); if (i >= 0) journalSubs.splice(i, 1); }; },
    /** Append a line to the tape (also mirrored to the legacy onLog sink). The
     *  coordinator uses this for lifecycle lines — pass state 'queued'/'live';
     *  op-result lines self-append as 'done'. Returns the entry. */
    appendJournal,
    /** Advance an entry's lifecycle state ('queued' → 'live' → 'done') in place,
     *  notifying subscribers. No-op when unchanged. */
    setJournalState,

    /** Stop the player, unmount, and remove this session's die from the DOM.
     *  viz.stop() first so no rAF loop survives to pin the device + WASM module
     *  against the detached die (ADR-0015). Called on FS switch. */
    teardown() {
      viz.stop();
      try { runner.unmount(); } catch { /* already unmounted / driver-specific */ }
      container.removeChild(dieEl);
    },
  };
  return session;
}
