/*
 * Busy-lock / no-double-execution concurrency regression suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both filesystems execute the ONE canonical sequence the coordinator owns, so
 * every sequence step must run EXACTLY ONCE per session. If a step is ever
 * double-executed (a churn write applied twice, a command replayed while another
 * driver is already draining it, a mode flip re-running an in-flight step) that
 * FS's flash state silently diverges from the canonical run and the whole
 * cross-FS comparison becomes meaningless -> a data-corruption class bug with no
 * crash. lockstep.js added a unified `busy` re-entry lock (plus paceBusy, the
 * FIX A reject/rewind path and the FIX B abort/advance path) to close exactly
 * these interleavings. This suite drives the REAL coordinator + REAL sessions +
 * REAL WASM and LOCKS those fixes in: it passes now and must fail loudly if any
 * of them is reintroduced as a bug.
 *
 * FORCING THE WINDOW (why the earlier cost-only version was vacuous)
 * -----------------------------------------------------------------
 * The bug can only manifest when a session is `busy` (mid-command) AT THE MOMENT a
 * second driver targets that same sequence[i]. At Speed a command quiesces before
 * the flipped/overlapping driver runs, so that window is never hit and no faithful
 * reintroduction of the bug changes anything - a vacuous test. Scenarios 1-3 make
 * the window DETERMINISTIC with a GATED command: its fn does one write, AWAITS a
 * gate we hold open (so its runCommand stays in-flight and the session stays
 * `busy` indefinitely), then a second write. We park both sessions in the window,
 * THEN drive the second driver squarely into it.
 *
 * PRIMARY OBSERVABLE: a per-command `dispatches` counter (fn invocations, one per
 * session per dispatch of sequence[i]). A re-dispatch spawns a fresh fn
 * invocation, so `dispatches` climbing above sessions.length IS the double
 * execution - the direct, mode-agnostic signal. Verified by mutation (see
 * scripts/TEST-GAPS.md "Mutation evidence"): removing paceStep's busy-map
 * exclusion -> scenario 1 FAILs (4x); removing raceTick's busy-skip or step()'s
 * busy-claim -> scenario 2 FAILs; removing BOTH pace guards -> scenario 3 FAILs.
 * (paceBusy alone is defense-in-depth: redundant with the busy map in pure Pace.)
 *
 * SECONDARY: write-side device cost (programs/erases/programBytes) vs a clean
 * single run. NOTE it is compared on WRITE keys only, NOT reads/simNs: snapshots()
 * issues counted READS (a liveness walk), and a torture run that parks mid-command
 * polls at an intermediate flash state a clean run never pauses at, so reads/simNs
 * carry a harness-measurement artifact of +/-1. Write-side cost is poll-invariant
 * and is exactly what a double-executed write inflates. Cross-FS byte-identical
 * read-back is asserted too (the product invariant: both FS hold identical bytes).
 *
 * For the abort/reject scenarios, command RE-execution after an abort is the
 * ADR-0019 rewind model (by design, not a bug), so those assert recovery +
 * cross-FS byte-identity (content stays correct through an idempotent redo)
 * rather than cost-equality. The FIX B guard (a NON-command churn step aborted
 * in its barrier window) DOES assert cost-equality (all keys), because that fix
 * advances the cursor precisely so the churn op is NOT re-applied, and it does
 * not park with differential polling.
 *
 * DETERMINISM: no sleep-races. Every scenario polls the real cursor / the gate
 * counter for its condition and every pump loop has a hard iteration bound, so a
 * hang (e.g. a frozen FS from a broken lock) fails fast instead of wedging CI.
 */
import { installFakeDom } from './fake-dom.mjs';
import { createChurnModel } from '../web/src/churn.js';
import { createSession } from '../web/src/session.js';
// The coordinator under test is the shipped web/src/lockstep.js by default. The
// FV_LOCKSTEP env var lets a MUTATION harness point this same suite at a scratch
// copy of the coordinator with one guard reintroduced-as-a-bug, to PROVE each
// scenario actually fails when its target protection is removed (test-only seam;
// never used by npm test, which leaves it unset).
const { createLockstep } = await import(process.env.FV_LOCKSTEP || '../web/src/lockstep.js');

process.on('unhandledRejection', (e) => { console.error('\nFAIL - unhandled rejection:', (e && e.stack) || e); process.exit(1); });

// ---- config mirrors playground.js so the canonical sequence behaves as shipped ----
const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const CHURN_CFG = {
  seed: 0x00c0ffee,
  targetLiveBytes: 96 * 1024,
  targetWrittenBytes: 0xffffffff,
  targetSlackBytes: 16 * 1024,
  forceLargeAfterBytes: 0xffffffff,
};
const FS_ORDER = ['fastffs', 'littlefs'];

let failures = 0;
function fail(msg) { failures++; console.error('  FAIL - ' + msg); }
function ok(msg) { console.log('  ok   - ' + msg); }

// ---- rig: a real coordinator + two real sessions under a fresh fake DOM ----
// Each rig installs its own fake DOM BEFORE constructing the coordinator/sessions
// so that dom.runIntervals()/dom.tick() drive ONLY this rig's coordinator tick
// and viz frame loops; a previous rig's captured setInterval/rAF callbacks live
// in that rig's dom closure and stay dormant.
async function makeRig({ speed = Infinity } = {}) {
  const dom = installFakeDom();
  const churn = createChurnModel(CHURN_CFG);
  const sessions = [];
  for (const fsId of FS_ORDER) {
    sessions.push(await createSession(fsId, { geometry: GEOMETRY, container: document.createElement('div'), name: fsId }));
  }
  const coord = createLockstep({ churn });
  coord.setSessions(sessions);
  coord.reset();                 // fresh, empty, mounted chips on both
  coord.setSpeed(speed);
  return { dom, coord, sessions, byId: Object.fromEntries(sessions.map((s) => [s.fsId, s])) };
}

const flushMacro = () => new Promise((r) => setTimeout(r, 0));
function tickOnce(dom) { dom.tick(1); dom.runIntervals(); }

// Drive a single pace step() to completion. A produced (non-command) pace step
// applies its churn/gc op synchronously, then awaits a viz drain barrier that
// only resolves on a viz frame, so it needs ticks. Bounded so a stuck step fails
// fast rather than hanging.
async function stepToCompletion(rig, maxIter = 3000) {
  const p = rig.coord.step();
  let settled = false; p.then(() => { settled = true; }, () => { settled = true; });
  for (let g = 0; g < maxIter && !settled; g++) { await flushMacro(); tickOnce(rig.dom); }
  if (!settled) throw new Error('stepToCompletion: a single step() never settled (frozen player?)');
  await p;
}
const cursorsOf = (coord) => coord.snapshots().map((s) => s.stepCursor);
const minCursor = (coord) => Math.min(...cursorsOf(coord));
const maxCursor = (coord) => Math.max(...cursorsOf(coord));
const allAt = (coord, n) => cursorsOf(coord).every((c) => c === n);

