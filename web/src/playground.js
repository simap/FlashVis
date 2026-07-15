/*
 * Playground: the console command-compiler + comparison UI, rewired onto the
 * ADR-0024 worker-per-session wire.
 *
 * WHAT CHANGED FROM THE PRE-0024 PLAYGROUND
 *   - Each session is now a WORKER behind a Port. We spawn one Worker per FS,
 *     wrap it in a session-PROXY (web/src/session-proxy.js, the SINGLE owner of
 *     that Port — it receives GRANT_ACK/FRAME/TELEMETRY), and hand the proxies
 *     to the coordinator (web/src/lockstep.js) via setSessions([...proxies]).
 *   - The die renders from PULLED FRAMEs, not synchronous device reads: a rAF
 *     loop calls focusedProxy.pull(sel) then viz.applyFrame(frame) for the ONE
 *     focused session (ADR-0017 focus-is-view; unfocused sessions stream
 *     nothing). There is ONE main-thread viz; focus switch = snap repaint.
 *   - HUD + compare strip read TELEMETRY (proxy.telemetry) + coordinator
 *     snapshots(), the ~250ms heartbeat, for EVERY session at once.
 *   - The tape (console scrollback) is WORKER-OWNED and read via a journal
 *     PULL (frame.journal / journalHead), not flipped by the coordinator.
 *   - broadcast() ships RAW console SOURCE TEXT the worker compiles in its
 *     ADR-0019 sandbox, not a live closure — a closure can't cross the thread.
 *
 * The worker's FRAME payload is protocol.js-conformant (FrameMsg: heat.read/
 * prog, shown.pages/wear, liveMap.version/classes, erase/reset EventEntries in
 * `events`), so the render loop feeds the pulled FRAME straight to viz.js —
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
// so we fail OPEN — a missing/stale caps read must not incorrectly hide a
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
const fmtPerOp = (ns, ops) => { if (!(ops > 0)) return '—'; const us = ns / 1000 / ops; return us < 1000 ? `${Math.round(us)} µs/op` : `${(us / 1000).toFixed(2)} ms/op`; };
const fmtRate = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/* ------------------------------------------------------------------------ *
 * COMMAND SOURCE (ADR-0024 §4: commands ship as RAW SOURCE)
 *
 * A console line ships to the worker AS TYPED — bare statements (`help()`,
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
 * WORKER CONNECTION SEAM — production spawns a real Worker; a headless test
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
  if (el) el.textContent = 'boot failed — ' + (e && e.message || e);
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

  // Participating sessions (fsId → { proxy, terminate }) and which is FOCUSED.
  const sessions = new Map();
  let focusedFsId = DEFAULT_FS;

  // ONE main-thread renderer; re-pointed (snap repaint) on focus switch.
  const viz = createViz(geometry);
  const dieEl = document.createElement('div');
  dieEl.className = 'die';
  $('dieStack').appendChild(dieEl);
  viz.mountDie(dieEl);
  viz.attachInspector($('insp'));

  // Focused-session pull cursors (ADR-0024 §7). Reset on focus switch / epoch bump.
  let liveMapSince = 0, journalSince = 0, eventsSince = 0, attachedFresh = true;
  // B4: don't animate the backlog on the first GENUINELY NEW frame after a
  // (re)attach. `staleFrameRef` pins the proxy's frame object as of the
  // switch — since a previously-focused, now-backgrounded session's `.frame`
  // is left stale (unfocused sessions stream nothing), the very next
  // renderTick can otherwise see that OLD frame and wrongly treat it as
  // "the first frame", consuming the suppress flag before the real
  // (re)attach response (the true events backlog) ever arrives.
  let suppressEventsOnce = true;
  let staleFrameRef = null;
  const tapeSeen = new Set();

  // A3: gate controls off the FOCUSED session's real caps bitmask (falls
  // back to "everything capable" if telemetry hasn't reported caps yet).
  function capsFor(fsId) {
    const c = sessions.get(fsId)?.proxy?.telemetry?.caps;
    return typeof c === 'number' ? c : CAPS_FALLBACK;
  }

  $('specLive').textContent = `loading ${Object.values(FS_REGISTRY).join(' + ')} (WASM)…`;

  // ---- spawn one worker per FS, wrap in a proxy ----
  for (const fsId of Object.keys(FS_REGISTRY)) {
    const meta = { fsId, name: FS_REGISTRY[fsId], geometry };
    const { port, terminate } = connectWorker(fsId, meta);
    const proxy = createSessionProxy(port, meta);
    sessions.set(fsId, { proxy, terminate });
  }
  const proxyOf = (fsId) => sessions.get(fsId).proxy;
  const proxies = [...sessions.values()].map((s) => s.proxy);

  // setSessions init()'s every worker (INIT builds a fresh chip at epoch 0).
  coordinator.setSessions(proxies);

  // ---- command source → broadcast (the ONE path console/boot/buttons take) ----
  function injectCommand(userSrc) {
    return coordinator.broadcast(userSrc, userSrc);   // RAW source; worker compiles it
  }

  // ---- focus switch: die/tape/telemetry/legend follow one session; a pure
  // view op (ADR-0017), never logged, never touches state. Re-attach fresh so
  // the next pull is a full-state snap repaint (§7). ----
  function setFocus(fsId) {
    focusedFsId = fsId;
    viz.clear();
    liveMapSince = 0; journalSince = 0; eventsSince = 0; attachedFresh = true;
    // B4: the (re)attach pull below asks for the whole events ring
    // (since:0) so the worker knows what "current" is, but that ring is
    // one-shot animation history (erase sweeps) already played once —
    // ADR-0024 §7's (re)attach rule is events{newest,0} (head pointer
    // only, never replayed). The worker still serves {since:0}, so we
    // decouple on this side: the FIRST frame received after a switch
    // advances eventsSince to its eventHead WITHOUT animating, and only
    // frames after that animate genuinely-new events.
    suppressEventsOnce = true;
    staleFrameRef = sessions.get(fsId).proxy.frame;   // may be null (never focused) or a stale leftover
    tapeSeen.clear();
    $('tape').innerHTML = '';
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
    // internal command lifecycle markers carry text 'command' — not user-facing.
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
  function ingestJournal(journal) {
    if (!journal) return;
    for (const e of journal) {
      if (tapeSeen.has(e.id)) continue;
      tapeSeen.add(e.id);
      appendTapeEntry(e);
    }
  }

  // ---- the standings rail (ADR-0018): one .fs card per FS, click to focus ----
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
  const fsSetBuilt = new Set();
  function renderFsSet() {
    const wrap = $('fsSet');
    const snaps = coordinator.snapshots();
    const mode = coordinator.mode;
    const goodOf = (s) => (mode === 'race' ? (s.opsPerSec || 0) : (s.simNs > 0 ? s.fileOpCount / s.simNs : 0));
    const leaderGood = snaps.reduce((m, s) => Math.max(m, goodOf(s)), 0);
    for (const snap of snaps) {
      if (!fsSetBuilt.has(snap.fsId)) { wrap.appendChild(fsCard(snap.fsId)); fsSetBuilt.add(snap.fsId); }
      const card = $('fsCard-' + snap.fsId);
      card.classList.toggle('on', snap.fsId === focusedFsId);
      card.setAttribute('aria-pressed', String(snap.fsId === focusedFsId));
      const good = goodOf(snap);
      card.classList.toggle('leader', leaderGood > 0 && good >= leaderGood);
      $('fsHold-' + snap.fsId).textContent = mode === 'race' ? '◷ waiting' : '◷ holding';
      $('fsV-' + snap.fsId).textContent = mode === 'race' ? String(snap.fileOpCount) : fmtTime(snap.simNs);
      $('fsL-' + snap.fsId).textContent = mode === 'race' ? 'ops done' : 'flash time';
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
    fatfs: [{ cls: 'wl', word: 'WL', title: 'metadata the FTL itself writes (config/state) — a shade of metadata' }],
  };
  function legendFor(fsId) {
    const erasedTitle = fsId === 'fatfs'
      ? '0xFF, nothing written — or slack: allocated but carrying no data'
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
  // '—'. ----
  function refreshHUD() {
    const t = proxyOf(focusedFsId).telemetry;
    const m = viz.metrics();
    const lc = t.livenessCounts || { live: 0, obsolete: 0, metadata: 0 };
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('sAmp', t.wa != null ? t.wa.toFixed(1) + '×' : '—');
    set('fAmp', t.wa != null ? t.wa.toFixed(1) + '×' : '—');
    set('fProg', Math.round(100 * m.displayedBytes / m.capacityBytes) + '%');
    set('fFree', m.erasedPages);
    set('sFiles', t.fsinfo ? t.fsinfo.files : 0);
    set('sBytes', t.fsinfo ? (t.fsinfo.bytes / 1024).toFixed(1) + ' KB' : '0.0 KB');
    set('fSim', fmtTime(t.simNs || 0));
    const programmed = lc.live + lc.obsolete + lc.metadata;
    set('sObs', programmed ? Math.round(100 * lc.obsolete / programmed) + '%' : '0%');
    const uProg = $('uProg'); if (uProg) uProg.style.width = (100 * lc.live / viz.npages) + '%';
    const uObs = $('uObs'); if (uObs) uObs.style.width = (100 * lc.obsolete / viz.npages) + '%';
    const specLive = $('specLive');
    if (specLive) specLive.textContent = `mounted · ${t.fsinfo ? t.fsinfo.files : 0} files · ${fmtTime(t.simNs || 0)} of flash time`;
  }

  setFocus(DEFAULT_FS);
  $('specGeo').textContent = `${(geometry.sectorSize * geometry.sectorCount / 1024) | 0} KB · ${geometry.sectorCount}×${geometry.sectorSize / 1024} KB · ESP32-S3 timing`;
  $('specLive').textContent = 'formatted + mounted — empty and paused';
  renderGeo();

  // ---- boot log: the ONE real format ships as a broadcast command AFTER the
  // workers are init'd (ADR-0024 §8 — no format wire field). help() first so
  // every per-FS tape shows the reference; both drain even while paused
  // (ADR-0020: Pause gates the churn GENERATOR only). ----
  injectCommand('help()');
  injectCommand('format()');

  // ---- the render loop: pull + paint the FOCUSED session once per rAF
  // (ADR-0024 §4/§7). Unfocused sessions stream nothing. ----
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(() => fn(Date.now()), 16);
  function renderTick() {
    const proxy = proxyOf(focusedFsId);
    // Paint whatever the LAST pull returned (one frame of wire latency), then
    // issue the next pull.
    const f = proxy.frame;
    // Skip a frame object that's just the stale leftover from this session's
    // PREVIOUS focus stint (see staleFrameRef comment) — it is not a
    // response to this switch's (re)attach pull, so treating it as "the
    // first frame" would consume suppressEventsOnce early and let the real
    // backlog response (arriving next) animate uncontrolled (B4).
    if (f && f !== staleFrameRef) {
      // B4: the first frame after (re)attach carries the whole events ring
      // as backlog (the worker doesn't yet offer a {newest} events
      // selector, ADR-0024 §7) — apply it with events stripped so shown/
      // heat/liveMap still snap-repaint, but no historical erase sweep
      // replays. Advance the cursor to this frame's head so only events
      // AFTER this point animate.
      if (suppressEventsOnce) {
        viz.applyFrame({ ...f, events: undefined });
        suppressEventsOnce = false;
      } else {
        viz.applyFrame(f);   // FRAME is protocol-conformant; viz consumes it directly
      }
      if (f.liveMap && f.liveMap.version != null) liveMapSince = f.liveMap.version;
      if (f.journalHead != null) journalSince = f.journalHead;
      if (f.eventHead != null) eventsSince = f.eventHead;
      ingestJournal(f.journal);
    }
    proxy.pull({
      heat: true, wear: true,
      liveMap: { since: liveMapSince },
      journal: attachedFresh ? { since: 0, limit: 400, newest: true } : { since: journalSince, limit: 400 },
      events: attachedFresh ? { since: 0, limit: 400 } : { since: eventsSince, limit: 400 },
    });
    attachedFresh = false;
    raf(renderTick);
  }
  raf(renderTick);

  // ---- HUD + compare strip on the ~250ms cadence (telemetry heartbeat) ----
  setInterval(() => {
    refreshHUD(); renderFsSet(); renderGap();
    applyCapsGating(capsFor(focusedFsId));   // A3: caps land on TELEMETRY, same ~250ms cadence
  }, 250);

  // ---- standing-signal pins (spec/ui.md): the CS pin/status dot renders the
  // RAW per-frame `csActive` blinky (NO debounce); the fs-card "holding" label
  // renders the ALREADY-debounced (~300ms) `holding`. Both come from the
  // coordinator per-fsId as waitStates()[fsId] = { csActive, holding }; the
  // debounce lives coordinator-side now (lockstep.js), not here. ----
  const pinCS = $('pinCS');
  (function holdTick() {
    const ws = coordinator.waitStates();
    for (const fsId of Object.keys(ws)) {
      const { csActive, holding } = ws[fsId];
      $('fsCard-' + fsId)?.classList.toggle('waiting', holding);   // debounced (the "Holding" card)
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
  // the boot log. Never switches race/pace mode (spec/ui.md). ----
  $('btnReset')?.addEventListener('click', () => {
    setRunning(false);
    coordinator.reset();
    setFocus(focusedFsId);   // re-attach so the tape/die snap back to the fresh chip
    $('specLive').textContent = 'formatted + mounted — empty and paused';
    injectCommand('help()');
    injectCommand('format()');
  });

  // slider 0..100 → sim-ns per real-ms (log scale). Real flash time = 1e6.
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

  // heat-map toggle: a pure view (the focused die's wear overlay). It reads the
  // wear the FRAME already carries, so it just flips the viz overlay flag.
  $('heat').addEventListener('change', (e) => { viz.setHeatmap(e.target.checked, dieEl); });

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
    viz.refreshTheme();
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
