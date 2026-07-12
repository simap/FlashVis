/*
 * Playground: the console command-compiler + comparison UI (ADR-0018/0019).
 *
 * Two jobs live here:
 *
 * 1. COMMAND COMPILER (ADR-0019). A console line — or a button's injected
 *    command — is compiled into ONE atomic `commandFn = async (api) => …` and
 *    handed to `coordinator.broadcast(commandFn, label)`. The coordinator runs
 *    it per-session against that session's own local, paced `api`; nothing in
 *    here ever touches a session directly once broadcast. The compiled
 *    function runs against a per-session SANDBOX (a `with`-scope backed by a
 *    Proxy) so an undeclared loop var (`for (i=0;…)`) stays local to that one
 *    invocation instead of leaking to a shared `window.i` two concurrent
 *    sessions would stomp.
 *
 * 2. COMPARISON UI (ADR-0018). The console *is* the tape — buttons inject
 *    their command rather than calling a function, so the tape is a complete,
 *    replayable record. Focus is a pure view property: the header scoreboard
 *    doubles as the focus switcher, and the die / tape / telemetry / legend
 *    all follow whichever session is focused. The workload engine (Run/Stop/
 *    Step, Race/Pace, SPEED, BG GC) stays a separate, visually distinct
 *    register from manual pokes, per ADR-0018.
 *
 * session.js / lockstep.js (ADR-0015/0016/0019) are the backend this file
 * consumes — not owned here. They're loaded dynamically (see loadBackend
 * below) so a test harness can swap in a stub that matches the documented
 * contract without touching the real modules or requiring real WASM.
 */
import { createChurnModel, CHURN_CLASS } from './churn.js';
import { FF_CAP_GC, FF_CAP_LIVE_MAP } from './runner.js';

// FS registry (ADR-0015): fsId → display name. All are live from page load
// (ADR-0017 — "every active filesystem runs the same workload at once").
const FS_REGISTRY = {
  fastffs: 'FASTFFS', littlefs: 'LittleFS', spiffs: 'SPIFFS', jesfs: 'JesFS',
  fatfs: 'FAT+WL',   // ChaN FatFs over the ESP-IDF wear_levelling FTL — one logical FS entry
};
const DEFAULT_FS = 'fastffs';

// Auto-workload churn config, scaled to the 256 KiB (4096×64) device. The model
// drives the FS toward a steady-state live size instead of overfilling it.
const CHURN_SEED = 0x00c0ffee;
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
    // Over-capacity large writes are DISABLED (weight 0) for now: near the live
    // ceiling they can ENOSPC, and the drivers diverge on what a failed write
    // leaves behind (log-structured FSs fail atomically; FAT truncates), while
    // the open-loop oracle (ADR-0010) must stay blind to per-FS outcomes.
    // Revisit when the churn tuning knobs land (see ROADMAP).
    { key: CHURN_CLASS.LARGE,  name: 'large',  weight: 0,   minSize: 40 * 1024, maxSize: 40 * 1024 },
  ],
});

const $ = (id) => document.getElementById(id);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const enc = new TextEncoder();
const fmtTime = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };
// Pace efficiency: flash time per WORKLOAD op (sequence step), adaptive unit.
const fmtPerOp = (ns, ops) => { if (!(ops > 0)) return '—'; const us = ns / 1000 / ops; return us < 1000 ? `${Math.round(us)} µs/op` : `${(us / 1000).toFixed(2)} ms/op`; };
// Compact workload ops/sec for the Race throughput tag.
const fmtRate = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
function randomBytes(n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(a.subarray(i, Math.min(n, i + 65536)));
  return a;
}

/* ------------------------------------------------------------------------ *
 * COMMAND COMPILER + SANDBOX (ADR-0019)
 *
 * makeSandbox(api) builds the `with`-scope: a Proxy whose `has` trap returns
 * TRUE for every name (so nothing ever falls through to the real global —
 * plain `with(api)` only traps names `api` already HAS, which is why an
 * undeclared `for (i=0;…)` leaks to `window.i` under a naive implementation).
 * `get` resolves api → per-invocation bag → globalThis, in that order — the
 * globalThis forward is mandatory, or Math/JSON/… would read as undefined.
 * `set` always writes an undeclared assignment into the bag, never `api`.
 *
 * `let`/`const`/`var` declared IN the compiled source stay real per-invocation
 * locals — that's native `with` behavior (an inner block-scoped declaration
 * shadows the with-object), not something this Proxy needs to implement.
 * ------------------------------------------------------------------------ */