// A manual Step is only safe to fire while NO session sits at the frontier
// (maxCursor < n): a Race step() ensure()s + GENERATES a fresh churn step for a
// session already at the frontier, which would push the sequence past our fixed
// N queued commands and pollute the fingerprint. The check and step() run with
// no await between them (step()'s per-session ensure() is synchronous), so the
// gate holds. Fire-and-forget: overlapping step()/tick calls ARE the race under
// test; the busy/paceBusy locks must arbitrate, and pump's ticks drain them.
function tryStep(coord, n) { if (maxCursor(coord) < n) coord.step().catch(() => {}); }

// Generic bounded pump: advance sim time + coordinator ticks until `done()` (or
// throw once the hard bound is hit - a hang is a failure, never an infinite
// wait). `each(i)` runs an optional per-iteration torture step BEFORE the tick.
async function pump(dom, { done, each, maxIter = 8000 }) {
  for (let i = 0; i < maxIter; i++) {
    if (done()) return i;
    if (each) await each(i);
    await flushMacro();
    tickOnce(dom);
  }
  if (done()) return maxIter;
  throw new Error(`pump exceeded maxIter=${maxIter} - coordinator never converged (frozen FS / broken lock?)`);
}

// ---- broadcast a batch of distinct single-write commands at the frontier ----
// Distinct names/sizes so a double-execution reprograms and shows up in device
// cost. running stays false, so exactly these N steps make up the whole sequence.
function broadcastWrites(coord, n, prefix = 'p') {
  const names = [];
  for (let k = 0; k < n; k++) {
    const name = `${prefix}${k}.bin`;
    const size = 3072 + k * 2048;
    names.push(name);
    coord.broadcast(async (api) => { await api.writeFile(name, size); }, `write ${name}`);
  }
  return names;
}

// ---- fingerprints (device cost snapshot FIRST, then read-back bytes) ----
function fingerprint(session) {
  const st = session.device.stats;
  const stats = { reads: st.reads, programs: st.programs, erases: st.erases, programBytes: st.programBytes, simNs: st.simNs };
  const files = new Map();                         // read() adds device reads, so snapshot stats above first
  for (const name of session.runner.names().sort()) files.set(name, session.runner.read(name));
  return { stats, files };
}
const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function fileMapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [name, bytes] of a) { const o = b.get(name); if (!o || !bytesEqual(bytes, o)) return false; }
  return true;
}
// Write-side cost (programs/erases/programBytes) is INVARIANT to how often the
// harness polls snapshots(): the liveness walk snapshots() runs issues counted
// READS (and thus simNs), so a torture run that parks mid-command and polls at an
// intermediate flash state records a different `reads`/`simNs` than a clean run
// that never pauses there - a measurement artifact, NOT a double-execution. A
// double-executed WRITE, by contrast, always reprograms -> the write-side keys
// catch it and are stable. So the gated scenarios compare on WRITE_KEYS (backed
// by the direct dispatch counter); the non-parking scenarios use ALL_KEYS.
const WRITE_KEYS = ['programs', 'erases', 'programBytes'];
const ALL_KEYS = ['reads', 'programs', 'erases', 'programBytes', 'simNs'];
function statsEqualOn(a, b, keys) { return keys.every((k) => a[k] === b[k]); }
function statsStr(s, keys = ALL_KEYS) { return keys.map((k) => `${k}=${s[k]}`).join(' '); }

// Assert a torture run's per-fsId fingerprint equals a clean reference (the
// exactly-once signal) AND the two FS hold byte-identical files (product invariant).
function assertMatchesReference(label, torture, reference, keys = ALL_KEYS) {
  for (const fsId of FS_ORDER) {
    const t = torture.byId[fsId];
    const r = reference[fsId];
    if (!statsEqualOn(t.stats, r.stats, keys)) fail(`${label}: ${fsId} device cost diverged from clean run (double-execution?)\n         ref : ${statsStr(r.stats, keys)}\n         got : ${statsStr(t.stats, keys)}`);
    else ok(`${label}: ${fsId} device cost matches clean single run (${statsStr(t.stats, keys)})`);
    if (!fileMapsEqual(t.files, r.files)) fail(`${label}: ${fsId} file bytes diverged from clean run`);
  }
  assertCrossFsIdentical(label, torture);
}
function assertCrossFsIdentical(label, run) {
  const [a, b] = FS_ORDER.map((fsId) => run.byId[fsId].files);
  if (!fileMapsEqual(a, b)) fail(`${label}: FASTFFS and LittleFS file bytes are NOT identical after the identical sequence`);
  else ok(`${label}: FASTFFS and LittleFS read back byte-identical (${a.size} files)`);
}
function captureByFs(sessions) {
  return { byId: Object.fromEntries(sessions.map((s) => [s.fsId, fingerprint(s)])) };
}

const N = 6;   // queued commands for the realistic long-run smoke

// ---- forced-window primitive: a GATED command whose fn parks mid-execution ----
// The round-1 scenarios were VACUOUS: at Speed a command quiesces before the
// flipped/overlapping driver runs, so the `busy` window (a session mid-command
// when a second driver targets sequence[i]) was never actually hit and the bug
// could not manifest. This command does one write, then AWAITS a gate we hold
// open, then does a second write. While parked at the gate its runCommand is
// in-flight (fnDone=false) so runCommandOnSession never settles -> the session
// stays `busy` DETERMINISTICALLY for as long as we like, letting us drive the
// second driver squarely into the window. `dispatches` counts fn invocations
// (one per session per dispatch of sequence[i]) - the DIRECT observable of the
// no-double-execution invariant: a re-dispatch of the same step spawns a fresh
// fn invocation, so `dispatches` climbing above sessions.length is the bug.
// `atGate` counts how many invocations reached the gate (proves the window is
// genuinely occupied, not just entered). GATE_A/GATE_B are the two files.
const GATE_A = 'gate-a.bin', GATE_B = 'gate-b.bin', GATE_SIZE = 4096;
function gatedCommand() {
  const state = { dispatches: 0, atGate: 0, release: null };
  const gate = new Promise((r) => { state.release = r; });
  const fn = async (api) => {
    state.dispatches++;
    await api.writeFile(GATE_A, GATE_SIZE);
    state.atGate++;
    await gate;
    await api.writeFile(GATE_B, GATE_SIZE);
  };
  return { fn, state };
}

// Tick until `cond()` holds (or throw at the bound). Order is tick-then-flush so
// a coordinator dispatch (on the tick) and the fn microtasks it spawns (on the
// flush) both advance each iteration.
async function pumpUntil(dom, cond, label, maxIter = 4000) {
  for (let i = 0; i < maxIter; i++) {
    if (cond()) return i;
    tickOnce(dom);
    await flushMacro();
  }
  if (cond()) return maxIter;
  throw new Error(`pumpUntil(${label}) exceeded ${maxIter} iterations - window never reached (or coordinator frozen)`);
}

