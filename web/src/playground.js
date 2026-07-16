/*
 * Playground: the console command-compiler + comparison UI, rewired onto the
 * ADR-0024 worker-per-session wire.
 *
 * WHAT CHANGED FROM THE PRE-0024 PLAYGROUND
 *   - Each session is now a WORKER behind a Port. We spawn one Worker per FS,
 *     wrap it in a session-PROXY (web/src/session-proxy.js, the SINGLE owner of
 *     that Port, it receives GRANT_ACK/FRAME/TELEMETRY), and hand the proxies
 *     to the coordinator (web/src/lockstep.js) via setSessions([...proxies]).
 *   - The die renders from PULLED FRAMEs, not synchronous device reads: a rAF
 *     loop calls focusedProxy.pull(sel) then viz.applyFrame(frame) for the ONE
 *     focused session (ADR-0017 focus-is-view; unfocused sessions stream
 *     nothing). Each session owns a COMPLETE separate UI state copy (its own
 *     viz+die, pull cursors and journal); focus switch swaps die VISIBILITY and
 *     re-renders the shared stats/tape from the focused session's own copy:
 *     no singleton is repointed, so no FS's data bleeds into another (RC-A).
 *   - HUD + compare strip read TELEMETRY (proxy.telemetry) + coordinator
 *     snapshots(), the ~250ms heartbeat, for EVERY session at once.
 *   - The tape (console scrollback) is WORKER-OWNED and read via a journal
 *     PULL (frame.journal / journalHead), not flipped by the coordinator.
 *   - broadcast() ships RAW console SOURCE TEXT the worker compiles in its
 *     ADR-0019 sandbox, not a live closure: a closure can't cross the thread.
 *
 * The worker's FRAME payload is protocol.js-conformant (FrameMsg: heat.read/
 * prog, shown.pages/wear, liveMap.version/classes, erase/reset EventEntries in
 * `events`), so the render loop feeds the pulled FRAME straight to viz.js,
 * no field remap.
 */
import { createChurnModel, CHURN_CLASS } from './churn.js';
import { createLockstep } from './lockstep.js';
import { createSessionProxy } from './session-proxy.js';
import { createViz } from './viz.js';
import { FF_CAP_GC, FF_CAP_LIVE_MAP } from './runner.js';

// FS registry (ADR-0015): fsId → display name. All live from page load
// (ADR-0017).
const FS_REGISTRY = {
  fastffs: 'FASTFFS', littlefs: 'LittleFS', spiffs: 'SPIFFS', jesfs: 'JesFS',
  fatfs: 'FAT+WL',
};
const DEFAULT_FS = 'fastffs';
// A3: caps ride the wire now (TelemetryMsg.caps, ADR-0011 ff_caps single
// source of truth). Until the first TELEMETRY for a session lands (or if a
// worker never emits it), fall back to "everything capable" (all bits set)
// so we fail OPEN: a missing/stale caps read must not incorrectly hide a
// control the FS actually supports.
const CAPS_FALLBACK = FF_CAP_GC | FF_CAP_LIVE_MAP;

// Auto-workload churn config, scaled to the 256 KiB (4096×64) device.
const CHURN_SEED = 0x00c0ffee;
const CHURN_TARGET_LIVE = 96 * 1024;
const CHURN_TARGET_SLACK = 16 * 1024;
const CHURN_TARGET_WRITTEN = 0xffffffff;
const CHURN_FORCE_LARGE_AFTER = 0xffffffff;
const churnProfile = () => ({
  namePrefix: 'w',
  replacePercent: 25,
  protectFirstLarge: false,
  classes: [
    { key: CHURN_CLASS.SMALL,  name: 'small',  weight: 800, minSize: 2 * 1024,  maxSize: 6 * 1024 },
    { key: CHURN_CLASS.MEDIUM, name: 'medium', weight: 150, minSize: 8 * 1024,  maxSize: 20 * 1024 },
    { key: CHURN_CLASS.LARGE,  name: 'large',  weight: 0,   minSize: 40 * 1024, maxSize: 40 * 1024 },
  ],
});

