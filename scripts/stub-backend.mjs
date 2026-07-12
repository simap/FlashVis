/*
 * Test-only stand-in for web/src/session.js + web/src/lockstep.js, matching
 * the ADR-0019 contract playground.js consumes:
 *
 *   coordinator: setSessions/reset/start/stop/step, setMode/get mode,
 *     setSpeed, setGcRatio, snapshots(), pendingFor(session) → {entries,
 *     gap, behind}, broadcast(commandFn, label) → {index, entry}
 *   session: journal, onJournal(cb), fsId, name, + view methods
 *     (createSession mounts a `.die` into container)
 *
 * The real session.js/lockstep.js are owned by a parallel backend lane and,
 * as of this writing, still implement the PRE-ADR-0019 op-level broadcast
 * (ADR-0017) — they don't yet expose broadcast(commandFn,label) or
 * pendingFor().behind. This stub lets the UI/compiler be exercised against
 * the CONTRACT the backend is converging on, deterministically and without
 * real WASM. playground.js picks this up via globalThis.__flashvisBackend,
 * set by dom-smoke.mjs before importing playground.js — see loadBackend()
 * there. Once the backend lands ADR-0019 for real, dom-smoke should drop
 * this override and boot against the real modules again (as it used to).
 *
 * Not a faithful device/GC simulation — just enough state (a fake file
 * table, a fake simNs counter, per-session journals with real queued→live→
 * done lifecycle, an artificial Race stagger) to drive the UI through every
 * state ADR-0018 describes.
 */

const fmtMs = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };

function buildLocalApi(session) {
  let n = 0;
  const autoName = () => `f${(n++).toString(36).padStart(3, '0')}`;
  const pick = () => { const k = [...session._files.keys()]; if (!k.length) throw new Error('no files yet'); return k[Math.floor(Math.random() * k.length)]; };
  // ADR-0023: file-granular op count, mirrored here so the stub matches the real
  // contract playground.js reads (snapshots().fileOpCount, the Race "ops done"
  // vital). Bumped once per high-level file op; NOT on gc.
  return {
    writeFile: async (name, size) => {
      const nm = name ?? autoName();
      const sz = size ?? (256 + Math.floor(Math.random() * 4096));
      session._bumpFileOp();
      session._files.set(nm, sz);
      session._bumpSim(sz);
      session._journalOp(`write(${nm}, ${sz} B) → ${fmtMs(sz * 80)}`, 'out');
      return { name: nm, size: sz };
    },
    readFile: async (name) => {
      const nm = name ?? pick();
      const sz = session._files.get(nm) ?? 0;
      session._bumpFileOp();
      session._bumpSim(sz / 4);
      session._journalOp(`read(${nm}) → ${fmtMs(sz * 20)}`, 'out');
      return { name: nm, size: sz };
    },
    deleteFile: async (arg) => {
      const nm = (arg && arg.name) || arg || pick();
      const sz = session._files.get(nm) ?? 0;
      session._bumpFileOp();
      session._files.delete(nm);
      session._journalOp(`delete(${nm})`, 'out');
      return { name: nm, size: sz };
    },
    mkdir: async (path) => { session._bumpFileOp(); session._journalOp(`mkdir(${path})`, 'out'); return 'ok'; },
    ls: async (prefix = '') => {
      session._bumpFileOp();
      const list = [...session._files.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((name) => ({ name, size: session._files.get(name) }));
      for (const f of list) session._journalOp(`  ${f.name}  ${f.size} B`, 'out');
      if (!list.length) session._journalOp('  (empty)', 'out');
      return list;
    },
    getFiles: async (prefix = '') => { session._bumpFileOp(); return [...session._files.keys()].filter((k) => k.startsWith(prefix)).sort()
      .map((name) => ({ name, size: session._files.get(name) })); },
    stat: async (name) => { session._bumpFileOp(); return (session._files.has(name) ? { name, size: session._files.get(name) } : null); },
    // print sink (mirrors session.js): help()/print() render through this onto
    // the tape. Not a file op; one journal line per '\n'.
    print: (...args) => { for (const line of args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').split('\n')) session._journalOp(line, 'out'); },
    fs: {
      format: async () => { session._bumpFileOp(); session._files.clear(); session._journalOp('format() → mounted, empty', 'out'); },
      gcStep: async () => { session._journalOp('gc() → 0 reclaimed', 'gc'); return null; },   // gc line tagged 'gc' structurally (ADR-0023)
    },
  };
}

export async function createSession(fsId, { geometry, container, name }) {
  const dieEl = document.createElement('div');
  dieEl.className = 'die';
  container.appendChild(dieEl);
  for (let i = 0; i < (geometry.sectorCount || 8); i++) dieEl.appendChild(document.createElement('div'));

  const journal = [];
  const subs = [];
  let seq = 0;
  let fileOps = 0;   // ADR-0023 file-op count (see buildLocalApi / runChurnEvent)
  const notify = (c) => { for (const cb of subs) cb(c); };
  const files = new Map();
  const device = {
    size: geometry.sectorSize * geometry.sectorCount,
    stats: { simNs: 0, reads: 0, programs: 0, erases: 0, programBytes: 0 },
    wear: new Array(geometry.sectorCount).fill(0),
  };

  const session = {
    fsId, name: name || fsId, caps: 0b111, geometry, device,
    get fileOpCount() { return fileOps; },
    _bumpFileOp() { fileOps += 1; },
    journal,
    onJournal(cb) { subs.push(cb); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },
    appendJournal(text, cls = 'out', state = 'done') {
      const entry = { id: seq++, text, cls, state };
      journal.push(entry);
      notify({ type: 'append', entry, journal });
      return entry;
    },
    setJournalState(entry, state) {
      if (!entry || entry.state === state) return entry;
      entry.state = state;
      notify({ type: 'update', entry, journal });
      return entry;
    },
    clearJournal() { journal.length = 0; notify({ type: 'clear', journal }); },
    _files: files,
    _journalOp(text, cls) { return session.appendJournal(text, cls, 'done'); },
    _bumpSim(n) { device.stats.simNs += Math.max(1000, n * 80); device.stats.programs++; device.stats.programBytes += n; },

    runChurnEvent(ev) {
      if (ev.type === 'write') { session._bumpFileOp(); files.set(ev.name, ev.size); session._bumpSim(ev.size); session.appendJournal(`write(${ev.name}, ${ev.size} B)`, 'sys', 'done'); }
      else if (ev.type === 'delete') { session._bumpFileOp(); files.delete(ev.name); session.appendJournal(`delete(${ev.name})`, 'sys', 'done'); }
    },
    runGcStep() { session.appendJournal('gc()', 'gc', 'done'); },   // gc: NOT a file op, tagged 'gc' so its tape line grays (ADR-0023)
    freshFormat() { files.clear(); device.stats.simNs = 0; fileOps = 0; },

    refreshHUD($) {
      const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      set('sFiles', String(files.size));
      set('fSim', fmtMs(device.stats.simNs));
      set('sAmp', '1.0×');
      set('fProg', '0%'); set('fFree', String(geometry.sectorCount * (geometry.sectorSize / geometry.pageSize)));
      set('sErase', String(device.stats.erases));
      set('sRead', String(device.stats.reads)); set('sWear', '0');
      const bytes = [...files.values()].reduce((a, b) => a + b, 0);
      set('sBytes', (bytes / 1024).toFixed(1) + ' KB');
      const sl = $('specLive'); if (sl) sl.textContent = `mounted · ${files.size} files · ${fmtMs(device.stats.simNs)} of flash time`;
    },
    refreshLiveness($) {
      const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      set('sObs', '0%');
      const up = $('uProg'); if (up) up.style.width = '0%';
      const uo = $('uObs'); if (uo) uo.style.width = '0%';
      set('sLive', '0');
    },
    livenessCounts() { return { live: 0, obsolete: 0, metadata: 0 }; },

    setActive(v) { dieEl.classList.toggle('hidden', !v); },
    setPrep() {}, setHeatmap() {}, attachInspector() {},
    names() { return [...files.keys()]; },
    teardown() { container.removeChild?.(dieEl); },
  };
  session.__localApi = buildLocalApi(session);
  return session;
}

export function createLockstep({ churn, gcRatio = 0.5 } = {}) {
  let sessions = [];
  const cursors = new Map();
  const sequence = [];   // {kind:'gc'} | {kind:'event', ev} | {kind:'command', commandFn, label, journalEntries}
  let mode = 'pace';
  let running = false;
  let scale = 20000;
  let ratio = gcRatio;
  const raceRate = new Map();   // artificial per-session divergence, for exercising Race/behind
  let tick = 0;

  // Per-FS EMA ops/sec (A8) — a lightweight stand-in for the real backend's
  // metric, just enough for the UI to have a plausible, moving number to
  // render a bar against. One "op" = one drained sequence entry (churn step,
  // gc, or command) — not a byte-exact op count, this is a stub.
  const opsEma = new Map();
  const lastOpAt = new Map();
  function recordOp(session) {
    const now = Date.now();
    const last = lastOpAt.get(session);
    lastOpAt.set(session, now);
    if (last === undefined) return;
    const dtSec = Math.max(1, now - last) / 1000;
    const inst = 1 / dtSec;
    const prev = opsEma.get(session) ?? inst;
    opsEma.set(session, prev + 0.3 * (inst - prev));
  }

  function genChurnStep() {
    if (Math.random() < ratio) return { kind: 'gc' };
    let ev;
    try { ev = churn?.next?.(); if (ev && churn?.apply && (ev.type === 'write' || ev.type === 'delete')) churn.apply(ev); }
    catch { ev = null; }
    if (!ev) ev = { type: 'write', name: 'w' + Math.random().toString(36).slice(2), size: 512 };
    return { kind: 'event', ev };
  }
  function ensure(n) { while (sequence.length < n) sequence.push(genChurnStep()); }

  async function runOn(session, index) {
    const entry = sequence[index];
    recordOp(session);
    if (entry.kind === 'gc') return session.runGcStep();
    if (entry.kind === 'event') return session.runChurnEvent(entry.ev);
    let je = entry.journalEntries.get(session);
    if (!je) je = session.appendJournal(entry.label, 'in', 'queued');
    session.setJournalState(je, 'live');
    try { await entry.commandFn(session.__localApi); }
    finally { session.setJournalState(je, 'done'); }
  }
  async function advance(session) {
    const i = cursors.get(session) ?? 0;
    ensure(i + 1);
    await runOn(session, i);
    cursors.set(session, i + 1);
  }
  async function paceStep() {
    if (!sessions.length) return;
    const i = Math.min(...sessions.map((s) => cursors.get(s) ?? 0));
    ensure(i + 1);
    const due = sessions.filter((s) => (cursors.get(s) ?? 0) === i);
    await Promise.all(due.map((s) => runOn(s, i)));
    for (const s of due) cursors.set(s, i + 1);
  }

  setInterval(() => {
    tick++;
    if (!running) return;
    if (mode === 'pace') { paceStep(); }
    else { for (const s of sessions) if (tick % (raceRate.get(s) ?? 1) === 0) advance(s); }
  }, 4);

  // Stub approximation of the real coordinator's `waiting` (no real race clock):
  // in Pace, a session whose cursor leads the shared min is parked waiting on the
  // laggard. Keeps dom-smoke green without modelling the clock/barrier gate.
  const stubWaiting = (s) => {
    if (mode !== 'pace') return false;
    const cs = sessions.map((x) => cursors.get(x) ?? 0);
    const minCursor = cs.length ? Math.min(...cs) : 0;
    return (cursors.get(s) ?? 0) > minCursor;
  };

  return {
    setSessions(list) {
      const next = new Set(list);
      for (const s of cursors.keys()) if (!next.has(s)) cursors.delete(s);
      sessions = list.slice();
      for (const s of sessions) if (!cursors.has(s)) cursors.set(s, 0);
      sessions.forEach((s, idx) => raceRate.set(s, idx === 0 ? 1 : 3));   // stagger so Race genuinely diverges
    },
    setGcRatio(v) { ratio = v; },
    setMode(m) { mode = m; },
    get mode() { return mode; },
    setSpeed(v) { scale = v; },
    start() { running = true; },
    stop() { running = false; },
    get running() { return running; },
    async step() {
      if (mode === 'pace') { await paceStep(); return; }
      await Promise.all(sessions.map((s) => advance(s)));
    },
    reset() {
      for (const s of sessions) s.freshFormat();
      sequence.length = 0;
      for (const s of sessions) cursors.set(s, 0);
    },
    broadcast(commandFn, label) {
      const entry = { kind: 'command', commandFn, label, journalEntries: new Map() };
      const index = sequence.length;
      sequence.push(entry);
      for (const s of sessions) entry.journalEntries.set(s, s.appendJournal(label, 'in', 'queued'));
      return { index, entry };
    },
    pendingFor(session) {
      const c = cursors.get(session) ?? 0;
      const frontier = sequence.length;
      const entries = [];
      for (let i = c; i < frontier; i++) if (sequence[i].kind === 'command') entries.push({ index: i, entry: sequence[i] });
      const gap = frontier - c;
      // Genuine lag = some OTHER participant is further along than this one —
      // covers real Race divergence and a still-draining Race→Pace catch-up.
      // A command freshly queued while paused (every cursor still equal) is
      // NOT "behind" even though gap>0 — nobody is ahead of anybody yet.
      let maxOther = c;
      for (const s of sessions) if (s !== session) maxOther = Math.max(maxOther, cursors.get(s) ?? 0);
      return { entries, gap, behind: maxOther > c };
    },
    snapshots() {
      // Pace "holding" (A8): a session that has run ahead of the slowest
      // participant's cursor is parked at the frontier waiting on it — the
      // real coordinator's phaser/join does this structurally; here it falls
      // straight out of paceStep() only ever advancing sessions AT the min
      // cursor, so "ahead of min, in pace mode" is exactly "holding".
      const cursorVals = sessions.map((s) => cursors.get(s) ?? 0);
      const minCursor = cursorVals.length ? Math.min(...cursorVals) : 0;
      return sessions.map((s) => ({
        fsId: s.fsId, name: s.name, stepCursor: cursors.get(s) ?? 0, fileOpCount: s.fileOpCount ?? 0, simNs: s.device.stats.simNs,
        wa: 1 + (s.device.stats.programBytes || 0) / 1e6, files: s._files.size, garbagePct: 0,
        opsPerSec: opsEma.get(s) ?? 0,
        holding: mode === 'pace' && (cursors.get(s) ?? 0) > minCursor,
        stalled: false, // the stub does not model a diverged race clock
        waiting: stubWaiting(s), // instantaneous "sim paused"; stub-approximated (no real race clock)
      }));
    },
    /** Cheap per-fsId `waiting` map, mirroring the real coordinator's waitStates()
     *  (no fsinfo/liveness). The stub has no real race clock, so it approximates:
     *  in Pace, a session whose cursor LEADS the shared min is parked waiting on
     *  the laggard. Simple and non-breaking; the real signal lives in lockstep.js. */
    waitStates() {
      const out = {};
      for (const s of sessions) out[s.fsId] = stubWaiting(s);
      return out;
    },
  };
}