// The exactly-once reference for a SINGLE gated command: run it once cleanly
// (gate released immediately) and capture per-fsId cost + bytes. Every scenario
// 1-3 torture run must land on this (each session dispatches sequence[i] once).
async function buildGatedReference() {
  const rig = await makeRig();
  const g = gatedCommand();
  rig.coord.broadcast(g.fn, 'gated-ref');
  rig.coord.setMode('pace');
  g.state.release();                                     // no parking: a clean single run
  await pump(rig.dom, { done: () => allAt(rig.coord, 1) });
  if (g.state.dispatches !== FS_ORDER.length) fail(`gated reference dispatched ${g.state.dispatches} times, expected ${FS_ORDER.length}`);
  const cap = captureByFs(rig.sessions);
  assertCrossFsIdentical('gated-reference', cap);
  return cap.byId;
}
const expectDispatches = (g, want, label) => {
  if (g.state.dispatches !== want) fail(`${label}: sequence[i] dispatched ${g.state.dispatches} times, expected ${want} (a re-dispatch = double execution)`);
  else ok(`${label}: dispatched exactly ${want}x (no double execution)`);
};

// ---- Scenario 1: race->pace flip while a RACE command is mid-drain (busy) ----
// Targets the busy-map exclusion in paceStep's `due` filter (the load-bearing
// guard for the CROSS-mode path: raceTick sets `busy` with no paceBusy held, so
// only `&& !busy.get(s)` stops paceStep from re-dispatching sequence[i] after the
// flip). We first PARK both sessions mid-command in Race (busy set), THEN flip to
// Pace and run paceStep repeatedly while still parked. dispatches must stay at
// sessions.length.
async function scenarioModeFlip(reference) {
  console.log('\n[1] race->pace flip while a race command is mid-drain (busy-map exclusion)');
  const rig = await makeRig();
  const g = gatedCommand();
  rig.coord.broadcast(g.fn, 'gated s1');
  rig.coord.setMode('race');
  await pumpUntil(rig.dom, () => g.state.atGate >= FS_ORDER.length, 's1-window');   // both sessions parked mid-command in Race
  if (g.state.atGate !== FS_ORDER.length || g.state.dispatches !== FS_ORDER.length) fail(`s1 window not clean: dispatches=${g.state.dispatches} atGate=${g.state.atGate}`);
  else ok(`window reached: both sessions parked mid-command in Race (busy set), dispatches=${g.state.dispatches}`);
  rig.coord.setMode('pace');                             // flip while still parked; paceStep now runs against busy sessions
  for (let k = 0; k < 10; k++) { tickOnce(rig.dom); await flushMacro(); }
  expectDispatches(g, FS_ORDER.length, 's1 after race->pace flip');
  g.state.release();
  await pump(rig.dom, { done: () => allAt(rig.coord, 1) });
  assertMatchesReference('mode-flip', captureByFs(rig.sessions), reference, WRITE_KEYS);
}

// ---- Scenario 2: step() and raceTick both targeting a busy Race command ----
// Targets raceTick's `if (busy.get(s)) continue` AND step()'s synchronous busy
// claim / skip. Park both sessions mid-command in Race (raceTick set busy), then
// (a) run many more raceTicks - raceTick must not re-dispatch a busy session; and
// (b) call step() - it must skip a session raceTick is draining. dispatches stays
// at sessions.length through both.
async function scenarioStepVsRaceTick(reference) {
  console.log('\n[2] step() vs raceTick draining a command (raceTick busy-skip + step busy-claim)');
  const rig = await makeRig();
  const g = gatedCommand();
  rig.coord.broadcast(g.fn, 'gated s2');
  rig.coord.setMode('race');
  await pumpUntil(rig.dom, () => g.state.atGate >= FS_ORDER.length, 's2-window');
  ok(`window reached: both sessions parked mid-command in Race (busy set), dispatches=${g.state.dispatches}`);
  for (let k = 0; k < 10; k++) { tickOnce(rig.dom); await flushMacro(); }   // (a) raceTick must not re-dispatch busy sessions
  expectDispatches(g, FS_ORDER.length, 's2 after extra raceTicks');
  // (b) step() must skip busy sessions. Fire-and-forget (never awaited unbounded):
  // if the busy-claim is broken the re-dispatched command parks at OUR gate, so an
  // `await step()` here would hang. We instead observe the re-dispatch via the
  // counter, then release + drain, then let step() settle.
  const sp = rig.coord.step(); sp.catch(() => {});
  for (let k = 0; k < 6; k++) { tickOnce(rig.dom); await flushMacro(); }
  expectDispatches(g, FS_ORDER.length, 's2 after step() over busy sessions');
  g.state.release();
  await pump(rig.dom, { done: () => allAt(rig.coord, 1) });
  await sp.catch(() => {});
  assertMatchesReference('step-vs-racetick', captureByFs(rig.sessions), reference, WRITE_KEYS);
}

// ---- Scenario 3: step() overlapping an in-flight paceStep command ----
// Park both sessions mid-command in Pace (the interval's paceStep dispatched and
// is awaiting `run`, so paceBusy is held AND busy is set), then call step().
// step() must not produce a second dispatch. NOTE (see TEST-GAPS + the mutation
// report): in the PURE-pace overlap the two guards are mutually redundant -
// paceBusy blocks re-entry and the busy map blocks re-dispatch - so removing
// EITHER alone leaves dispatches at sessions.length; the busy map is shown
// load-bearing by scenario 1's cross-mode path. This scenario still asserts the
// invariant (no second dispatch) directly.
async function scenarioStepVsPaceStep(reference) {
  console.log('\n[3] step() vs in-flight paceStep command (pace overlap)');
  const rig = await makeRig();
  const g = gatedCommand();
  rig.coord.broadcast(g.fn, 'gated s3');
  rig.coord.setMode('pace');
  await pumpUntil(rig.dom, () => g.state.atGate >= FS_ORDER.length, 's3-window');   // paceStep in-flight, parked, paceBusy held
  ok(`window reached: paceStep in-flight, both sessions parked mid-command (paceBusy + busy set), dispatches=${g.state.dispatches}`);
  const sp = rig.coord.step(); sp.catch(() => {});                                 // overlapping manual Step (fire-and-forget; see s2)
  for (let k = 0; k < 6; k++) { tickOnce(rig.dom); await flushMacro(); }
  expectDispatches(g, FS_ORDER.length, 's3 after overlapping step()');
  g.state.release();
  await pump(rig.dom, { done: () => allAt(rig.coord, 1) });
  await sp.catch(() => {});
  assertMatchesReference('step-vs-pacestep', captureByFs(rig.sessions), reference, WRITE_KEYS);
}

