/*
 * Session: one filesystem instance, fully self-contained — its own runner,
 * viz, die DOM, op-log capture (timed()), and liveness tracking (ADR-0015).
 *
 * A session is a pure EXECUTOR: it runs whatever it's handed (a churn event,
 * a GC step, or a whole atomic COMMAND) and paces/logs/animates it, but never
 * decides what runs next. The churn *generator*, the gc-vs-churn ratio, and
 * the one canonical broadcast sequence (ADR-0016/0019) all live one layer up,
 * in the coordinator, so it can drive N sessions off one shared timeline
 * without touching session internals — see runChurnEvent()/runGcStep()/
 * runCommand() below, the seam the coordinator calls through.
 *
 * ADR-0019 moved the broadcast unit from the op to the whole atomic COMMAND:
 * runCommand(fn, seed, pace) runs an async command function against a fresh,
 * LOCAL inner API (writeFile/readFile/.../fs.open/openDir/...) built by
 * buildLocalApi() below. Every call the command makes through that API is
 * real: it executes for real (simNs jumps synchronously), animates through
 * this session's own viz queue, and returns this session's real data. Pacing
 * (Race's shared-clock gate, Pace's cross-session phaser+drain) is supplied
 * by the coordinator as a small `{ before(), after() }` hook pair — session.js
 * itself stays mode-agnostic, just awaiting whatever the coordinator hands it
 * around each op.
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

// mulberry32 — same generator idiom as lockstep.js's, but here it draws ONE
// scalar per call (a name / a size / a "which file" pick), not a byte fill.
// Each command invocation gets its own instance seeded from the coordinator's
// per-command seed (ADR-0019), so a no-arg draw is identical call-for-call
// across every session running the same command.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Write content is a PURE function of (name, size) — ADR-0019's determinism-
// by-construction refinement over ADR-0015's writeSeed-per-event: a console
// writeFile('a', 100) is byte-identical on every FS regardless of history, so
// a state-dependent script that issues a different NUMBER of writes per
// filesystem can't desync a shared draw-stream and corrupt later writes. A
// small FNV-1a over the name, folded with the size, feeds deterministicBytes.
function hashNameSize(name, size) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= size; h = Math.imul(h, 0x01000193);
  return h >>> 0;
}

const NOOP_PACE = { before: () => Promise.resolve(), after: () => Promise.resolve() };

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

  // Per-session journal / tape (ADR-0017/0018/0019): this session owns its own
  // op-log scrollback — each FS has its own timing, results, and pending state,
  // so the tape is per-FS and follows focus. Entries carry a lifecycle `state`
  // the coordinator advances ('queued' → 'live' → 'done'); a result line
  // emitted by an already-executed op defaults to 'done'. The legacy onLog sink
  // still fires for every line, so existing callers (the shared termout) are
  // unaffected — the journal is purely additive.
  const journal = [];
  const journalSubs = [];
  let journalSeq = 0;
  // Cap the scrollback so a long high-speed run (thousands of auto-workload op
  // lines per second) can't grow this array without bound. 2000 is far above the
  // 400 lines the tape ever displays (playground renderTapeFull slices -400), so
  // trimming the oldest never drops anything on screen. It is also safe for a
  // live command entry: the coordinator holds command entries by reference via
  // entry.journalEntries and flips their state through setJournalState (which
  // mutates the object, not this array), so a trimmed-but-still-live entry keeps
  // working; only its far-off-screen history slot is dropped.
  const JOURNAL_MAX = 2000;
  const notifyJournal = (change) => { for (const cb of journalSubs) cb(change); };
  /** Append one line to the journal and the legacy onLog sink. Returns the entry
   *  so its `state` can later be advanced in place via setJournalState. */
  function appendJournal(text, cls = 'out', state = 'done') {
    const entry = { id: journalSeq++, text, cls, state };
    journal.push(entry);
    if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX);
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
  /** Wipe the tape back to empty (a full-simulation Reset, not a per-op
   *  concern) — used alongside freshFormat() so the console/tape shows the
   *  same clean slate a fresh page load does. journalSeq keeps counting up
   *  (never reused) so a stale id from before the clear can't collide with a
   *  post-clear entry. */
  function clearJournal() {
    journal.length = 0;
    notifyJournal({ type: 'clear', journal });
  }

  function logOp(label, batch, err, cls = 'out') {
    if (err) { appendJournal(`${label} → ${err.message || err}`, 'err'); return; }
    const ns = batch.reduce((a, e) => a + e.ns, 0);
    const c = { read: 0, prog: 0, erase: 0 };
    for (const e of batch) c[e.op] = (c[e.op] || 0) + 1;
    const parts = [];
    if (c.erase) parts.push(`${c.erase} erase`);
    if (c.prog) parts.push(`${c.prog} prog`);
    if (c.read) parts.push(`${c.read} read`);
    appendJournal(`${label} → ${fmtTime(ns)}${parts.length ? ' · ' + parts.join(' ') : ''}`, cls);
  }

  // Logs each op's simulated flash cost, then rethrows a thrown error (after
  // logging it) so the local api's ops reject like a real async call would —
  // a script can `try/catch` a failed readFile/deleteFile/etc. runEntry()
  // (lockstep.js, the churn/gc synchronous path) wraps its own call in a
  // try/catch, so this rethrow doesn't change churn/GC step behavior.
  function timed(label, fn, cls) {
    currentBatch = [];
    let res, err = null;
    try { res = fn(); } catch (e) { err = e; }
    const batch = currentBatch; currentBatch = null;
    logOp(label, batch, err, cls);
    if (err) throw err;
    return res;
  }

  let prepMode = false;

  // ADR-0023: file-granular op count, decoupled from the coordinator's sequence
  // cursor. Incremented by exactly 1 per HIGH-LEVEL file operation — the friendly
  // API surface (writeFile/readFile/deleteFile/ls/getFiles/mkdir/stat), the
  // lifecycle ops (fs.format/mount/unmount), and each churn file-event — and
  // NEVER at runOp() (shared with the fs-level handle/dir rung), never on gc
  // (background maintenance), never at the command boundary. So a whole console
  // line like `for (i=0;i<100;i++) ls()` counts 100, and a bare writeFile counts
  // 1 even though it internally does open+write+close. This is the number the
  // scoreboard shows as "ops done" / rates ops-per-sec against (lockstep.js reads
  // it via s.fileOpCount); the cursor stays the sequence index and Pace rendezvous
  // unit, untouched.
  let fileOpCount = 0;
  const bumpFileOp = () => { fileOpCount += 1; };

  // ---- the LOCAL inner API (ADR-0014 refined by ADR-0019) ----
  // Built fresh per command invocation (runCommand, below) around a per-command
  // seeded RNG and the coordinator's pace hooks. Every op funnels through
  // runOp(): issue (in-flight++), pace.before() (Race's shared-clock gate — a
  // no-op in Pace), execute for real (timed(), simNs jumps synchronously,
  // animation enqueues into viz), pace.after() (Pace's drain+cross-session
  // join — a no-op in Race), in-flight-- on settle. In prep mode (ADR-0014)
  // both hooks are bypassed entirely and the die is flushed synchronously —
  // bulk setup shouldn't lockstep with anything.
  function buildLocalApi(rng, pace, onIssue, onSettle) {
    function runOp(label, work, cls) {
      onIssue();
      const p = (async () => {
        if (prepMode) {
          const res = timed(label, work, cls);
          viz.flush();
          return res;
        }
        await pace.before();
        const res = timed(label, work, cls);
        await pace.after();
        return res;
      })();
      // Settle bookkeeping runs on both outcomes, but the .finally() chain is a
      // SEPARATE promise from the `p` we return: if `work` throws (NO_SPACE, a
      // read of a missing file) that chain rejects too, and nothing awaits it, so
      // it leaks an unhandledRejection even when the caller handles the returned
      // `p`. Neutralize the discarded branch; the real rejection still rides `p`.
      p.finally(onSettle).catch(() => {});
      return p;
    }

    let nameSeq = 0;
    const randomName = () => `f${(nameSeq++).toString(36).padStart(3, '0')}-${((rng() * 0x100000000) >>> 0).toString(16).padStart(8, '0')}.bin`;
    const randomSize = () => 1024 + Math.floor(rng() * (32 * 1024 - 1024));
    // No-arg reads/deletes need a target; pick deterministically (same rng
    // stream ⇒ same call-order draw across sessions) from this session's own
    // tracked set — a free, no-device-cost JS-side lookup (runner.names()),
    // mirroring the old console's pickKnown().
    function pickExisting() {
      const names = runner.names().sort();
      if (!names.length) throw new Error('no files yet — write one first');
      return names[Math.floor(rng() * names.length)];
    }
    // Friendly mutators accept a descriptor OR a bare name (ADR-0019 refinement
    // 3): deleteFile(last) and deleteFile(last.name) both work.
    const resolveName = (arg) => (arg && typeof arg === 'object' ? arg.name : (arg ?? undefined)) ?? pickExisting();

    function writeFile(name, size) {
      const n = name ?? randomName();
      const sz = size ?? randomSize();
      bumpFileOp();
      return runOp(`write(${n}, ${sz} B)`, () => {
        runner.write(n, deterministicBytes(hashNameSize(n, sz), sz));
        return { name: n, size: sz };
      });
    }
    function readFile(arg) {
      const n = resolveName(arg);
      bumpFileOp();
      return runOp(`read(${n})`, () => ({ name: n, size: runner.read(n).length }));
    }
    function deleteFile(arg) {
      const n = resolveName(arg);
      bumpFileOp();
      return runOp(`delete(${n})`, () => {
        const st = runner.stat(n);
        runner.remove(n);
        return { name: n, size: st ? st.size : 0 };
      });
    }
    async function mkdir(path) {
      // mkdir -p: each path component is its own paced op (ADR-0014), real on
      // hierarchical FSs, a no-op success on flat ones. One FILE op per mkdir
      // CALL (ADR-0023), regardless of how many components it creates.
      bumpFileOp();
      let cur = '';
      for (const part of String(path).split('/').filter(Boolean)) {
        cur += (cur ? '/' : '') + part;
        await runOp(`mkdir(${cur})`, () => runner.mkdir(cur));
      }
      return 'ok';
    }
    // Shared dir-scan primitive for ls()/getFiles(): opens a pooled dir handle
    // and paces each fffs_dir_read individually — real device traffic, driver
    // order. `sorted` (getFiles) sorts the RETURNED array at the JS boundary
    // only, after the scan; the animated/streamed scan itself always plays in
    // driver order (ADR-0019 — sorting is a scripting-input concern, not a
    // property of the physical scan).
    async function scanDir(prefix, { printEach = false, sorted = false } = {}) {
      const dir = await runOp(`openDir(${prefix || ''})`, () => runner.openDir(prefix || ''));
      const files = [];
      for (;;) {
        const e = await runOp('dir.read()', () => dir.read());
        if (!e) break;
        if (printEach) appendJournal(`  ${e.name}  ${e.size} B`, 'out');
        files.push(e);
      }
      await runOp('dir.close()', () => dir.close());
      if (printEach && !files.length) appendJournal('  (empty)', 'out');
      if (sorted) files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return files;
    }
    // ls/getFiles/stat each count as ONE file op per call (ADR-0023), even though
    // ls/getFiles internally fan out into openDir + N×dir.read + dir.close (the
    // fs rung, below the line and NOT counted).
    const ls = (prefix) => { bumpFileOp(); return scanDir(prefix, { printEach: true, sorted: false }); };
    const getFiles = (prefix) => { bumpFileOp(); return scanDir(prefix, { printEach: false, sorted: true }); };
    const stat = (name) => { bumpFileOp(); return runOp(`stat(${name})`, () => runner.stat(name)); };
    // Console/button gc(n=1): routes through the SAME runOp (paced, timed,
    // journal-logged, die-animated) path every other console helper uses —
    // previously this fell through to the undefined api.fs.gcStep (fs has no
    // gcStep member), so a typed gc() silently did nothing while churn's
    // direct session.runGcStep() call printed timing + op stats and glowed
    // the die. `n` steps collapse into ONE atomic op/journal line, matching
    // how every other multi-step console helper (e.g. mkdir -p) reports.
    function gc(n = 1) {
      const steps = Math.max(1, n | 0);
      return runOp('gc()', () => { let r; for (let i = 0; i < steps; i++) r = runner.gcStep(); return r; }, 'gc');
    }

    // ---- Tier 2 — raw fs.* handles (ADR-0014), paced locally the same way. ----
    function wrapHandle(h, label) {
      return {
        read: (n) => runOp(`read ${label}`, () => h.read(n)),
        write: (data) => runOp(`write ${label}`, () => h.write(data)),
        seek: (off, whence) => runOp(`seek ${label}`, () => h.seek(off, whence)),
        stat: () => runOp(`stat ${label}`, () => h.stat()),
        close: () => runOp(`close ${label}`, () => h.close()),
      };
    }
    function wrapDir(d, label) {
      return {
        read: () => runOp(`dir.read ${label}`, () => d.read()),
        close: () => runOp(`dir.close ${label}`, () => d.close()),
      };
    }
    const fs = {
      stat: (n) => runOp(`stat(${n})`, () => runner.stat(n)),
      list: () => runOp('list()', () => runner.list()),
      mkdir: (n) => runOp(`mkdir(${n})`, () => runner.mkdir(n)),
      // Lifecycle ops ARE file-rung ops (ADR-0023) — counted; the rest of fs.*
      // (raw whole-file + handle/dir ops) is the fs rung, not counted.
      format: () => { bumpFileOp(); return runOp('format()', () => runner.format()); },
      mount: () => { bumpFileOp(); return runOp('mount()', () => runner.mount()); },
      unmount: () => { bumpFileOp(); return runOp('unmount()', () => runner.unmount()); },
      sectorClasses: () => runOp('sectorClasses()', () => runner.sectorClasses()),
      liveMap: () => runOp('liveMap()', () => runner.liveMap()),
      write: (n, d) => runOp(`write(${n}, ${sizeOf(d)} B)`, () => runner.write(n, d)),
      read: (n) => runOp(`read(${n})`, () => runner.read(n)),
      cat: (n) => runOp(`cat(${n})`, () => runner.cat(n)),
      remove: (n) => runOp(`delete(${n})`, () => runner.remove(n)),
      exists: (n) => runOp(`exists(${n})`, () => runner.exists(n)),
      fsinfo: () => runOp('fsinfo()', () => runner.fsinfo()),
      open: async (n, mode) => wrapHandle(await runOp(`open(${n})`, () => runner.open(n, mode)), n),
      openDir: async (prefix) => wrapDir(await runOp(`openDir(${prefix || ''})`, () => runner.openDir(prefix || '')), prefix || ''),
    };

    return { writeFile, readFile, deleteFile, mkdir, ls, getFiles, stat, gc, fs };
  }

  let active = true;

  const session = {
    fsId, name: name || fsId, caps: runner.caps, runner, device, viz, geometry: runner.geometry,

    /** ADR-0023: cumulative count of high-level FILE ops this session has run
     *  (friendly API + lifecycle + churn file-events; gc and fs-rung ops excluded).
     *  The scoreboard's "ops done" and the ops/sec rate read this, not the cursor. */
    get fileOpCount() { return fileOpCount; },

    /** Execute one churn event (WRITE/DELETE); DONE/NO_SLOT are no-ops. Content is
     *  deterministic from ev.writeSeed, so the same event is byte-identical on any FS.
     *  Churn steps are simple, synchronous, single-op sequence entries — they don't
     *  need the async command machinery below (ADR-0019). */
    runChurnEvent(ev) {
      // Each churn WRITE/DELETE is one file-event = one file op (ADR-0023);
      // DONE/NO_SLOT issue nothing and are not counted.
      if (ev.type === CHURN_EVENT.WRITE) {
        bumpFileOp();
        return timed(`write(${ev.name}, ${ev.size} B)`, () => runner.write(ev.name, deterministicBytes(ev.writeSeed, ev.size)));
      }
      if (ev.type === CHURN_EVENT.DELETE) {
        bumpFileOp();
        return timed(`delete(${ev.name})`, () => runner.remove(ev.name));
      }
      return undefined; // DONE / NO_SLOT: nothing to issue this step
    },
    /** One opportunistic GC step, timed + logged; null no-op when unsupported
     *  (runner.gcStep() itself gates on FF_CAP_GC). GC is background maintenance,
     *  NOT a file op (ADR-0023): it charges flash time but never bumps fileOpCount. */
    runGcStep() { return timed('gc()', () => runner.gcStep(), 'gc'); },

    /** Run one atomic COMMAND (ADR-0019) — `fn` is `async (api) => any`, `seed` is
     *  the per-command draw seed baked at broadcast(), `pace` is the coordinator's
     *  `{ before(), after() }` hook pair for the current mode (Race gate / Pace
     *  phaser+drain — see buildLocalApi). Resolves on QUIESCENCE: fn has settled
     *  AND no op it issued is still in flight (a counter, ++ on issue, -- on
     *  settle), re-checked at a macrotask boundary (setTimeout, never a microtask
     *  or a synchronous re-check at the decrement) so a contiguous chain's
     *  momentary counter-zero between two back-to-back ops can't misfire — the
     *  microtask cascade a chain like `await Promise.resolve()` rides fully
     *  drains before this fires. Never rejects: a thrown/rejected command is
     *  logged and still counted quiescent once settled + drained, so a runaway
     *  script can't wedge the coordinator's Promise.all. */
    runCommand(fn, seed, pace) {
      pace = pace || NOOP_PACE;
      return new Promise((resolveQuiescent) => {
        let inFlight = 0, fnDone = false, settled = false;
        const rng = mulberry32(seed >>> 0);
        const check = () => {
          setTimeout(() => {
            if (!settled && fnDone && inFlight === 0) { settled = true; resolveQuiescent(); }
          }, 0);
        };
        const api = buildLocalApi(rng, pace, () => { inFlight++; }, () => { inFlight--; check(); });
        Promise.resolve().then(() => fn(api)).then(
          () => { fnDone = true; check(); },
          (err) => { appendJournal(`command error: ${err?.message || err}`, 'err'); fnDone = true; check(); },
        );
      });
    },

    /** Fresh, empty chip. Churn-model reset is the manager's job, not the session's.
     *  A fresh chip has done no file ops, so the file-op count resets too (ADR-0023);
     *  this is silent internal setup, not a tape entry, so it does not itself count. */
    freshFormat() { runner.format(); runner.mount(); fileOpCount = 0; },

    barrier: () => viz.barrier(), pending: () => viz.pending(),
    /** Log + pace primitive, exposed so the coordinator's pace hooks (and any
     *  direct, non-command execution) can time an op the same way commands do. */
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
    /** Re-source this session's glow colors from the active palette (ADR color
     *  themes): delegates to viz so a live theme switch recolors the glow. */
    refreshTheme() { viz.refreshTheme(); },
    attachInspector(el) { viz.attachInspector(el); },

    // ---- per-session journal / tape (ADR-0017/0018/0019) ----
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
    /** Wipe the tape to empty and notify subscribers ({ type: 'clear', journal }).
     *  Pairs with freshFormat() for a full Reset-to-boot-state. */
    clearJournal,

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