export function makeSandbox(api) {
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

/**
 * Compile one console line (or an injected button command) into
 * `commandFn = async (api) => result`. Two forms are tried at COMPILE time
 * (a synchronous `new AsyncFunction(...)` call, so a syntax failure never
 * touches the sandbox): first as a single expression (`return (<src>)`, so a
 * bare query like `2+2` or `writeFile()` yields its value), falling back to
 * a plain statement block for multi-statement scripts (`let x = …; for (…) …`)
 * where wrapping in `return (…)` would be a syntax error. Both compile
 * `with(scope){ … }` — sloppy mode is required for `with` to be legal, which
 * is why this uses `new AsyncFunction`, never a strict/module compile.
 *
 * `augment(api)` optionally layers extra convenience bindings (console-only
 * helpers, not part of the backend's per-session api) over the real api
 * before it reaches the sandbox — see buildConsoleApi below. It defaults to
 * the identity so this function is directly testable against a bare stub api,
 * exactly per the ADR-0019 contract.
 */
export function compileCommand(src, augment = (api) => api) {
  let fn;
  try { fn = new AsyncFunction('scope', 'with(scope){ return (\n' + src + '\n); }'); }
  catch { fn = new AsyncFunction('scope', 'with(scope){\n' + src + '\n}'); }
  return async (api) => fn(makeSandbox(augment(api)));
}

// Console-only convenience layered OVER the backend-provided local api (never
// replacing anything the api already defines — `??` only fills gaps). These
// aren't part of the ADR-0019 contract; they're this file's UX surface, kept
// out of the pure compiler above so compileCommand alone stays testable
// against a bare stub.
function buildConsoleApi(api) {
  // print sink: the backend's per-session api provides one (session.js prints to
  // that session's tape); a bare stub api without a sink degrades to a no-op so
  // help()/print() never throw. help() RENDERS the reference through print (its
  // return value alone goes nowhere — the command runner discards it), which is
  // why a typed `help()` previously echoed `> help()` but printed nothing.
  const print = api.print ?? (() => {});
  return {
    ...api,
    text: (s) => enc.encode(s),
    randomBytes,
    print,
    help: api.help ?? (() => { print(HELP_TEXT); return HELP_TEXT; }),
    format: api.format ?? (async () => { await api.fs?.format?.(); await api.fs?.mount?.(); }),
    // The real per-session api (session.js buildLocalApi) provides gc(n) directly,
    // paced/timed/journal-logged exactly like writeFile/readFile/etc — this
    // fallback exists only so a bare test-stub api without gc still works.
    gc: api.gc ?? (async (n = 1) => { let r; for (let i = 0; i < Math.max(1, n | 0); i++) r = await api.fs?.gcStep?.(); return r; }),
    prep: api.prep ?? (() => {}),
  };
}

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

/* ------------------------------------------------------------------------ *
 * BACKEND SEAM — real session.js/lockstep.js by default; a test harness can
 * install globalThis.__flashvisBackend = { createSession, createLockstep }
 * BEFORE this module is imported to run the UI against a stub that matches
 * the ADR-0019 contract, without touching the (parallel-built) real backend
 * or requiring real WASM. Dynamic import keeps production loading identical
 * to a static import — this only adds the override hook.
 * ------------------------------------------------------------------------ */
async function loadBackend() {
  if (globalThis.__flashvisBackend) return globalThis.__flashvisBackend;
  const [sessionMod, lockstepMod] = await Promise.all([import('./session.js'), import('./lockstep.js')]);
  return { createSession: sessionMod.createSession, createLockstep: lockstepMod.createLockstep };
}

boot().catch((e) => {
  console.error(e);
  const el = $('specLive');
  if (el) el.textContent = 'boot failed — ' + (e && e.message || e);
});

async function boot() {
  const { createSession, createLockstep } = await loadBackend();

  const geometry = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };

  const churn = createChurnModel({
    seed: CHURN_SEED,
    targetLiveBytes: CHURN_TARGET_LIVE,
    targetWrittenBytes: CHURN_TARGET_WRITTEN,
    targetSlackBytes: CHURN_TARGET_SLACK,
    forceLargeAfterBytes: CHURN_FORCE_LARGE_AFTER,
    profile: churnProfile(),
    slotCount: 256,
  });
  // The coordinator (ADR-0016/0019) owns the ONE canonical command sequence —
  // sessions never decide what runs next, they only execute what they're handed.
  const coordinator = createLockstep({ churn });

  // Participating sessions (fsId → session) and which one is FOCUSED. Focus is
  // a pure view property (ADR-0017/0019): it changes nothing about state and
  // is never itself logged.
  const sessions = new Map();
  const journalUnsub = new Map();
  let focusedFsId = DEFAULT_FS;
  let activeSession = null;
  let tapeNodes = new Map();   // journal entry id → tape DOM node, for the FOCUSED session only

  async function mkSession(fsId) {
    const s = await createSession(fsId, {
      geometry, container: $('dieStack'), name: FS_REGISTRY[fsId],
    });
    journalUnsub.set(s, s.onJournal((change) => onSessionJournal(s, change)));
    return s;
  }

  $('specLive').textContent = `loading ${Object.values(FS_REGISTRY).join(' + ')} (WASM)…`;
  for (const fsId of Object.keys(FS_REGISTRY)) sessions.set(fsId, await mkSession(fsId));
  coordinator.setSessions([...sessions.values()]);
  coordinator.reset();   // fresh, empty, mounted — silent internal setup, not a tape entry

  // ---- command compiler → broadcast: the ONE path console input, boot
  // logging, and every poke button all go through (ADR-0018/0019). ----
  function injectCommand(src) {
    const commandFn = compileCommand(src, buildConsoleApi);
    return coordinator.broadcast(commandFn, src);
  }

  // ---- focus switch: die/tape/telemetry/legend follow one session; a pure
  // view op, never logged, never touches state (ADR-0017/0018). ----
  function setFocus(fsId) {
    if (activeSession) activeSession.attachInspector(null);
    focusedFsId = fsId;
    activeSession = sessions.get(fsId);
    for (const [id, s] of sessions) s.setActive(id === fsId);
    activeSession.attachInspector($('insp'));
    $('insp').innerHTML = '<span class="hint">Click a sector to inspect it.</span>';
    applyCapsGating(activeSession.caps);
    renderLegend(activeSession);
    renderTapeFull();
    renderGap();
    renderFsSet();
    $('telName').textContent = FS_REGISTRY[fsId];
  }

  // ---- tape (ADR-0018): the focused session's journal, queued/live/done. ----
  function tapeText(e) {
    const icon = e.state === 'queued' ? '⧗ ' : e.state === 'live' ? '▸ ' : '';
    const echo = e.cls === 'in' ? '› ' : '';
    return icon + echo + e.text;
  }
  // GC lines render gray — "there, but in the background" (ADR-0023). GC is not a
  // workload op, so its tape lines are visually demoted while still carrying their
  // flash-time cost (summing every line's time — gray ones included — still
  // reconstructs the flash-time total). The `gc` class is carried STRUCTURALLY on
  // the journal entry: gc()/runGcStep() tag their op with cls 'gc' at the source
  // (session.js), so it flows straight through e.cls — no text matching, and a
  // file named `gc(...)` can never be mistaken for a GC op.
  function tapeLine(e) {
    const el = document.createElement('div');
    el.className = 'line ' + (e.cls || 'out');
    el.dataset.state = e.state || 'done';
    el.dataset.jid = e.id;          // stamp the journal id so the DOM-cap eviction can drop this node's tapeNodes entry
    el.textContent = tapeText(e);
    tapeNodes.set(e.id, el);
    return el;
  }
  function renderTapeFull() {
    const out = $('tape');
    out.innerHTML = '';
    tapeNodes = new Map();
    const entries = (activeSession.journal || []).slice(-400);
    for (const e of entries) out.appendChild(tapeLine(e));
    out.scrollTop = out.scrollHeight;
  }
  function onSessionJournal(session, change) {
    if (session !== activeSession) return;
    const out = $('tape');
    if (change.type === 'clear') {
      renderTapeFull();   // session.journal is now empty — this just paints the empty tape
    } else if (change.type === 'append') {
      out.appendChild(tapeLine(change.entry));
      // Cap the visible tape at 400 lines AND drop each evicted node's tapeNodes
      // entry, so the Map stays bounded like the DOM instead of retaining every
      // line ever appended as a detached node (the auto-workload op-log leak).
      while (out.children.length > 400) {
        const gone = out.removeChild(out.firstChild);
        tapeNodes.delete(Number(gone.dataset.jid));
      }
      out.scrollTop = out.scrollHeight;
    } else {
      const el = tapeNodes.get(change.entry.id);
      if (el) { el.dataset.state = change.entry.state; el.textContent = tapeText(change.entry); }
      else renderTapeFull();   // entry predates this focus session — fall back to a full repaint
    }
  }

  // ---- present-gap header + Catch-up (ADR-0018/0017): driven off `behind`
  // (genuine Race divergence / Race→Pace catch-up) — NEVER off gap>0 alone,
  // so ordinary Pace lockstep (gap normally 0, and even a transient non-zero
  // gap that isn't real lag) never shows it (fix: was showing on gap>0). ----
  function renderGap() {
    const gapEl = $('tapeGap');
    const p = coordinator.pendingFor(activeSession);
    if (!p || !p.behind) { gapEl.classList.add('hidden'); return; }
    const snaps = coordinator.snapshots();
    let leader = null;
    for (const s of snaps) if (!leader || s.stepCursor > leader.stepCursor) leader = s;
    const leadTxt = leader && leader.fsId !== activeSession.fsId ? ` · ${leader.name} leads` : '';
    $('tapeGapText').textContent = `${p.gap} behind present${leadTxt}`;
    gapEl.classList.remove('hidden');
  }
  $('btnCatchup').addEventListener('click', () => { coordinator.setMode('pace'); markMode('pace'); });

  // ---- the standings rail (A1/ADR-0018): per-FS standings AND the focus
  // control, one `.fs` card per participating FS (all registered, always —
  // A2), built into the full-width #fsSet grid under the title sentence;
  // click a card to focus it.
  function fsCard(fsId) {
    const btn = document.createElement('button');
    btn.className = 'fs'; btn.id = 'fsCard-' + fsId; btn.dataset.fs = fsId;
    btn.setAttribute('aria-pressed', String(fsId === focusedFsId));
    btn.innerHTML =
      `<span class="fs-top"><span class="fs-name">${FS_REGISTRY[fsId]}</span><span class="fs-run" title="running"></span></span>` +
      `<span class="fs-vital"><b class="fs-v" id="fsV-${fsId}">—</b><i class="fs-l" id="fsL-${fsId}">—</i><span class="fs-hold" id="fsHold-${fsId}">◷ holding</span></span>` +
      `<span class="fs-bar"><span class="track"><i id="fsBar-${fsId}"></i></span><span class="tag" id="fsTag-${fsId}">ops/s</span></span>`;
    btn.addEventListener('click', () => { if (sessions.has(fsId) && fsId !== focusedFsId) setFocus(fsId); });
    return btn;
  }
  // Tracked explicitly (not inferred from a getElementById probe) — a card is
  // built once per participating fsId and reused on every subsequent render.
  const fsSetBuilt = new Set();
  function renderFsSet() {
    const wrap = $('fsSet');
    const snaps = coordinator.snapshots();
    const mode = coordinator.mode;
    // Per-FS "goodness": higher = better = fuller bar = leader color, in BOTH
    // modes — only the underlying quantity flips. Race = workload throughput
    // (ops/sec). Pace = efficiency (workload ops per unit flash-time, the inverse
    // of ms/op): in lockstep Pace every FS shares the same ops/sec, so only the
    // per-op flash cost separates them, and less time per op reads as the
    // fuller/leading bar.
    const goodOf = (s) => (mode === 'race' ? (s.opsPerSec || 0) : (s.simNs > 0 ? s.fileOpCount / s.simNs : 0));
    const leaderGood = snaps.reduce((m, s) => Math.max(m, goodOf(s)), 0);
    for (const snap of snaps) {
      if (!fsSetBuilt.has(snap.fsId)) {
        wrap.appendChild(fsCard(snap.fsId));
        fsSetBuilt.add(snap.fsId);
      }
      const card = $('fsCard-' + snap.fsId);
      card.classList.toggle('on', snap.fsId === focusedFsId);
      card.setAttribute('aria-pressed', String(snap.fsId === focusedFsId));
      const good = goodOf(snap);
      card.classList.toggle('leader', leaderGood > 0 && good >= leaderGood);
      // Parked-waiting indicator: pace "holding" (waiting on the laggard) OR race
      // "waiting" (ahead of the shared clock, stalled until it climbs up). Same
      // visual, mode-aware label.
      card.classList.toggle('waiting', !!snap.holding || !!snap.stalled);
      $('fsHold-' + snap.fsId).textContent = mode === 'race' ? '◷ waiting' : '◷ holding';
      // Mode-aware vital: RACE = workload ops done (more wins) = fileOpCount, the
      // high-level FILE ops this FS got through in the shared flash-time budget
      // (ADR-0023 — a whole console loop counts each inner op, and GC no-ops never
      // count); PACE = flash time (less wins). The bar rates goodness (throughput /
      // efficiency); the tag carries the live number — ops/sec in Race, ms/op in
      // Pace. Flash ops (reads/programs/erases) are the COST view (the die + Flash
      // Stats), deliberately not the "ops" the compare modes measure.
      $('fsV-' + snap.fsId).textContent = mode === 'race' ? String(snap.fileOpCount) : fmtTime(snap.simNs);
      $('fsL-' + snap.fsId).textContent = mode === 'race' ? 'ops done' : 'flash time';
      $('fsBar-' + snap.fsId).style.width = (leaderGood > 0 ? Math.round((good / leaderGood) * 100) : 0) + '%';
      $('fsTag-' + snap.fsId).textContent = mode === 'race' ? `${fmtRate(snap.opsPerSec || 0)} ops/s` : fmtPerOp(snap.simNs, snap.fileOpCount);
    }
  }

  // ---- die-adjacent legend chip-row (ADR-0018): per-FS class descriptor —
  // shared baseline plus per-driver extras (below), without reworking the
  // row's structure. ----
  // Every color the die can display, in TWO groups. STATES are matte FILLS (a
  // cell's stored condition). OPS are GLOWS (marked `glow`) the die rides over a
  // cell, so their swatch renders as a hollow ring + halo, no fill; the group
  // includes the read+program MIX (--mix, the overlap color the dual-channel heat
  // renders when a cell is read and programmed at once).
  // Per-FS extra STATE classes (the descriptor's per-driver hook): fsId → chips
  // appended to the shared baseline when that FS is focused. FAT+WL declares
  // class 4 — the wear_levelling FTL's own sectors (config/state/dummy) — shown
  // as a SHADE of the metadata color (a layer of metadata, not a new kind).
  const FS_EXTRA_STATES = {
    fatfs: [{ cls: 'wl', word: 'WL', title: "the FTL's own bookkeeping sectors — a shade of metadata" }],
  };
  function legendFor(session) {
    return [
      { label: 'States', items: [
        { cls: 'erased', word: 'Erased', title: '0xFF, nothing written' },
        { cls: 'prog', word: 'Live', title: 'fill = bytes programmed' },
        { cls: 'obsolete', word: 'Obsolete', title: 'reclaimable garbage' },
        { cls: 'index', word: 'Metadata', title: 'index + records' },
        ...(FS_EXTRA_STATES[session.fsId] ?? []),
      ] },
      { label: 'Ops', items: [
        { cls: 'read', word: 'Reading', title: 'XIP, no wear', glow: true },
        { cls: 'program', word: 'Programming', title: '1 to 0, in progress', glow: true },
        { cls: 'mix', word: 'Read + prog', title: 'one cell read and programmed at once', glow: true },
        { cls: 'erase', word: 'Erasing', title: 'sector to 0xFF', glow: true },
      ] },
    ];
  }
  function renderLegend(session) {
    const host = $('legendChips');
    host.innerHTML = '';
    for (const group of legendFor(session)) {
      const row = document.createElement('div');
      row.className = 'legend-row'; row.setAttribute('role', 'list'); row.setAttribute('aria-label', group.label);
      const lbl = document.createElement('span');
      lbl.className = 'legrow-label'; lbl.setAttribute('aria-hidden', 'true'); lbl.textContent = group.label;
      row.appendChild(lbl);
      for (const c of group.items) {
        const chip = document.createElement('div');
        chip.className = 'chip'; chip.tabIndex = 0; chip.setAttribute('role', 'listitem');
        chip.innerHTML = `<span class="sw ${c.cls}${c.glow ? ' glow' : ''}"></span>${c.word}<span class="chip-hint">${c.title}</span>`;
        row.appendChild(chip);
      }
      host.appendChild(row);
    }
  }

  // ---- static device geometry line (A5): replaces the old dynamic
  // .stagefoot; built once from the same geometry #specGeo is sourced from
  // (the dynamic stats that lived here moved into Flash Stats — A6). ----
  function renderGeo() {
    const kb = (activeSession.device.size / 1024) | 0;
    const pagesPerSector = geometry.sectorSize / geometry.pageSize;
    $('geoLine').innerHTML =
      `<span><b>${kb} KB</b> NOR</span>` +
      `<span><b>${geometry.sectorCount} × ${pagesPerSector}</b> pages</span>` +
      `<span><b>${geometry.sectorSize / 1024} KB</b> sectors</span>` +
      `<span><b>${geometry.pageSize} B</b> program page</span>`;
  }

  setFocus(DEFAULT_FS);
  $('specGeo').textContent = `${(activeSession.device.size / 1024) | 0} KB · ${geometry.sectorCount}×${geometry.sectorSize / 1024} KB · ESP32-S3 timing`;
  $('specLive').textContent = 'formatted + mounted — empty and paused';
  renderGeo();

  // ---- FIX: boot logs (ADR-0018) — run help() then format() as BROADCAST
  // commands (not a one-off print to a single shared log) so every
  // participating session's OWN tape shows both, not just the focused one. ----
  injectCommand('help()');
  injectCommand('format()');

  setInterval(() => activeSession.refreshHUD($), 160);
  setInterval(() => activeSession.refreshLiveness($), 250);
  setInterval(() => { renderFsSet(); renderGap(); }, 250);

  // ---- CS (pin 1) activity indicator: the fast, twitchy per-frame twin of
  // the card's holding/stalled readout (ADR-0020's waitStates(), read fresh
  // every frame — never cached). Cheap (no WASM/liveness walk), so a plain
  // rAF loop is fine; not folded into the 250ms renderFsSet interval because
  // that cadence would flatten the RACE burst-flicker this pin exists to
  // show. Reflects whichever fs is FOCUSED, re-read every frame since focus
  // can change under it. Guarded so a headless/test DOM without rAF (or
  // before `coordinator` exists) never throws. ----
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  const pinCS = $('pinCS');
  if (pinCS) {
    (function csTick() {
      const waiting = !!coordinator.waitStates()[focusedFsId];
      pinCS.classList.toggle('cs-active', !waiting);
      pinCS.classList.toggle('cs-paused', waiting);
      raf(csTick);
    })();
  }

  // ---- Run/Pause, Step: act on the WHOLE participating set via the coordinator. ----
  const setRunning = (v) => {
    if (v) coordinator.start(); else coordinator.stop();
    $('runLabel').textContent = v ? 'Pause' : 'Run';
    $('btnRun').querySelector('.dot').style.background = v ? 'currentColor' : '#241a06';
  };
  setRunning(false);

  // ---- Race / Pace mode: an inline WHEEL (A1a), not a segmented control —
  // the active phrase sits on the sentence baseline, the other mode peeks
  // below (faded, tilted back); click rotates the peek up. Canonical
  // pace/race stay under the hood; wired straight to coordinator.setMode. ----
  const modeWheel = $('modeWheel');
  const modeOpts = { pace: $('modeOpt-pace'), race: $('modeOpt-race') };
  const markMode = (m) => {
    for (const [k, el] of Object.entries(modeOpts)) {
      el.classList.toggle('active', k === m);
      el.classList.toggle('peek', k !== m);
    }
    modeWheel.dataset.mode = m;
    modeWheel.setAttribute('aria-checked', String(m === 'race'));
    modeWheel.setAttribute('aria-label', `comparing ${m === 'race' ? 'most ops in equal time' : 'least time for equal ops'}; click to switch`);
    renderFsSet();
  };
  markMode(coordinator.mode);
  modeWheel.addEventListener('click', () => {
    const m = coordinator.mode === 'race' ? 'pace' : 'race';
    coordinator.setMode(m); markMode(m); renderGap();
  });

  // ---- controls: Run/Step direct; every poke button INJECTS a console
  // command (ADR-0018 — "a button that can't be expressed as a console
  // command has no home"), through the exact same compile+broadcast path
  // typing at the prompt uses. ----
  $('btnRun').addEventListener('click', () => setRunning(!coordinator.running));
  $('btnStep').addEventListener('click', () => coordinator.step());
  $('btnWrite').addEventListener('click', () => injectCommand('writeFile()'));
  $('btnRead').addEventListener('click', () => injectCommand('readFile()'));
  $('btnLs').addEventListener('click', () => injectCommand('ls()'));
  $('btnDelete').addEventListener('click', () => injectCommand('deleteFile()'));
  $('btnGC').addEventListener('click', () => injectCommand('gc()'));
  $('btnFormat').addEventListener('click', () => injectCommand('format()'));

  // ---- Reset (header): return the WHOLE sim to its just-booted state without
  // a page reload — stop, re-format/mount every participating FS + wipe the
  // coordinator's sequence/cursors/clock (coordinator.reset(), the SAME call
  // boot() makes), clear each session's tape, then replay the boot log
  // (help()/format()) exactly like boot() does so the tape reads identically
  // to a fresh load. Die glow/fills/wear and the flash-time/op stats all
  // clear for free: freshFormat() → runner.format() → device.reset(), which
  // viz.js already treats as a full repaint (see the 'reset' event handling
  // it and refreshHUD/refreshLiveness read off of). ----
  $('btnReset')?.addEventListener('click', () => {
    setRunning(false);
    coordinator.reset();
    for (const s of sessions.values()) s.clearJournal();
    renderFsSet();
    renderGap();
    activeSession.refreshHUD($);
    activeSession.refreshLiveness($);
    $('specLive').textContent = 'formatted + mounted — empty and paused';
    injectCommand('help()');
    injectCommand('format()');
  });

  // slider 0..100 → sim-ns per real-ms on a log scale. Real flash time = 1e6.
  function applySpeed(v) {
    let scale, label;
    if (v >= 100) { scale = Infinity; label = 'max · no delay'; }
    else {
      const lo = Math.log10(3000), hi = Math.log10(1e8);
      scale = Math.pow(10, lo + (hi - lo) * (v / 99));
      const x = scale / 1e6;
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

  $('heat').addEventListener('change', (e) => { for (const s of sessions.values()) s.setHeatmap(e.target.checked); });

  // ---- console input: one shared prompt; Enter compiles + broadcasts the
  // whole line as ONE atomic command (ADR-0019). History persisted like before. ----
  const HKEY = 'flashvis.console.history', HMAX = 20;
  const store = typeof window !== 'undefined' ? window.localStorage : null;

  // ---- palette switcher (color themes): flip [data-theme] on :root and every
  // session re-sources its op-glow + erase colors, so the LIVE heat recolors too
  // (not just the static state fills). The legend chips read the theme vars
  // directly, so they re-skin for free. The switcher is a radiogroup of one chip
  // per theme; each chip previews ITS OWN five colors (read/write/mix/erase/live)
  // via the .tprev-* CSS, so a palette is visible before you pick it. The choice
  // is persisted, so a reload keeps the chosen palette. ----
  const THEME_KEY = 'flashvis.theme';
  const THEME_LIST = [
    { id: 'aurora', name: 'Aurora Signal' },
    { id: 'magma', name: 'Magma' },
    { id: 'uv', name: 'Ultraviolet Lab' },
    { id: 'phosphor', name: 'Terminal Phosphor' },
    { id: 'deepsea', name: 'Deep Sea' },
    { id: 'blueprint', name: 'Cyanotype Blueprint' },
  ];
  const THEMES = THEME_LIST.map((t) => t.id);
  const themeChipEls = new Map();   // theme id -> chip button
  const applyTheme = (t) => {
    if (!THEMES.includes(t)) t = 'aurora';
    document.documentElement.dataset.theme = t;
    for (const [id, el] of themeChipEls) {
      const on = id === t;
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', String(on));
      el.tabIndex = on ? 0 : -1;    // roving tabindex: only the selected chip is a tab stop
    }
    const nameEl = $('themeName');
    if (nameEl) nameEl.textContent = (THEME_LIST.find((x) => x.id === t) || {}).name || '';
    try { store?.setItem(THEME_KEY, t); } catch { /* no storage / private mode */ }
    for (const s of sessions.values()) s.refreshTheme?.();
  };
  // Build one preview chip per theme into #themeChips.
  const themeHost = $('themeChips');
  if (themeHost) {
    themeHost.innerHTML = '';
    for (const { id, name } of THEME_LIST) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `theme-chip tprev-${id}`;
      b.dataset.themeVal = id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', `${name} palette`);
      b.title = name;
      b.innerHTML = '<span class="tc-dots" aria-hidden="true">' +
        '<i class="d-read"></i><i class="d-prog-op"></i><i class="d-mix"></i><i class="d-erase"></i><i class="d-live"></i></span>';
      b.addEventListener('click', () => applyTheme(id));
      themeHost.appendChild(b);
      themeChipEls.set(id, b);
    }
    // arrow keys move the selection (and focus) within the radiogroup
    themeHost.addEventListener('keydown', (e) => {
      const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
      const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      if (!back && !fwd) return;
      e.preventDefault();
      const cur = THEMES.indexOf(document.documentElement.dataset.theme);
      const next = THEMES[(cur + (fwd ? 1 : -1) + THEMES.length) % THEMES.length];
      applyTheme(next);
      themeChipEls.get(next)?.focus?.();
    });
  }
  let savedTheme = 'aurora';
  try { savedTheme = store?.getItem(THEME_KEY) || 'aurora'; } catch { /* ignore */ }
  applyTheme(savedTheme);
  const loadHist = () => { try { const h = JSON.parse(store.getItem(HKEY)); return Array.isArray(h) ? h : []; } catch { return []; } };
  const saveHist = () => { try { store.setItem(HKEY, JSON.stringify(cmdHist)); } catch { /* no storage / private mode */ } };
  let cmdHist = store ? loadHist() : [];
  let hidx = cmdHist.length;
  let draft = '';
  const input = $('terminput');
  const setInput = (v) => { input.value = v; input.setSelectionRange?.(v.length, v.length); };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const src = input.value.trim(); if (!src) return;
      input.value = '';
      if (cmdHist[cmdHist.length - 1] !== src) {
        cmdHist.push(src);
        if (cmdHist.length > HMAX) cmdHist = cmdHist.slice(-HMAX);
        saveHist();
      }
      hidx = cmdHist.length; draft = '';
      injectCommand(src);
    } else if (e.key === 'ArrowUp') {
      if (!cmdHist.length) return;
      e.preventDefault();
      if (hidx === cmdHist.length) draft = input.value;
      hidx = Math.max(0, hidx - 1);
      setInput(cmdHist[hidx]);
    } else if (e.key === 'ArrowDown') {
      if (hidx === cmdHist.length) return;
      e.preventDefault();
      hidx += 1;
      setInput(hidx === cmdHist.length ? draft : cmdHist[hidx]);
    }
  });

  $('bootStatus').textContent = 'ready';
}

// Caps-gating (ADR-0011/0015): hide controls the FOCUSED FS disclaims instead
// of showing a dead/no-op control.
function applyCapsGating(caps) {
  const toggle = (id, hide) => { const e = $(id); if (e) e.classList.toggle('hidden', hide); };
  toggle('ctlGc', !(caps & FF_CAP_GC));
  toggle('statGarbage', !(caps & FF_CAP_LIVE_MAP));
  toggle('utilBar', !(caps & FF_CAP_LIVE_MAP));
}