// ---- Scenario 1b: realistic long run, flipping modes throughout ----
// End-to-end smoke (NOT the sharp per-guard guard - scenarios 1-3 are): N real
// commands drained while flipping race<->pace continuously must still land on the
// clean single-run fingerprint and stay cross-FS identical.
async function scenarioRealisticModeFlip() {
  console.log('\n[1b] realistic long run with continuous mode flips (smoke)');
  const ref = await (async () => {
    const rig = await makeRig();
    broadcastWrites(rig.coord, N);
    rig.coord.setMode('pace');
    await pump(rig.dom, { done: () => allAt(rig.coord, N) });
    return captureByFs(rig.sessions).byId;
  })();
  const rig = await makeRig();
  broadcastWrites(rig.coord, N);
  rig.coord.setMode('race');
  await pump(rig.dom, {
    done: () => allAt(rig.coord, N),
    each: (i) => { if (i % 2 === 0) rig.coord.setMode(rig.coord.mode === 'race' ? 'pace' : 'race'); },
  });
  assertMatchesReference('realistic-mode-flip', captureByFs(rig.sessions), ref);
}

// ---- Scenario 4: a rejecting command (throwing journal subscriber) ----
// FIX A: a per-session reject must RELEASE the busy lock and rewind (cursor
// stays at i) so the FS is recoverable, not frozen. We throw exactly ONCE on the
// probe command's 'live' transition for FASTFFS; the retry then succeeds. Assert
// the coordinator recovers (converges within bound - a frozen FS would time out)
// and stays cross-FS byte-identical (the redo is idempotent). Cost is NOT
// asserted here: command re-execution after an abort is the ADR-0019 model.
async function scenarioRejectingCommand() {
  console.log('\n[4] rejecting command releases the lock (FIX A)');
  const rig = await makeRig();
  rig.coord.setMode('pace');
  let thrown = false;
  const unsub = rig.byId.fastffs.onJournal((change) => {
    if (!thrown && change.type === 'update' && change.entry.state === 'live' && change.entry.text.includes('probe')) {
      thrown = true;
      throw new Error('boom - simulated throwing journal subscriber');
    }
  });
  rig.coord.broadcast(async (api) => { await api.writeFile('probe.bin', 5000); }, 'write probe');
  broadcastWrites(rig.coord, N);                         // N more normal writes behind it
  const total = N + 1;
  await pump(rig.dom, { done: () => allAt(rig.coord, total) });
  unsub();
  if (!thrown) fail('scenario 4: the throwing subscriber never fired (test did not exercise the reject path)');
  else ok('reject fired once, coordinator recovered and drained all commands (lock released, not frozen)');
  if (!allAt(rig.coord, total)) fail('scenario 4: cursors did not all reach the frontier after recovery');
  assertCrossFsIdentical('reject-recovery', captureByFs(rig.sessions));
}

// ---- Scenario 5: stop() aborting a NON-command churn step in its barrier
// window (FIX B). The churn write is applied synchronously by runEntry, then the
// round awaits the drain barrier; a stop() landing there MUST advance the cursor
// so resume does not re-apply the same churn op (double simNs/wear/divergence).
// We drive this deterministically without ticks: step()'s paceStep suspends at
// the barrier await, we stop() synchronously (resolving tok.promise unblocks the
// Promise.race), FIX B advances the cursor, then we run more steps and compare
// per-fsId cost to a clean run of the same step count. ----
async function scenarioAbortNonCommand() {
  console.log('\n[5] stop() aborts a churn step mid-barrier without double-applying (FIX B)');
  const M = 8;
  // clean reference: M produced steps, no interruption
  const ref = await makeRig();
  ref.coord.setMode('pace');
  for (let k = 0; k < M; k++) await stepToCompletion(ref);
  const refCap = captureByFs(ref.sessions).byId;

  // torture: interrupt the FIRST produced step in its barrier window, then run the rest.
  // step() suspends at the drain barrier BEFORE any tick, so stop() lands squarely in
  // the FIX B window; the abort resolves via tok.promise with no tick needed.
  const rig = await makeRig();
  rig.coord.setMode('pace');
  const p = rig.coord.step();     // produces step 0, applies it synchronously, suspends at the barrier await
  rig.coord.stop();               // aborts in the barrier window -> FIX B must advance the cursor
  await p;
  if (!allAt(rig.coord, 1)) fail(`scenario 5: cursor after aborted churn step is ${cursorsOf(rig.coord)}, expected [1,1] (FIX B must advance)`);
  else ok('aborted churn step advanced the cursor (no rewind of an already-applied churn op)');
  for (let k = 1; k < M; k++) await stepToCompletion(rig);
  const cap = captureByFs(rig.sessions);
  for (const fsId of FS_ORDER) {
    if (!statsEqualOn(cap.byId[fsId].stats, refCap[fsId].stats, ALL_KEYS)) fail(`scenario 5: ${fsId} cost diverged - churn step double-applied across the abort\n         ref : ${statsStr(refCap[fsId].stats)}\n         got : ${statsStr(cap.byId[fsId].stats)}`);
    else ok(`${fsId} cost matches clean ${M}-step run (${statsStr(cap.byId[fsId].stats)})`);
  }
  assertCrossFsIdentical('abort-non-command', cap);
}

// ---- Scenario 6: stop() aborting a multi-op command mid-drain, then resume ----
// The ADR-0019 command-abort model rewinds the cursor and re-issues the command
// fresh. A finite speed makes each multi-op command span several ticks so the
// stop lands INSIDE one. Assert the coordinator recovers (converges), the
// aborted command re-runs to completion, and both FS stay byte-identical.
async function scenarioAbortCommand() {
  console.log('\n[6] stop() aborts a command mid-drain, resumes cleanly (ADR-0019 rewind)');
  const rig = await makeRig({ speed: 20000 });     // finite: commands span multiple ticks
  rig.coord.setMode('pace');
  for (let k = 0; k < N; k++) {
    const a = `m${k}a.bin`, b = `m${k}b.bin`, sz = 4000 + k * 1500;
    rig.coord.broadcast(async (api) => { await api.writeFile(a, sz); await api.readFile(a); await api.writeFile(b, sz + 512); }, `cmd ${k}`);
  }
  let stopped = false;
  await pump(rig.dom, {
    done: () => allAt(rig.coord, N),
    each: () => { if (!stopped && minCursor(rig.coord) >= 2) { stopped = true; rig.coord.stop(); } },
    maxIter: 20000,
  });
  if (!stopped) fail('scenario 6: never reached a mid-drain point to stop() at');
  else ok('stop() landed mid-command; coordinator recovered and drained all commands');
  if (!allAt(rig.coord, N)) fail('scenario 6: cursors did not all reach the frontier after recovery');
  assertCrossFsIdentical('abort-command', captureByFs(rig.sessions));
}