const $ = (id) => document.getElementById(id);
const fmtTime = (ns) => { const ms = ns / 1e6; return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`; };
const fmtPerOp = (ns, ops) => { if (!(ops > 0)) return 'n/a'; const us = ns / 1000 / ops; return us < 1000 ? `${Math.round(us)} µs/op` : `${(us / 1000).toFixed(2)} ms/op`; };
const fmtRate = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/* ------------------------------------------------------------------------ *
 * COMMAND SOURCE (ADR-0024 §4: commands ship as RAW SOURCE)
 *
 * A console line ships to the worker AS TYPED: bare statements (`help()`,
 * `writeFile('cfg.bin')`, `for (i=0;i<3;i++) ls()`). The worker (session-
 * worker.js makeSandbox/compileSource) wraps it in its ADR-0019 sloppy-mode
 * `with(scope){…}` sandbox whose inner `api` provides every console helper
 * (writeFile/…/format/text/randomBytes/help/print) and echoes the source to
 * the worker-owned tape. Nothing is pre-wrapped here: a live closure can't
 * cross the thread, and double-wrapping (shipping a whole async(api)=>{} that
 * the worker's own `with` would merely RETURN, never call) leaves the body
 * unexecuted. The seed for any random draw rides the entry (I7 determinism).
 * ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ *
 * WORKER CONNECTION SEAM: production spawns a real Worker; a headless test
 * installs globalThis.__flashvisWorkerConnect to wire the mock transport +
 * an in-realm worker host with a stub runner (no real WASM). Returns
 * `{ port, terminate }`; the proxy owns port.onmessage.
 * ------------------------------------------------------------------------ */
function connectWorker(fsId, meta) {
  if (globalThis.__flashvisWorkerConnect) return globalThis.__flashvisWorkerConnect(fsId, meta);
  const worker = new Worker(new URL('./session-worker.js', import.meta.url), { type: 'module' });
  return { port: worker, terminate: () => worker.terminate() };
}

boot().catch((e) => {
  console.error(e);
  const el = $('specLive');
  if (el) el.textContent = 'boot failed: ' + (e && e.message || e);
});

async function boot() {
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
  const coordinator = createLockstep({ churn });

  // RC-A (ADR-0024 §7 PROPOSAL): UI state is a COMPLETE separate copy PER
  // SESSION: its own viz+die, its own pull cursors, its own journal copy.
  // THE INVARIANT: no cross-session data bleed, a session's pulled frame /
  // journal only ever applies to ITS OWN state+die, never overlaid onto
  // another. Nothing shared is repointed on a focus switch (that singleton
  // repoint was the RC-A clobber); the ONE legitimate switch-time mutation is
  // each session's own `pulling` participation field (§7: "focus = which
  // workers the UI pulls AND what they ask for"). `sessions` holds that
  // per-session state, keyed by fsId; `focusedFsId` names the visible one.
  const sessions = new Map();
  let focusedFsId = DEFAULT_FS;

  // A3: gate controls off the FOCUSED session's real caps bitmask (falls
  // back to "everything capable" if telemetry hasn't reported caps yet).
  function capsFor(fsId) {
    const c = sessions.get(fsId)?.proxy?.telemetry?.caps;
    return typeof c === 'number' ? c : CAPS_FALLBACK;
  }
  const proxyOf = (fsId) => sessions.get(fsId).proxy;
  const fviz = () => sessions.get(focusedFsId).viz;   // the focused session's own renderer

  $('specLive').textContent = `loading ${Object.values(FS_REGISTRY).join(' + ')} (WASM)…`;

  // ---- spawn one worker per FS, wrap in a proxy, and give EACH session its
  // OWN viz + die node (ADR-0024 §7 PROPOSAL). All N dice mount into #dieStack;
  // focus swaps VISIBILITY only (the `.hidden` class): a hidden die keeps its
  // own rendered state and is NEVER re-rendered with another FS's data, so a
  // switch fires no CSS transitions. The flash-stats panel, journal, inspector
  // and legend are ONE shared DOM, re-rendered from the focused session's own
  // state copy on switch. ----
  const stack = $('dieStack');
  for (const fsId of Object.keys(FS_REGISTRY)) {
    const meta = { fsId, name: FS_REGISTRY[fsId], geometry };
    const { port, terminate } = connectWorker(fsId, meta);
    const proxy = createSessionProxy(port, meta);
    const viz = createViz(geometry);
    const dieEl = document.createElement('div');
    dieEl.className = 'die' + (fsId === focusedFsId ? '' : ' hidden');
    stack.appendChild(dieEl);
    viz.mountDie(dieEl);
    viz.attachInspector($('insp'));   // ONE shared inspector; only the visible die is clickable
    sessions.set(fsId, {
      fsId, proxy, terminate, viz, dieEl,
      // pull cursors (ADR-0024 §7), per session. liveMapSince:-1 forces a full
      // current liveMap on the first (fresh) pull.
      liveMapSince: -1, journalSince: 0, eventsSince: 0,
      // attachedFresh: the next pull seeds cursors to the session's OWN current
      // heads (full liveMap + head-only events → NO historical erase replay).
      attachedFresh: true,
      lastFrame: null,                // last processed proxy.frame (dedup; ignores stale leftovers)
      journalEntries: [],             // this session's OWN tape scrollback
      tapeSeen: new Set(),
      pulling: fsId === focusedFsId,  // §7 participation: only the focused session is pulled
    });
  }
  const proxies = [...sessions.values()].map((s) => s.proxy);

  // setSessions init()'s every worker (INIT builds a fresh chip at epoch 0).
  coordinator.setSessions(proxies);

  // ---- command source → broadcast (the ONE path console/boot/buttons take) ----
  function injectCommand(userSrc) {
    return coordinator.broadcast(userSrc, userSrc);   // RAW source; worker compiles it
  }

  // ---- focus switch (ADR-0017 focus-is-view): a PURE view op, never logged,
  // never touches worker state. It mutates NO shared UI state: it swaps die
  // VISIBILITY, flips per-session pull participation, and re-renders the shared
  // stats/journal/legend DOM FROM the newly-focused session's OWN state copy.
  // The focused session re-attaches FRESH (§7): the next pull seeds its cursors
  // to its own current heads: full liveMap snapshot + head-only events, so no
  // historical erase sweep replays and no other FS's data can bleed in. ----
  function setFocus(fsId) {
    focusedFsId = fsId;
    // The ONE legitimate switch-time mutation (§7): pull participation. Only the
    // focused session is pulled; hidden sessions pull nothing and keep their own
    // die frozen at its last render (visibility-swap, not a re-render).
    for (const st of sessions.values()) {
      st.pulling = (st.fsId === fsId);
      st.dieEl.classList.toggle('hidden', st.fsId !== fsId);
    }
    const st = sessions.get(fsId);
    st.attachedFresh = true;
    st.liveMapSince = -1;               // force a full CURRENT liveMap on the fresh pull
    st.lastFrame = st.proxy.frame;      // ignore any stale leftover frame; wait for the fresh one
    // Re-render the SHARED tape DOM from THIS session's own journal copy.
    renderTapeFromState(st);
    $('insp').innerHTML = '<span class="hint">Click a sector to inspect it.</span>';
    applyCapsGating(capsFor(fsId));
    renderLegend(fsId);
    renderFsSet();
    $('telName').textContent = FS_REGISTRY[fsId];
  }

  // ---- tape: worker-owned journal, read via journal PULL (frame.journal) ----
  function tapeClass(e) {
    if (e.kind === 'gc') return 'out gc';
    if (e.kind === 'done' && /error/i.test(e.text || '')) return 'err';
    if (typeof e.text === 'string' && e.text.startsWith('›')) return 'in';
    return 'out';
  }
  function appendTapeEntry(e) {
    // internal command lifecycle markers carry text 'command', not user-facing.
    if ((e.kind === 'started' || e.kind === 'done') && e.text === 'command') return;
    const out = $('tape');
    const el = document.createElement('div');
    el.className = 'line ' + tapeClass(e);
    el.dataset.jid = e.id;
    el.textContent = e.text;
    out.appendChild(el);
    while (out.children.length > 400) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }
  // Ingest a pulled journal into the focused session's OWN scrollback copy
  // (deduped by monotonic id) and append the new lines to the shared tape DOM.
  function ingestJournal(st, journal) {
    if (!journal) return;
    for (const e of journal) {
      if (st.tapeSeen.has(e.id)) continue;
      st.tapeSeen.add(e.id);
      st.journalEntries.push(e);
      if (st.journalEntries.length > 400) st.journalEntries.shift();
      appendTapeEntry(e);
    }
  }
  // Re-render the shared tape DOM from a session's own journal copy (focus
  // switch): the die/stats/journal all follow one session's OWN state, never a
  // clobbered singleton.
  function renderTapeFromState(st) {
    const out = $('tape');
    out.innerHTML = '';
    for (const e of st.journalEntries) appendTapeEntry(e);
  }

  // ---- the standings rail (ADR-0018): one .fs card per FS, click to focus ----
  function fsCard(fsId) {
    const btn = document.createElement('button');
    btn.className = 'fs'; btn.id = 'fsCard-' + fsId; btn.dataset.fs = fsId;
    btn.setAttribute('aria-pressed', String(fsId === focusedFsId));
    btn.innerHTML =
      `<span class="fs-top"><span class="fs-name">${FS_REGISTRY[fsId]}</span><span class="fs-run" title="running"></span></span>` +
      `<span class="fs-vital">` +
        `<span class="fs-stat"><b class="fs-v" id="fsTime-${fsId}">·</b><i class="fs-l">flash time</i></span>` +
        `<span class="fs-stat"><b class="fs-v" id="fsOps-${fsId}">·</b><i class="fs-l">ops</i></span>` +
        `<span class="fs-hold" id="fsHold-${fsId}">◷ holding</span>` +
      `</span>` +
      `<span class="fs-bar"><span class="track"><i id="fsBar-${fsId}"></i></span><span class="tag" id="fsTag-${fsId}">ops/s</span></span>`;
    btn.addEventListener('click', () => { if (sessions.has(fsId) && fsId !== focusedFsId) setFocus(fsId); });
    return btn;
  }
  const fsSetBuilt = new Set();
  function renderFsSet() {
    const wrap = $('fsSet');
    const snaps = coordinator.snapshots();
    const mode = coordinator.mode;
    const goodOf = (s) => (mode === 'race' ? (s.opsPerSec || 0) : (s.flashTimeNs > 0 ? s.fileOpCount / s.flashTimeNs : 0));
    const leaderGood = snaps.reduce((m, s) => Math.max(m, goodOf(s)), 0);
    for (const snap of snaps) {
      if (!fsSetBuilt.has(snap.fsId)) { wrap.appendChild(fsCard(snap.fsId)); fsSetBuilt.add(snap.fsId); }
      const card = $('fsCard-' + snap.fsId);
      card.classList.toggle('on', snap.fsId === focusedFsId);
      card.setAttribute('aria-pressed', String(snap.fsId === focusedFsId));
      const good = goodOf(snap);
      card.classList.toggle('leader', leaderGood > 0 && good >= leaderGood);
      // B3: the label always reads "holding", it's the debounced `holding`
      // signal (spec/ui.md "Holding" card) that drives VISIBILITY (the
      // `.fs.waiting` class toggle below, in the waitStates loop), not the
      // mode. A mode-hardcoded "waiting" string could show even when
      // nothing is actually waiting.
      // Both totals ALWAYS show, in both modes (spec/ui.md "FS cards"): flash
      // time (execution counter simNs) first, then ops (fileOpCount), equal
      // weight. Only the bottom rate + leader bar switch by mode.
      $('fsTime-' + snap.fsId).textContent = fmtTime(snap.simNs);
      $('fsOps-' + snap.fsId).textContent = String(snap.fileOpCount);
      $('fsBar-' + snap.fsId).style.width = (leaderGood > 0 ? Math.round((good / leaderGood) * 100) : 0) + '%';
      $('fsTag-' + snap.fsId).textContent = mode === 'race' ? `${fmtRate(snap.opsPerSec || 0)} ops/s` : fmtPerOp(snap.simNs, snap.fileOpCount);
    }
  }

  // ---- present-gap header (ADR-0017/0018), off pendingFor().behind ----
  function renderGap() {
    const gapEl = $('tapeGap');
    const p = coordinator.pendingFor(proxyOf(focusedFsId));
    if (!p || !p.behind) { gapEl.classList.add('hidden'); return; }
    const snaps = coordinator.snapshots();
    let leader = null;
    for (const s of snaps) if (!leader || s.stepCursor > leader.stepCursor) leader = s;
    const leadTxt = leader && leader.fsId !== focusedFsId ? ` · ${leader.name} leads` : '';
    $('tapeGapText').textContent = `${p.gap} behind present${leadTxt}`;
    gapEl.classList.remove('hidden');
  }
  $('btnCatchup').addEventListener('click', () => { coordinator.setMode('pace'); markMode('pace'); });

  // ---- die-adjacent legend ----
  const FS_EXTRA_STATES = {
    fatfs: [{ cls: 'wl', word: 'WL', title: 'metadata the FTL itself writes (config/state), a shade of metadata' }],
  };
  function legendFor(fsId) {
    const erasedTitle = fsId === 'fatfs'
      ? '0xFF, nothing written, or slack: allocated but carrying no data'
      : '0xFF, nothing written';
    return [
      { label: 'States', items: [
        { cls: 'erased', word: 'Erased', title: erasedTitle },
        { cls: 'prog', word: 'Live', title: 'fill = bytes programmed' },
        { cls: 'obsolete', word: 'Obsolete', title: 'reclaimable garbage' },
        { cls: 'index', word: 'Metadata', title: 'index + records' },
        ...(FS_EXTRA_STATES[fsId] ?? []),
      ] },
      { label: 'Ops', items: [
        { cls: 'read', word: 'Reading', title: 'XIP, no wear', glow: true },
        { cls: 'program', word: 'Programming', title: '1 to 0, in progress', glow: true },
        { cls: 'mix', word: 'Read + prog', title: 'one cell read and programmed at once', glow: true },
        { cls: 'erase', word: 'Erasing', title: 'sector to 0xFF', glow: true },
      ] },
    ];
  }
  function renderLegend(fsId) {
    const host = $('legendChips');
    host.innerHTML = '';
    for (const group of legendFor(fsId)) {
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

  function renderGeo() {
    const kb = (geometry.sectorSize * geometry.sectorCount / 1024) | 0;
    const pagesPerSector = geometry.sectorSize / geometry.pageSize;
    $('geoLine').innerHTML =
      `<span><b>${kb} KB</b> NOR</span>` +
      `<span><b>${geometry.sectorCount} × ${pagesPerSector}</b> pages</span>` +
      `<span><b>${geometry.sectorSize / 1024} KB</b> sectors</span>` +
      `<span><b>${geometry.pageSize} B</b> program page</span>`;
  }

  // ---- HUD (Flash Stats) from focused TELEMETRY + focused FRAME metrics.
  // NB (LANE-REPORT): device erase/read counts and programBytes/hostBytes
  // (write-amp) are NOT emitted by the worker today, so those fields show
  // 'n/a'. ----
  function refreshHUD() {
    const t = proxyOf(focusedFsId).telemetry;
    const m = fviz().metrics();
    const lc = t.livenessCounts || { live: 0, obsolete: 0, metadata: 0 };
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('sAmp', t.wa != null ? t.wa.toFixed(1) + '×' : 'n/a');
    set('fAmp', t.wa != null ? t.wa.toFixed(1) + '×' : 'n/a');
    set('fProg', Math.round(100 * m.displayedBytes / m.capacityBytes) + '%');
    set('fFree', m.erasedPages);
    set('sFiles', t.fsinfo ? t.fsinfo.files : 0);
    set('sBytes', t.fsinfo ? (t.fsinfo.bytes / 1024).toFixed(1) + ' KB' : '0.0 KB');
    set('fSim', fmtTime(t.simNs || 0));
    const programmed = lc.live + lc.obsolete + lc.metadata;
    set('sObs', programmed ? Math.round(100 * lc.obsolete / programmed) + '%' : '0%');
    const npages = fviz().npages;
    const uProg = $('uProg'); if (uProg) uProg.style.width = (100 * lc.live / npages) + '%';
    const uObs = $('uObs'); if (uObs) uObs.style.width = (100 * lc.obsolete / npages) + '%';
    const specLive = $('specLive');
    if (specLive) specLive.textContent = `mounted · ${t.fsinfo ? t.fsinfo.files : 0} files · ${fmtTime(t.simNs || 0)} of flash time`;
  }

  setFocus(DEFAULT_FS);
  $('specGeo').textContent = `${(geometry.sectorSize * geometry.sectorCount / 1024) | 0} KB · ${geometry.sectorCount}×${geometry.sectorSize / 1024} KB · ESP32-S3 timing`;
  $('specLive').textContent = 'formatted + mounted, empty and paused';
  renderGeo();

  // ---- boot log: the ONE real format ships as a broadcast command AFTER the
  // workers are init'd (ADR-0024 §8, no format wire field). help() first so
  // every per-FS tape shows the reference; both drain even while paused
  // (ADR-0020: Pause gates the churn GENERATOR only).
  //   B10 (spec/ui.md L11): the page-load boot ops are wrapped in the §9 prep
  // bracket: prep(true) … boot ops … prep(false), so the worker executes them
  // INSTANTLY, with no metering and no animation, and the page lands usable.
  // prep(false) zeroes the displayed drained counters so boot doesn't count. A
  // prep entry ships as a synthetic-command payload object (never a source
  // string), so it drains atomically worker-side and never echoes on the tape. ----
  bootSequence();
  function bootSequence() {
    coordinator.broadcast({ prep: true }, '');    // §9 open: instant, no metering/animation
    injectCommand('help()');
    injectCommand('format()');
    coordinator.broadcast({ prep: false }, '');   // §9 close: reseat, zero displayed counters
  }

  // ---- the render loop: pull + paint the FOCUSED session once per rAF into
  // its OWN viz (ADR-0024 §4/§7). Hidden sessions pull nothing and keep their
  // own die frozen. No singleton state, no cross-session bleed (RC-A).
  //   On (re)attach (attachedFresh) the pull seeds the session's cursors to its
  // OWN current heads: a full liveMap snapshot + HEAD-ONLY events ({newest,
  // limit:0} → empty batch, but the frame still carries eventHead), so shown/
  // heat/liveMap snap-repaint while NO historical erase sweep replays. The
  // frame's own heads then seed the cursors and subsequent pulls carry forward
  // ({since}), so genuinely-new events DO animate for the watched FS. This is
  // the root fix that retires the B4 suppressEventsOnce/staleFrameRef hack. ----
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(() => fn(Date.now()), 16);
  function renderTick() {
    const st = sessions.get(focusedFsId);
    const f = st.proxy.frame;
    // Process each frame once; ignore a stale leftover from a previous focus
    // stint (st.lastFrame was pinned to it on switch), wait for the fresh one.
    if (f && f !== st.lastFrame) {
      st.lastFrame = f;
      st.viz.applyFrame(f);   // FRAME is protocol-conformant; the fresh-attach frame's events are empty
      if (f.liveMap && f.liveMap.version != null) st.liveMapSince = f.liveMap.version;
      if (f.journalHead != null) st.journalSince = f.journalHead;
      if (f.eventHead != null) st.eventsSince = f.eventHead;
      ingestJournal(st, f.journal);
      st.attachedFresh = false;   // fresh frame consumed; subsequent pulls carry the cursors forward
    }
    st.proxy.pull(st.attachedFresh ? {
      heat: true, wear: true,
      liveMap: { since: -1 },                          // full CURRENT liveMap
      journal: { since: st.journalSince, limit: 400 }, // carry the tape forward (scrollback, no replay risk)
      events: { newest: true, limit: 0 },              // HEAD only: no historical erase sweep
    } : {
      heat: true, wear: true,
      liveMap: { since: st.liveMapSince },
      journal: { since: st.journalSince, limit: 400 },
      events: { since: st.eventsSince, limit: 400 },   // only genuinely-new events animate
    });
    raf(renderTick);
  }
  raf(renderTick);

  // ---- HUD + compare strip on the ~250ms cadence (telemetry heartbeat) ----
  setInterval(() => {
    refreshHUD(); renderFsSet(); renderGap();
    applyCapsGating(capsFor(focusedFsId));   // A3: caps land on TELEMETRY, same ~250ms cadence
  }, 250);

  // ---- standing-signal pins (spec/ui.md): the CS pin AND each fs-card status
  // dot render the RAW per-frame `csActive` blinky (NO debounce, NO CSS smoothing,
  // B15); the fs-card "holding" label renders the ALREADY-debounced (~300ms)
  // `holding`. Both come from the coordinator per-fsId as waitStates()[fsId] =
  // { csActive, holding }; the debounce lives coordinator-side (lockstep.js). ----
  const pinCS = $('pinCS');
  (function holdTick() {
    const ws = coordinator.waitStates();
    for (const fsId of Object.keys(ws)) {
      const { csActive, holding } = ws[fsId];
      const card = $('fsCard-' + fsId);
      card?.classList.toggle('waiting', holding);                  // debounced (the "Holding" card)
      // B15: the top-right status dot reads this FS's raw per-frame CS activity
      // (real-time blinky); its CSS pulse animation was removed so nothing
      // smooths it. Every card shows its OWN session's csActive, focused or not.
      card?.querySelector('.fs-run')?.classList.toggle('cs-on', csActive);
      if (pinCS && fsId === focusedFsId) {
        pinCS.classList.toggle('cs-active', csActive);             // RAW per-frame (spec/ui.md)
        pinCS.classList.toggle('cs-paused', !csActive);
      }
    }
    raf(holdTick);
  })();

  // ---- Run/Pause, Step ----
  const setRunning = (v) => {
    if (v) coordinator.start(); else coordinator.stop();
    $('runLabel').textContent = v ? 'Pause' : 'Run';
    $('btnRun').querySelector('.dot').style.background = v ? 'currentColor' : '#241a06';
  };
  setRunning(false);

  // ---- Race / Pace wheel ----
  const modeWheel = $('modeWheel');
  const modeOpts = { pace: $('modeOpt-pace'), race: $('modeOpt-race') };
  const markMode = (m) => {
    for (const [k, el] of Object.entries(modeOpts)) {
      if (!el) continue;
      el.classList.toggle('active', k === m);
      el.classList.toggle('peek', k !== m);
    }
    if (modeWheel) {
      modeWheel.dataset.mode = m;
      modeWheel.setAttribute('aria-checked', String(m === 'race'));
      modeWheel.setAttribute('aria-label', `comparing ${m === 'race' ? 'most ops in equal time' : 'least time for equal ops'}; click to switch`);
    }
    renderFsSet();
  };
  markMode(coordinator.mode);
  modeWheel?.addEventListener('click', () => {
    const m = coordinator.mode === 'race' ? 'pace' : 'race';
    coordinator.setMode(m); markMode(m); renderGap();
  });

  // ---- controls: buttons INJECT console commands ----
  $('btnRun').addEventListener('click', () => setRunning(!coordinator.running));
  $('btnStep').addEventListener('click', () => coordinator.step());
  $('btnWrite').addEventListener('click', () => injectCommand('writeFile()'));
  $('btnRead').addEventListener('click', () => injectCommand('readFile()'));
  $('btnLs').addEventListener('click', () => injectCommand('ls()'));
  $('btnDelete').addEventListener('click', () => injectCommand('deleteFile()'));
  $('btnGC').addEventListener('click', () => injectCommand('gc()'));
  $('btnFormat').addEventListener('click', () => injectCommand('format()'));

  // ---- Reset (header): bump epoch (workers rebuild a fresh chip), then replay
  // the boot log. Never switches race/pace mode (spec/ui.md). Every session's
  // OWN state (its die, cursors and journal copy) is reset, the coordinator
  // nulls each proxy.frame on reset, so a re-attach snaps to the fresh chip. ----
  $('btnReset')?.addEventListener('click', () => {
    setRunning(false);
    coordinator.reset();
    for (const st of sessions.values()) {
      st.viz.clear();
      st.liveMapSince = -1; st.journalSince = 0; st.eventsSince = 0;
      st.attachedFresh = true; st.lastFrame = null;
      st.journalEntries = []; st.tapeSeen.clear();
    }
    setFocus(focusedFsId);   // re-render the shared DOM from the (now empty) focused state
    $('specLive').textContent = 'formatted + mounted, empty and paused';
    bootSequence();          // B10: prep-wrapped, same as page-load boot
  });

  // slider 0..100 → sim-ns per real-ms (log scale). Real flash time = 1e6. Top (v=100)
  // is 1e7 = 10× real-time (MAX_SCALE): NO "max no delay". An infinite scale is off-spec
  // (§2 Δ must be finite, else the Race bound in playLimitNs is ignored by the flat-out
  // worker). The coordinator also clamps to MAX_SCALE, so this stays in lockstep with it.
  function applySpeed(v) {
    const lo = Math.log10(3000), hi = Math.log10(1e7);   // top = 1e7 (10× real-time)
    const scale = Math.pow(10, lo + (hi - lo) * (v / 100));   // v=100 → exactly 1e7
    const x = scale / 1e6;
    const label = (x >= 0.9 && x <= 1.15) ? '≈ real-time'
      : x < 1 ? `${(1 / x < 10 ? (1 / x).toFixed(1) : Math.round(1 / x))}× slow-mo`
      : `${x < 10 ? x.toFixed(1) : Math.round(x)}× real-time`;
    coordinator.setSpeed(scale);
    // The same scale the coordinator paces playback with also times each die's
    // fill-reveal transition (lockstep.js: "the numeric copy the die animation
    // also uses"). Without this the fill-height reveal is frozen at its CSS
    // duration regardless of speed; the glow/decay and erase ms already scale.
    for (const st of sessions.values()) st.viz.setScale(scale);
    $('speedRead').textContent = label;
  }
  applySpeed(+$('speed').value);
  $('speed').addEventListener('input', (e) => applySpeed(+e.target.value));

  const applyGc = (v) => { coordinator.setGcRatio(v / 100); $('gcRead').textContent = v === 0 ? 'off' : `${v}%`; };
  applyGc(+$('gc').value);
  $('gc').addEventListener('input', (e) => applyGc(+e.target.value));

  // heat-map toggle: a pure view (the wear overlay). It reads the wear the FRAME
  // already carries, so it just flips each session's viz overlay flag, applied
  // to ALL dice so the setting persists across focus switches.
  $('heat').addEventListener('change', (e) => {
    for (const st of sessions.values()) st.viz.setHeatmap(e.target.checked, st.dieEl);
  });

  // ---- console input ----
  const HKEY = 'flashvis.console.history', HMAX = 20;
  const store = typeof window !== 'undefined' ? window.localStorage : null;

  // ---- palette switcher ----
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
  const themeChipEls = new Map();
  const applyTheme = (t) => {
    if (!THEMES.includes(t)) t = 'aurora';
    document.documentElement.dataset.theme = t;
    for (const [id, el] of themeChipEls) {
      const on = id === t;
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', String(on));
      el.tabIndex = on ? 0 : -1;
    }
    const nameEl = $('themeName');
    if (nameEl) nameEl.textContent = (THEME_LIST.find((x) => x.id === t) || {}).name || '';
    try { store?.setItem(THEME_KEY, t); } catch { /* no storage */ }
    for (const st of sessions.values()) st.viz.refreshTheme();
  };
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
  const saveHist = () => { try { store.setItem(HKEY, JSON.stringify(cmdHist)); } catch { /* no storage */ } };
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

// Caps-gating (ADR-0011/0015): hide controls the FOCUSED FS disclaims.
function applyCapsGating(caps) {
  const toggle = (id, hide) => { const e = $(id); if (e) e.classList.toggle('hidden', hide); };
  toggle('ctlGc', !(caps & FF_CAP_GC));
  toggle('statGarbage', !(caps & FF_CAP_LIVE_MAP));
  toggle('utilBar', !(caps & FF_CAP_LIVE_MAP));
}