// ---- Scenario 7: Pace->Race raceClock reseat = min(simNs); no burst, no jam ----
// The ADR-0020 fix: on setMode('pace'->'race') the shared raceClock is reseated to
// the LOWEST participant simNs. So the frontier FS (that min) paces from its first
// op (clock climbs past it), while an ahead FS (higher simNs) correctly STALLS until
// the clock overtakes it - it does NOT burst flat-out (stale-high clock bug) and the
// frontier is NOT jammed shut (stale-low/zero clock bug). We diverge the two FS in
// Pace (cursors equal, simNs differs by per-FS cost), queue fresh work, switch to
// Race at no-delay (deterministic clock chunks, independent of wall-clock dt), and
// assert on the first few race ticks: frontier advances into the new queue, ahead
// holds at the switch cursor and reads `stalled`. Uses a large batch so simNs (and
// the gap) dwarf the NO_DELAY clock chunk, making the reseat effect unambiguous.
async function scenarioRaceReseat() {
  console.log('\n[7] Pace->Race reseat: frontier paces, ahead FS stalls (no burst, no jam)');
  const BATCH = N;                                      // small writes: a big simNs gap without overflowing the chip
  const rig = await makeRig();                          // Infinity speed: clock jumps a fixed chunk per tick
  broadcastWrites(rig.coord, BATCH, 'a');
  rig.coord.setMode('pace');
  await pump(rig.dom, { done: () => allAt(rig.coord, BATCH) });
  const simNs = Object.fromEntries(rig.sessions.map((s) => [s.fsId, s.device.stats.simNs]));
  const ahead = simNs.fastffs >= simNs.littlefs ? 'fastffs' : 'littlefs';
  const frontier = ahead === 'fastffs' ? 'littlefs' : 'fastffs';
  const gap = Math.abs(simNs.fastffs - simNs.littlefs);
  if (gap <= 250 * 1e6) { fail(`s7 precondition: simNs gap ${gap} too small to distinguish stall from advance (need > 250ms)`); return; }
  ok(`diverged in Pace: ${frontier} simNs=${simNs[frontier]} (frontier), ${ahead} simNs=${simNs[ahead]} (ahead), gap=${(gap / 1e6).toFixed(0)}ms`);
  broadcastWrites(rig.coord, BATCH, 'b');              // fresh queued work for both, at cursor BATCH..2*BATCH-1
  rig.coord.setMode('race');
  for (let k = 0; k < 4; k++) { tickOnce(rig.dom); await flushMacro(); }   // baseline + a few working ticks (clock climb < the gap)
  const snaps = Object.fromEntries(rig.coord.snapshots().map((s) => [s.fsId, s]));
  if (snaps[frontier].stepCursor <= BATCH) fail(`s7: frontier ${frontier} did not advance after Pace->Race (raceClock not reseated to min -> jammed at cursor ${snaps[frontier].stepCursor})`);
  else ok(`frontier ${frontier} paced into the new queue (cursor ${BATCH} -> ${snaps[frontier].stepCursor}); clock reseated to min simNs`);
  if (snaps[ahead].stepCursor !== BATCH) fail(`s7: ahead ${ahead} advanced to ${snaps[ahead].stepCursor} (burst) instead of holding at ${BATCH}`);
  else ok(`ahead ${ahead} held at cursor ${BATCH} (no burst - above the reseated clock)`);
  if (!snaps[ahead].stalled) fail(`s7: ahead ${ahead} not flagged stalled while waiting for the clock to climb`);
  else ok(`ahead ${ahead} correctly flagged stalled`);
  if (snaps[frontier].stalled) fail(`s7: frontier ${frontier} wrongly flagged stalled while it is the one racing`);
  else ok(`frontier ${frontier} not stalled (it is racing)`);
}

// ---- Scenario 8: reset() and setSessions cleanup ----
// reset() must give a byte-for-byte reproducible run (chip freshly formatted,
// cursors 0, sequence + queued commands cleared, churn + cmdRng re-seeded, race
// clock zeroed); a stale carryover in any of those diverges the second run.
// setSessions() dropping a session must delete its per-session Map state so a
// re-added session starts at cursor 0 (not a retained stale cursor), and a late
// command settle for an already-removed session must not wedge or resurrect it.
async function scenarioResetAndSetSessions() {
  console.log('\n[8] reset() reproducibility + setSessions cleanup');
  // (a) reset() reproducibility. Uses PRODUCED (churn/gc) steps, not fixed
  // broadcasts, so the check exercises every piece reset() must clear/re-seed:
  // chip freshFormat, cursors 0, sequence cleared, the gc/event coin (rnd) AND the
  // churn model re-seeded. A stale carryover in any of them diverges run 2 - a
  // re-broadcast of identical commands would reproduce by accident and hide it.
  const M = 8;
  const rig = await makeRig();
  rig.coord.setMode('pace');
  for (let k = 0; k < M; k++) await stepToCompletion(rig);
  const cap1 = captureByFs(rig.sessions).byId;
  rig.coord.reset();
  if (!allAt(rig.coord, 0)) fail('reset: cursors not zeroed');
  else if (rig.sessions.some((s) => s.runner.names().length)) fail('reset: chip not empty after reset (files remain)');
  else ok('reset: cursors zeroed and both chips freshly formatted');
  for (let k = 0; k < M; k++) await stepToCompletion(rig);
  const cap2 = captureByFs(rig.sessions).byId;
  for (const fsId of FS_ORDER) {
    if (!statsEqualOn(cap1[fsId].stats, cap2[fsId].stats, ALL_KEYS) || !fileMapsEqual(cap1[fsId].files, cap2[fsId].files)) {
      fail(`reset: ${fsId} second ${M}-step run diverged from the first (stale sequence/cursor/churn/rnd/chip carryover)\n         run1: ${statsStr(cap1[fsId].stats)}\n         run2: ${statsStr(cap2[fsId].stats)}`);
    } else ok(`reset: ${fsId} re-run is byte-for-byte reproducible (${statsStr(cap2[fsId].stats)})`);
  }

  // (b) setSessions drops a removed session's cursor -> re-add starts fresh at 0
  const rig2 = await makeRig();
  broadcastWrites(rig2.coord, 3);
  rig2.coord.setMode('pace');
  await pump(rig2.dom, { done: () => allAt(rig2.coord, 3) });     // both at cursor 3
  rig2.coord.setSessions([rig2.byId.fastffs]);                    // remove littlefs (was at cursor 3)
  const s1 = rig2.coord.snapshots();
  if (s1.length !== 1 || s1[0].fsId !== 'fastffs') fail(`setSessions: snapshots still includes the removed session (${s1.map((x) => x.fsId)})`);
  else ok('setSessions: removed session gone from snapshots()');
  rig2.coord.setSessions([rig2.byId.fastffs, rig2.byId.littlefs]);   // re-add littlefs
  const lf = rig2.coord.snapshots().find((x) => x.fsId === 'littlefs');
  if (!lf || lf.stepCursor !== 0) fail(`setSessions: re-added session cursor is ${lf && lf.stepCursor}, expected 0 (stale cursor retained instead of dropped)`);
  else ok('setSessions: re-added session starts at cursor 0 (stale cursor was dropped)');

  // (c) a late command settle for an already-removed session must not wedge/crash
  const rig3 = await makeRig();
  const g = gatedCommand();
  rig3.coord.broadcast(g.fn, 'gated s8');
  rig3.coord.setMode('race');
  await pumpUntil(rig3.dom, () => g.state.atGate >= FS_ORDER.length, 's8-window');   // both busy, parked mid-command
  rig3.coord.setSessions([rig3.byId.fastffs]);                    // remove littlefs WHILE its command is in-flight
  g.state.release();
  await pump(rig3.dom, { done: () => (rig3.coord.snapshots()[0]?.stepCursor ?? 0) >= 1, maxIter: 4000 });
  const s3 = rig3.coord.snapshots();
  if (s3.length !== 1 || s3[0].fsId !== 'fastffs') fail(`setSessions: removed-mid-command session leaked back into snapshots (${s3.map((x) => x.fsId)})`);
  else if (s3[0].stepCursor !== 1) fail(`setSessions: surviving session did not complete after a peer was removed mid-command (cursor ${s3[0].stepCursor})`);
  else ok('setSessions: removing a session mid-command did not wedge the survivor; its late settle was a guarded no-op');
}

// ---- Scenario 9: opsPerSec tracks WORKLOAD ops (stepCursor), never flash ops ----
// ADR-0020: snapshots().opsPerSec is the EMA rate of stepCursor (sequence steps
// consumed), NOT device flash ops (reads+programs+erases). The original defect
// measured flash ops, so chatty LittleFS posted a huge ops/sec while doing LESS
// real work. In Pace the two FS consume workload steps in lockstep (equal
// cursors), so opsPerSec must be EQUAL across FS even though their flash-op counts
// differ - a flash-ops metric would skew the two apart. We run both under real
// churn, then assert opsPerSec is positive, equal across FS, and decoupled from
// the flash-op gap. Mutation (opsOf -> reads+programs+erases) makes them diverge.
async function scenarioOpsPerSecWorkload() {
  console.log('\n[9] opsPerSec tracks WORKLOAD ops (stepCursor), never flash ops');
  const rig = await makeRig();                          // Infinity: cursors advance briskly
  rig.coord.setMode('pace');
  rig.coord.start();                                    // real auto-churn
  for (let k = 0; k < 120; k++) { tickOnce(rig.dom); await flushMacro(); }
  const snaps = Object.fromEntries(rig.coord.snapshots().map((s) => [s.fsId, s]));
  const ff = snaps.fastffs, lf = snaps.littlefs;
  const flashOps = (fsId) => { const t = rig.byId[fsId].device.stats; return t.reads + t.programs + t.erases; };
  if (ff.stepCursor !== lf.stepCursor) fail(`[9] pace cursors not in lockstep (${ff.stepCursor} vs ${lf.stepCursor}) - cannot compare opsPerSec`);
  else ok(`workload cursors in lockstep at ${ff.stepCursor} (stepCursor advances 1:1 with steps consumed)`);
  const fo = { fastffs: flashOps('fastffs'), littlefs: flashOps('littlefs') };
  const flashRatio = Math.max(fo.fastffs, fo.littlefs) / Math.min(fo.fastffs, fo.littlefs);
  if (flashRatio < 1.1) fail(`[9] precondition: flash ops too similar (${fo.fastffs} vs ${fo.littlefs}) to distinguish the two metrics`);
  else ok(`flash ops differ ${flashRatio.toFixed(2)}x between FS (ff ${fo.fastffs}, lf ${fo.littlefs}) - a flash-ops metric WOULD skew them apart`);
  if (!(ff.opsPerSec > 0) || !(lf.opsPerSec > 0)) { fail(`[9] opsPerSec not positive during an active run (ff ${ff.opsPerSec}, lf ${lf.opsPerSec})`); return; }
  const d = Math.abs(ff.opsPerSec - lf.opsPerSec);
  if (d > 1e-6 * Math.max(ff.opsPerSec, lf.opsPerSec)) fail(`[9] opsPerSec diverges between FS (ff ${ff.opsPerSec}, lf ${lf.opsPerSec}) - measuring flash ops, not workload ops?`);
  else ok(`opsPerSec equal across FS (${ff.opsPerSec.toFixed(3)} ops/s) despite the ${flashRatio.toFixed(1)}x flash-op gap - it is the workload-op rate`);
}

// ---- Scenario 10: Race `stalled` - SET after divergence, never both, CLEAR ----
// stalled is the exact indicator that silently never fired before. After a
// Pace->Race divergence the ahead FS (higher simNs) sits above the reseated clock
// and reads stalled=true; the frontier FS (the clock floor, min simNs) never does.
// It clears once the race drains to idle (raceTick re-baselines lastTickNow, and
// `stalled` is gated on lastTickNow!==0). Clock driven by no-delay chunks, not
// wall-clock dt. NOTE: "steady race never stalls" is NOT asserted - a single
// LittleFS op's simNs cost exceeds STALL_GAP_NS (50ms), so the chattier FS
// transiently overshoots the frontier by > the threshold even without a prior
// Pace divergence (a real property of the current threshold; see TEST-GAPS).
async function scenarioRaceStalled() {
  console.log('\n[10] Race stalled: sets for the ahead FS, never both, clears on drain-to-idle');
  const rig = await makeRig();
  broadcastWrites(rig.coord, N, 'a');
  rig.coord.setMode('pace');
  await pump(rig.dom, { done: () => allAt(rig.coord, N) });
  if (rig.coord.snapshots().some((s) => s.stalled)) fail('[10] stalled flagged in Pace mode (mode guard broken)');
  else ok('stalled is false in Pace mode (mode guard)');
  const simNs = Object.fromEntries(rig.sessions.map((s) => [s.fsId, s.device.stats.simNs]));
  const ahead = simNs.fastffs >= simNs.littlefs ? 'fastffs' : 'littlefs';
  broadcastWrites(rig.coord, N, 'b');                   // fresh queued work
  rig.coord.setMode('race');
  let sawAheadStalled = false, sawBoth = false, drained = false;
  for (let t = 0; t < 300 && !drained; t++) {
    tickOnce(rig.dom); await flushMacro();
    const s = Object.fromEntries(rig.coord.snapshots().map((x) => [x.fsId, x]));
    if (s[ahead].stalled) sawAheadStalled = true;
    if (s.fastffs.stalled && s.littlefs.stalled) sawBoth = true;
    drained = s.fastffs.stepCursor === 2 * N && s.littlefs.stepCursor === 2 * N;
  }
  if (!sawAheadStalled) fail(`[10] ahead FS (${ahead}) never flagged stalled after a Pace->Race divergence (the indicator that silently never fired)`);
  else ok(`ahead FS (${ahead}) flagged stalled after the Pace->Race divergence`);
  if (sawBoth) fail('[10] both FS flagged stalled at once (the frontier holds the clock floor and is never stalled)');
  else ok('never both FS stalled at once');
  if (!drained) { fail('[10] queued work never drained under race (cannot observe the stall clear)'); return; }
  for (let t = 0; t < 20; t++) { tickOnce(rig.dom); await flushMacro(); }   // let the idle re-baseline land
  if (rig.coord.snapshots().some((s) => s.stalled)) fail('[10] stalled did not clear after the race drained to idle');
  else ok('stalled cleared once the race drained to idle (lastTickNow re-baselined)');
}

// ---- Scenario 11: Pace `holding` - SET for the cursor-lead FS, CLEAR on converge ----
// After a Race->Pace switch a session whose cursor LEADS the shared min (it raced
// ahead) is parked in the round's barrier with nothing new to run until the
// laggard reaches it: holding=true. It clears once the laggard converges to its
// cursor. Mutation (drop the `cursor > minCursor` term) makes the lead never flag.
async function scenarioPaceHolding() {
  console.log('\n[11] Pace holding: sets for the cursor-lead FS, clears on convergence');
  const rig = await makeRig();
  rig.coord.setMode('race');
  rig.coord.start();                                    // race diverges cursors (cheaper FS gets ahead)
  await pump(rig.dom, { done: () => (maxCursor(rig.coord) - minCursor(rig.coord)) >= 3, maxIter: 600 });
  if (rig.coord.snapshots().some((s) => s.holding)) fail('[11] holding flagged in Race mode (mode guard broken)');
  else ok('holding is false in Race mode (mode guard)');
  rig.coord.stop();
  rig.coord.setMode('pace');
  const s0 = Object.fromEntries(rig.coord.snapshots().map((s) => [s.fsId, s]));
  const lead = s0.fastffs.stepCursor >= s0.littlefs.stepCursor ? 'fastffs' : 'littlefs';
  const lag = lead === 'fastffs' ? 'littlefs' : 'fastffs';
  if (s0[lead].stepCursor <= s0[lag].stepCursor) { fail('[11] failed to create a cursor lead in Race'); return; }
  ok(`race left a cursor lead: ${lead} at ${s0[lead].stepCursor}, ${lag} at ${s0[lag].stepCursor}`);
  if (!s0[lead].holding) fail(`[11] cursor-lead FS (${lead}) not flagged holding after Race->Pace`);
  else ok(`cursor-lead FS (${lead}) flagged holding (parked waiting for the laggard)`);
  if (s0[lag].holding) fail(`[11] laggard FS (${lag}) wrongly flagged holding (it is the one advancing)`);
  else ok(`laggard FS (${lag}) not holding`);
  await pump(rig.dom, { done: () => minCursor(rig.coord) === maxCursor(rig.coord), maxIter: 600 });
  const s1 = Object.fromEntries(rig.coord.snapshots().map((s) => [s.fsId, s]));
  if (s1[lead].holding || s1[lag].holding) fail(`[11] holding did not clear on convergence (cursors equal at ${s1[lead].stepCursor})`);
  else ok('holding cleared once cursors converged');
}

// ---- Scenario 12: `waiting` (Race) - clock-blocked FS reads waiting, then clears ----
// The instantaneous per-frame "sim paused" signal. In Race a session whose simNs
// has caught the shared raceClock cannot dispatch its next op until the clock
// advances -> waiting=true. After a Pace->Race divergence the ahead FS is
// clock-blocked (way above the reseated clock); it clears once work drains to idle
// (hasWork false). snapshots().waiting and the cheap waitStates() must agree, and
// waiting must be false when stopped with nothing queued. Mutation (invert the
// gate to simNs < raceClock) -> the ahead FS never flags.
async function scenarioWaitingRace() {
  console.log('\n[12] waiting (Race): a clock-blocked FS reads waiting, clears on drain');
  const rig = await makeRig();
  if (Object.values(rig.coord.waitStates()).some(Boolean)) fail('[12] waiting true while stopped with nothing queued');
  else ok('waiting is false when stopped with nothing to run');
  broadcastWrites(rig.coord, N, 'a');
  rig.coord.setMode('pace');
  await pump(rig.dom, { done: () => allAt(rig.coord, N) });
  const simNs = Object.fromEntries(rig.sessions.map((s) => [s.fsId, s.device.stats.simNs]));
  const ahead = simNs.fastffs >= simNs.littlefs ? 'fastffs' : 'littlefs';
  const frontier = ahead === 'fastffs' ? 'littlefs' : 'fastffs';
  broadcastWrites(rig.coord, N, 'b');
  rig.coord.setMode('race');
  // A few working race ticks: the shared clock climbs a little but is still well
  // below the ahead FS's simNs (the divergence is far larger than the per-tick
  // clock chunk), so the ahead FS is clock-blocked NOW -> waiting=true. Asserting
  // waiting WHILE STILL DIVERGED (not merely "ever") rejects an inverted gate,
  // which would only flag it LATER once the clock overtakes it.
  for (let t = 0; t < 3; t++) { tickOnce(rig.dom); await flushMacro(); }
  const gap = rig.byId[ahead].device.stats.simNs - rig.byId[frontier].device.stats.simNs;
  const ws = rig.coord.waitStates();
  const snapW = Object.fromEntries(rig.coord.snapshots().map((s) => [s.fsId, s.waiting]));
  if (FS_ORDER.some((f) => ws[f] !== snapW[f])) fail('[12] waitStates() and snapshots().waiting disagreed');
  else ok('waitStates() and snapshots().waiting agree');
  if (gap <= 150 * 1e6) fail(`[12] precondition: clock caught up too fast (gap ${(gap / 1e6).toFixed(0)}ms) to observe a clock-block`);
  else if (!ws[ahead]) fail(`[12] ahead FS (${ahead}) not waiting while clock-blocked (simNs ${(rig.byId[ahead].device.stats.simNs / 1e6).toFixed(0)}ms still ${(gap / 1e6).toFixed(0)}ms above the frontier)`);
  else ok(`ahead FS (${ahead}) read waiting while clock-blocked (still ${(gap / 1e6).toFixed(0)}ms above the frontier)`);
  // drain to idle -> waiting clears (hasWork false at the frontier)
  await pump(rig.dom, { done: () => allAt(rig.coord, 2 * N), maxIter: 400 });
  for (let t = 0; t < 20; t++) { tickOnce(rig.dom); await flushMacro(); }
  if (Object.values(rig.coord.waitStates()).some(Boolean)) fail('[12] waiting did not clear after the race drained to idle');
  else ok('waiting cleared once the race drained to idle');
}

// A finite speed where one Pace round's op-animation spans several frames, so the
// cheaper FS resolves its barrier (and reads waiting, parked on the peer) a frame
// or more before the chattier one. Infinity drains a whole round in one frame (no
// window); the shipped speed is realistically far slower under the fake clock.
const PACE_WAIT_SPEED = 5e6;

// ---- Scenario 13: `waiting` (Pace) - peer-waiting FS reads waiting, then clears ----
// A session that finishes its round's op (its barrier resolves) while the slower
// peer has not is parked waiting -> waiting=true; it clears when the round
// advances. Driven by real churn at a finite speed so the two FS resolve their
// barriers a frame apart. Mutation (drop the barrier-arrival instrumentation) ->
// peer-wait never fires in a non-command run.
async function scenarioWaitingPacePeer() {
  console.log('\n[13] waiting (Pace): a peer-waiting FS reads waiting, clears when the round advances');
  const rig = await makeRig({ speed: PACE_WAIT_SPEED });
  rig.coord.setMode('pace');
  rig.coord.start();
  let sawPeerWait = false, sawCleared = false;
  for (let t = 0; t < 3000 && !(sawPeerWait && sawCleared); t++) {
    tickOnce(rig.dom); await flushMacro();
    const ws = rig.coord.waitStates();
    const n = FS_ORDER.filter((f) => ws[f]).length;
    if (n === 1) sawPeerWait = true;                 // exactly one parked, waiting on its slower peer
    else if (sawPeerWait && n === 0) sawCleared = true;   // later nobody waiting = the round advanced
  }
  if (!sawPeerWait) fail('[13] no Pace session ever read waiting while parked on a slower peer');
  else ok('a Pace session read waiting while parked on its slower peer');
  if (!sawCleared) fail('[13] Pace waiting never cleared (round-advance did not release it)');
  else ok('Pace waiting cleared once the round advanced');
}

// ---- Scenario 14 (KEY REGRESSION): `waiting` is FALSE while an op executes or its
// animation drains ----
// The exact failure mode of the naive "simNs did not move this tick" approach:
// during a long op's post-execution animation drain simNs is flat, and that must
// NOT read as paused. We drive real churn at a finite speed (ops animate over many
// frames) and assert the INVARIANT: any session actively animating (pending() > 0)
// reads waiting=FALSE, every frame. Mutation (make Pace waiting fire while
// animating, e.g. `pending() > 0`) -> this FAILs.
async function scenarioWaitingNotWhileAnimating() {
  console.log('\n[14] waiting is FALSE while an op executes / animates (the naive-simNs regression)');
  const rig = await makeRig({ speed: PACE_WAIT_SPEED });
  rig.coord.setMode('pace');
  rig.coord.start();
  let sawAnimating = false, bug = false, bugWho = '';
  for (let t = 0; t < 900; t++) {
    tickOnce(rig.dom); await flushMacro();
    const ws = rig.coord.waitStates();
    for (const s of rig.sessions) {
      if (s.pending() > 0) {                          // actively animating a completed op (simNs flat)
        sawAnimating = true;
        if (ws[s.fsId]) { bug = true; bugWho = s.fsId; }
      }
    }
  }
  if (!sawAnimating) fail('[14] never observed a session animating (test did not exercise the drain path)');
  else ok('exercised many op-animation drains (pending() > 0 while simNs flat)');
  if (bug) fail(`[14] a session (${bugWho}) read waiting WHILE actively animating an op - the naive-simNs regression`);
  else ok('no actively-animating session ever read waiting (execution/animation is not paused)');
}

// ---- Scenario 15 (KEY REGRESSION, RACE): `waiting` is FALSE while a RACE op
// executes / animates ----
// The Race analog of [14]. In Race each session runs SYNCHRONOUSLY up to the
// shared clock every tick (raceTick's while-loop advances a session until its
// simNs catches raceClock), so AT REST between ticks its simNs sits at/above
// raceClock while the ops it just dispatched are still animating (pending() > 0).
// The Race waiting gate looked only at `hasWork && simNs >= raceClock` - so it
// reported that RUNNING/animating state as waiting=true. Symptom the user hit in
// Race: a busy FS card reads "waiting" and the CS pin (lit when NOT waiting) is
// dark for the whole race. Assert the INVARIANT: any session actively animating
// (pending() > 0) reads waiting=FALSE, every frame, in Race. Mutation (drop the
// busy/pending running-guard) -> this FAILs.
async function scenarioWaitingNotWhileAnimatingRace() {
  console.log('\n[15] waiting is FALSE while a RACE op executes / animates (a running FS is not paused)');
  const rig = await makeRig({ speed: PACE_WAIT_SPEED });
  rig.coord.setMode('race');
  rig.coord.start();
  let sawAnimating = false, bug = false, bugWho = '';
  for (let t = 0; t < 900; t++) {
    tickOnce(rig.dom); await flushMacro();
    const ws = rig.coord.waitStates();
    for (const s of rig.sessions) {
      if (s.pending() > 0) {                          // actively animating a dispatched op (simNs at/above the clock)
        sawAnimating = true;
        if (ws[s.fsId]) { bug = true; bugWho = s.fsId; }
      }
    }
  }
  if (!sawAnimating) fail('[15] never observed a Race session animating (test did not exercise the drain path)');
  else ok('exercised many Race op-animation drains (pending() > 0 while simNs at/above the clock)');
  if (bug) fail(`[15] a session (${bugWho}) read waiting WHILE actively animating a Race op - a running FS misreported as paused`);
  else ok('no actively-animating Race session ever read waiting (execution/animation is not paused)');
}

// ---- run all ----
console.log('lockstep concurrency / no-double-execution suite (real coordinator + real WASM)\n');
console.log('[0] exactly-once reference for a single gated command');
const reference = await buildGatedReference();
await scenarioModeFlip(reference);
await scenarioStepVsRaceTick(reference);
await scenarioStepVsPaceStep(reference);
await scenarioRealisticModeFlip();
await scenarioRejectingCommand();
await scenarioAbortNonCommand();
await scenarioAbortCommand();
await scenarioRaceReseat();
await scenarioResetAndSetSessions();
await scenarioOpsPerSecWorkload();
await scenarioRaceStalled();
await scenarioPaceHolding();
await scenarioWaitingRace();
await scenarioWaitingPacePeer();
await scenarioWaitingNotWhileAnimating();
await scenarioWaitingNotWhileAnimatingRace();

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - busy lock holds: every forced interleaving ran each sequence step exactly once');
console.log('       (per-fsId device cost matched the clean single run; both FS byte-identical);');
console.log('       reject/abort paths released the lock and recovered without freezing an FS.');
process.exit(0);
