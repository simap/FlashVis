/*
 * coord-wire-test.mjs, ADR-0024 coordinator over the WIRE (lane C's own suite).
 *
 * Drives the rebuilt lockstep coordinator (web/src/lockstep.js) through the real
 * protocol.js message envelopes, over the faithful mock transport (structuredClone +
 * async queued delivery), against a pair of mock session workers. NO WASM, NO real
 * session, the point is to prove the §2 clock-release algebra and its grant/ack/round
 * barrier end to end, and that the standing signals are correctly DERIVED from ack
 * state alone (the old synchronous device/pending reads are gone): `holding` (the
 * SUSTAINED fast-FS-frozen-at-the-join wait, debounced) and `csActive` (the RAW
 * per-frame CS-pin blinky). See spec/ui.md for the two contracts.
 *
 * Two workers model a "cheap" FS (fastffs, 1e6 ns/op) and a "pricey" FS (littlefs,
 * 5e6 ns/op) so a Race under an identical playback ceiling diverges in step count
 * while playback stays level, the ADR-0016 comparison, and a Pace stays in cursor
 * lockstep while playback (cost) diverges.
 */
// Deterministic default for the fake-clock _tick polling: no hold debounce, so the
// raw hold predicate passes straight through to `holding`. The debounce timing itself
// is checked separately (testHoldDebounce, which flips this back on real time).
globalThis.__flashvisHoldShowMs = 0;
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
import { createMockWorker } from './mock-worker.mjs';
import { createSessionProxy } from '../web/src/session-proxy.js';
import { createLockstep } from '../web/src/lockstep.js';
import { createChurnModel } from '../web/src/churn.js';

process.on('unhandledRejection', (e) => { console.error('\nFAIL - unhandled rejection:', (e && e.stack) || e); process.exit(1); });

const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const CHURN_CFG = { seed: 0x00c0ffee, targetLiveBytes: 96 * 1024, targetWrittenBytes: 0xffffffff, targetSlackBytes: 16 * 1024, forceLargeAfterBytes: 0xffffffff };
const FS_ORDER = ['fastffs', 'littlefs'];
const UNITS = { fastffs: 1e6, littlefs: 5e6 };

let failures = 0;
const fail = (m) => { failures++; console.error('  FAIL - ' + m); };
const ok = (m) => console.log('  ok   - ' + m);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function makeRig({ speed = 1e7, units = UNITS, maxOpsPerGrant = 64, caps = null } = {}) {   // 1e7 = MAX_SCALE (the value setSpeed clamps to)
  const churn = createChurnModel(CHURN_CFG);
  const coord = createLockstep({ churn, autoTick: false });
  const workers = {};
  const proxies = [];
  for (const fsId of FS_ORDER) {
    const { mainPort, workerPort } = createTransport();
    const cap = caps && caps[fsId] != null ? caps[fsId] : maxOpsPerGrant;   // per-FS exec cap (models exec-bound FS)
    workers[fsId] = createMockWorker(workerPort, { unit: units[fsId], maxOpsPerGrant: cap });
    proxies.push(createSessionProxy(mainPort, { fsId, name: fsId, geometry: GEOMETRY }));
  }
  coord.setSessions(proxies);
  coord.reset();
  coord.setSpeed(speed);
  return { coord, proxies, workers, byId: Object.fromEntries(proxies.map((p) => [p.fsId, p])) };
}

// One coordinator frame + enough macrotask turns to deliver grant→worker and ack→proxy.
async function frame(rig, sampleEach) {
  rig.coord._tick();
  await flushTurns(2);
  if (sampleEach) sampleEach();
}
async function run(rig, n, sampleEach) { for (let i = 0; i < n; i++) await frame(rig, sampleEach); }

const snapById = (rig) => Object.fromEntries(rig.coord.snapshots().map((s) => [s.fsId, s]));
const pb = (rig, fsId) => rig.byId[fsId].acked.playbackNs;

// ---------------------------------------------------------------------------
async function testHandshake() {
  console.log('\n[1] init/reset handshake: workers adopt the coordinator epoch (I5)');
  const rig = makeRig();
  await flushTurns(4);
  const e = rig.coord.epoch;
  if (rig.workers.fastffs.epoch !== e || rig.workers.littlefs.epoch !== e) fail(`workers did not adopt epoch ${e} (got ${rig.workers.fastffs.epoch}, ${rig.workers.littlefs.epoch})`);
  else ok(`both workers on epoch ${e} after setSessions+reset`);
}

// ---------------------------------------------------------------------------
async function testRaceDivergence() {
  console.log('\n[2] RACE slow-mo: cheap FS out-steps pricey in cursor, playback LEVEL within bounded-MAX (§2)');
  // SUB-OP pacing (scale 5e4 = ~1/20 real-time, chunk 0.83ms/frame, below BOTH op costs
  // fastffs 1ms / littlefs 5ms): playback, not the entry window, is the binding
  // constraint, so the §2 clock paces. Cheap FS drains MORE entries to fill the same
  // shared playback ceiling, and the bounded-MAX keeps the playback gap within ~2 chunks.
  const scale = 5e4;
  const chunk = scale * (1000 / 60);   // Δ per frame (sim-ns)
  const rig = makeRig({ speed: scale });
  await flushTurns(4);
  rig.coord.setMode('race');
  rig.coord.start();
  await run(rig, 60);
  const s = snapById(rig);
  const cur = { fastffs: s.fastffs.stepCursor, littlefs: s.littlefs.stepCursor };
  if (!(cur.fastffs > cur.littlefs)) fail(`cheap FS did not out-step pricey FS (fastffs ${cur.fastffs} vs littlefs ${cur.littlefs})`);
  else ok(`cheap FS out-stepped pricey ${(cur.fastffs / Math.max(cur.littlefs, 1)).toFixed(1)}x (fastffs ${cur.fastffs}, littlefs ${cur.littlefs}), the comparison`);
  // Playback LEVEL = the bounded-MAX gap: the granted ceilings differ by <= 2 chunks, and
  // actual playback overshoots its ceiling by at most one (pricey) op, so gap <= 2Δ + op.
  const a = pb(rig, 'fastffs'), b = pb(rig, 'littlefs');
  const gap = Math.abs(a - b);
  const bound = 2 * chunk + UNITS.littlefs;   // 2Δ + one pricey-op overshoot
  if (gap > bound) fail(`playback NOT level: gap ${(gap / 1e6).toFixed(2)}ms > bound 2Δ+op ${(bound / 1e6).toFixed(2)}ms (2Δ=${(2 * chunk / 1e6).toFixed(2)}ms), ceiling not shared`);
  else ok(`playback level: gap ${(gap / 1e6).toFixed(2)}ms <= bound 2Δ+op ${(bound / 1e6).toFixed(2)}ms (2Δ=${(2 * chunk / 1e6).toFixed(2)}ms), one shared bounded-MAX ceiling`);
  // round barrier: both workers acked the same advancing round (I2)
  const rounds = FS_ORDER.map((f) => rig.byId[f].acked.round);
  if (rounds[0] < 5 || Math.abs(rounds[0] - rounds[1]) > 1) fail(`round barrier off: acked rounds ${rounds} (should advance together, ≥1 apart at most)`);
  else ok(`round advanced in lockstep barrier: both acked round ~${rounds[0]} (I2)`);
}

// ---------------------------------------------------------------------------
async function testRaceCommand() {
  console.log('\n[3] RACE: a broadcast command drains on every worker (quiescence = ack, I1)');
  const rig = makeRig({ speed: 1e7 });
  await flushTurns(4);
  rig.coord.setMode('race');
  const { index } = rig.coord.broadcast({ ops: [1, 1, 1] }, 'write x3');   // 3-op atomic command at the frontier
  rig.coord.start();
  await run(rig, 30);
  const drained = FS_ORDER.every((f) => rig.byId[f].acked.entriesDrained >= index);
  if (!drained) fail(`command at index ${index} not drained on every worker (drained: ${FS_ORDER.map((f) => rig.byId[f].acked.entriesDrained)})`);
  else ok(`command index ${index} executed + drained on both workers (cursors past it)`);
  const writes = FS_ORDER.map((f) => rig.workers[f].execNs > 0);
  if (!writes.every(Boolean)) fail('a worker reported no execution');
  else ok('both workers metered real playback for the command');
}

// ---------------------------------------------------------------------------
async function testPaceLockstep() {
  console.log('\n[4] PACE: cursors stay in lockstep, join advances one step at a time');
  const rig = makeRig({ speed: 1e7 });
  await flushTurns(4);
  rig.coord.setMode('pace');
  rig.coord.start();
  let maxGap = 0;
  await run(rig, 40, () => {
    const s = snapById(rig);
    maxGap = Math.max(maxGap, Math.abs(s.fastffs.stepCursor - s.littlefs.stepCursor));
  });
  const s = snapById(rig);
  if (maxGap > 1) fail(`pace cursors diverged (max gap ${maxGap}), the join let a session get ahead`);
  else ok(`pace cursors never diverged (max gap ${maxGap}), ∀ entriesDrained ≥ sharedIndex join holds`);
  if (s.fastffs.stepCursor < 5) fail(`pace made no progress (cursor ${s.fastffs.stepCursor})`);
  else ok(`pace advanced to cursor ${s.fastffs.stepCursor}, both equal`);
  // playback (cost) DOES diverge under Pace, same steps, different per-op cost
  const a = pb(rig, 'fastffs'), b = pb(rig, 'littlefs');
  if (!(b > a * 1.5)) fail(`pace playback did not diverge by cost (fastffs ${a}, littlefs ${b})`);
  else ok(`pace playback diverged by cost: littlefs ${(b / a).toFixed(1)}x fastffs (equal steps, unequal flash time)`);
}

// ---------------------------------------------------------------------------
// (a) The SUSTAINED Pace hold (the product's whole point): a fast FS finishes the
// shared step and sits FROZEN at the join, for many consecutive frames, while the
// slow peer grinds. Speed is chosen so chunk sits BETWEEN the two per-op costs, so the
// fast FS clears the multi-op step in a couple of frames and the slow FS takes many.
async function testSustainedPaceHold() {
  console.log('\n[5] PACE: sustained hold, fast FS frozen at the join for many frames while slow grinds');
  const rig = makeRig({ speed: 180000, units: { fastffs: 1e6, littlefs: 5e6 } });   // chunk ≈ 3e6: fast ≥3 ops/frame, slow ~1
  await flushTurns(4);
  rig.coord.setMode('pace');
  const { index } = rig.coord.broadcast({ ops: Array(12).fill(1) }, 'cmd x12');       // a heavy multi-op step
  let fastHoldRun = 0, maxFastHoldRun = 0, sawSlowHold = false, sawFastFrozenActive = false, sawCleared = false, everFastHeld = false;
  await run(rig, 120, () => {
    const s = snapById(rig);
    const slowStillOnStep = rig.byId.littlefs.acked.entriesDrained < index;   // slow hasn't finished the command
    // fast holds while slow still works the same step
    if (s.fastffs.holding && !s.littlefs.holding) { fastHoldRun += 1; maxFastHoldRun = Math.max(maxFastHoldRun, fastHoldRun); everFastHeld = true; }
    else { if (everFastHeld && !s.fastffs.holding && !slowStillOnStep) sawCleared = true; fastHoldRun = 0; }
    if (s.littlefs.holding && slowStillOnStep) sawSlowHold = true;             // the laggard must NEVER read holding
    if (s.fastffs.holding && s.fastffs.csActive) sawFastFrozenActive = true;   // a held FS is frozen -> csActive must be false
  });
  const drained = FS_ORDER.every((f) => rig.byId[f].acked.entriesDrained >= index);
  if (!drained) fail(`pace command not drained on both (entriesDrained ${FS_ORDER.map((f) => rig.byId[f].acked.entriesDrained)})`);
  else ok('pace command drained on both workers');
  if (maxFastHoldRun < 3) fail(`fast FS hold was a flicker, not sustained (longest run ${maxFastHoldRun} frames), the join hold is meant to persist`);
  else ok(`fast FS held FROZEN at the join for ${maxFastHoldRun} consecutive frames while slow ground the step (the sustained Pace hold)`);
  if (sawSlowHold) fail('slow FS (the laggard) wrongly read holding while it was the one still working');
  else ok('slow FS never read holding while it was the laggard (only the waited-ON fast FS holds)');
  if (sawFastFrozenActive) fail('a holding FS also read csActive=true (a frozen FS must not read active)');
  else ok('the holding FS read csActive=false throughout (frozen, not advancing)');
  if (!sawCleared) fail('fast FS hold never cleared after the step advanced');
  else ok('fast FS hold cleared once the shared step advanced (join released)');
}

// ---------------------------------------------------------------------------
async function testReseatBurstNoStall() {
  console.log('\n[6] PACE→RACE reseat: the BEHIND FS burns headroom to catch up (§2 MAX, not a stall)');
  const rig = makeRig({ speed: 1e7, maxOpsPerGrant: 64 });
  await flushTurns(4);
  rig.coord.setMode('pace');
  rig.coord.start();
  await run(rig, 24);
  const before = { fastffs: pb(rig, 'fastffs'), littlefs: pb(rig, 'littlefs') };
  const gap = Math.abs(before.fastffs - before.littlefs);
  if (gap <= 50 * 1e6) { fail(`precondition: playback gap ${(gap / 1e6).toFixed(0)}ms too small to observe reseat`); return; }
  const behind = before.fastffs < before.littlefs ? 'fastffs' : 'littlefs';   // cheap FS = lower playback = behind on the ceiling
  ok(`pace diverged playback: fastffs ${(before.fastffs / 1e6).toFixed(0)}ms, littlefs ${(before.littlefs / 1e6).toFixed(0)}ms (gap ${(gap / 1e6).toFixed(0)}ms); ${behind} is behind`);
  const curBefore = rig.byId[behind].acked.cursor;
  const ahead = behind === 'fastffs' ? 'littlefs' : 'fastffs';
  rig.coord.setMode('race');
  // race frames: the behind FS BURSTS (cursor jumps) as it burns its extra headroom to
  // catch up. The Pace gap exceeds the bounded-MAX bound, so the AHEAD FS is pinned by
  // the bound and may read holding while the behind catches up (symptom-1 behaviour).
  // The one invariant here: only the ahead FS (never the bursting behind FS) may hold.
  let sawBehindHold = false, sawAheadHold = false;
  await run(rig, 10, () => {
    const s = snapById(rig);
    if (s[behind].holding) sawBehindHold = true;
    if (s[ahead].holding) sawAheadHold = true;
  });
  const curAfter = rig.byId[behind].acked.cursor;
  if (!(curAfter > curBefore)) fail(`behind FS ${behind} did not advance after Pace→Race (cursor ${curBefore}→${curAfter}) : baseline reseat wrong`);
  else ok(`behind FS ${behind} burst forward on reseat (cursor ${curBefore}→${curAfter}) : burned its headroom toward the leader (never slow the leader)`);
  if (sawBehindHold) fail(`behind FS ${behind} read holding while it was the one bursting to catch up (should never : it is running)`);
  else ok(`behind FS ${behind} never read holding while catching up (only the pinned ahead FS may hold)`);
  ok(`ahead FS ${ahead} ${sawAheadHold ? 'read holding while pinned by the bound during catch-up' : 'was not caught pinned in the sample'} (bounded-MAX, symptom 1)`);
  // once the behind FS closes the gap below the bound, neither holds
  await run(rig, 40);
  const sEnd = snapById(rig);
  if (sEnd[behind].holding) fail(`behind FS still holding after catch-up window`);
  else ok('behind FS not holding after the catch-up window');
}

// ---------------------------------------------------------------------------
// The OTHER catch-up direction the spec calls out: RACE→PACE. Race diverges cursors
// (cheap FS leads); on the switch to Pace the LEAD FS is parked at the join until the
// laggard climbs to its cursor, a sustained hold that clears on convergence.
async function testRaceToPaceCatchupHold() {
  console.log('\n[6b] RACE→PACE catch-up: the lead FS holds until the laggard converges');
  // moderate finite speed so chunk sits between the two op costs -> cheap out-steps
  // pricey by ~2/frame; stop the divergence early so the gap is small enough to fully
  // converge under Pace's one-step-per-frame join within the frame budget.
  const rig = makeRig({ speed: 180000, units: { fastffs: 1e6, littlefs: 5e6 } });
  await flushTurns(4);
  rig.coord.setMode('race');
  rig.coord.start();
  for (let i = 0; i < 30; i++) { await frame(rig); const s = snapById(rig); if (Math.abs(s.fastffs.stepCursor - s.littlefs.stepCursor) >= 8) break; }
  const s0 = snapById(rig);
  const lead = s0.fastffs.stepCursor >= s0.littlefs.stepCursor ? 'fastffs' : 'littlefs';
  const lag = lead === 'fastffs' ? 'littlefs' : 'fastffs';
  if (s0[lead].stepCursor <= s0[lag].stepCursor) { fail('precondition: Race did not create a cursor lead'); return; }
  ok(`Race left a cursor lead: ${lead} at ${s0[lead].stepCursor}, ${lag} at ${s0[lag].stepCursor}`);
  rig.coord.stop();                     // stop generating new churn so the frontier is fixed and the laggard can converge
  rig.coord.setMode('pace');
  let sawLeadHold = false, holdRun = 0, maxHoldRun = 0;
  await run(rig, 400, () => {
    const s = snapById(rig);
    if (s[lead].holding && !s[lag].holding) { sawLeadHold = true; holdRun += 1; maxHoldRun = Math.max(maxHoldRun, holdRun); }
    else holdRun = 0;
  });
  if (!sawLeadHold) fail(`lead FS ${lead} never read holding after Race→Pace while the laggard caught up`);
  else ok(`lead FS ${lead} read holding (sustained ${maxHoldRun} frames) while ${lag} caught up (mode-switch catch-up hold)`);
  const s1 = snapById(rig);
  if (s1.fastffs.stepCursor !== s1.littlefs.stepCursor) fail(`cursors did not converge (${s1.fastffs.stepCursor} vs ${s1.littlefs.stepCursor})`);
  else if (s1[lead].holding) fail('lead FS still holding after cursors converged (hold did not clear)');
  else ok('hold cleared once cursors converged (join satisfied)');
}

// ---------------------------------------------------------------------------
// (b) csActive: RAW per-frame, true on a frame the session's playback advanced,
// false while frozen / idle. No debounce.
async function testCsActive() {
  console.log('\n[9] csActive: raw per-frame blinky, true while playback advances, false while frozen/idle');
  const rig = makeRig({ speed: 1e7 });
  await flushTurns(4);
  // idle (not running, no work): csActive false for both
  await run(rig, 3);
  let s = snapById(rig);
  if (s.fastffs.csActive || s.littlefs.csActive) fail(`csActive true while idle with no work (${s.fastffs.csActive}, ${s.littlefs.csActive})`);
  else ok('csActive false while idle (no playback advance)');
  // running Race: both advance playback most frames -> csActive true frequently
  rig.coord.setMode('race');
  rig.coord.start();
  let fastActiveFrames = 0, slowActiveFrames = 0, N = 20;
  await run(rig, N, () => { const x = snapById(rig); if (x.fastffs.csActive) fastActiveFrames++; if (x.littlefs.csActive) slowActiveFrames++; });
  if (fastActiveFrames < N * 0.5 || slowActiveFrames < N * 0.5) fail(`csActive rarely true while running (fast ${fastActiveFrames}/${N}, slow ${slowActiveFrames}/${N})`);
  else ok(`csActive true on most running frames (fast ${fastActiveFrames}/${N}, slow ${slowActiveFrames}/${N}), the real-time blinky`);
  // stop generation + reset to a clean idle chip (no queued frontier) -> csActive false
  rig.coord.stop();
  rig.coord.reset();
  await flushTurns(4);
  await run(rig, 4);
  s = snapById(rig);
  if (s.fastffs.csActive || s.littlefs.csActive) fail(`csActive still true after reset to idle (${s.fastffs.csActive}, ${s.littlefs.csActive})`);
  else ok('csActive false again once reset to an idle chip (playback frozen)');
}

// ---------------------------------------------------------------------------
async function testHoldDebounce() {
  console.log('\n[10] holding is DEBOUNCED (~300ms): raw hold does not light the card immediately');
  const savedSeam = globalThis.__flashvisHoldShowMs;
  globalThis.__flashvisHoldShowMs = 300;                 // real ~300ms debounce for this test only
  try {
    // SLOW-MO race with an EXECUTION-bound laggard (per-grant op cap of 1, tiny op cost
    // so cap × op << chunk): the laggard genuinely cannot burn its headroom, so the
    // bounded-MAX pins the leader CONTINUOUSLY. That is a real sustained raw hold (not a
    // max-speed backlog artifact), which is what the ~300ms wall debounce must gate.
    const rig = makeRig({ speed: 5e4, units: { fastffs: 1e4, littlefs: 1e4 }, caps: { fastffs: Infinity, littlefs: 1 } });
    const lead = 'fastffs';                              // uncapped ⇒ the pinned leader
    await flushTurns(4);
    rig.coord.setMode('race');
    rig.coord.start();
    await run(rig, 12);                                   // let the laggard fall behind and the leader pin (near-instant wall)
    if (snapById(rig)[lead].holding) fail('holding lit on the very first sampled frame of a fresh hold, not debounced');
    else ok('holding NOT lit immediately when the raw hold begins (debounce engaged)');
    // let ~360ms of real wall-time pass while the leader stays pinned, ticking as we go
    const t0 = Date.now();
    while (Date.now() - t0 < 360) await frame(rig);
    if (!snapById(rig)[lead].holding) fail('holding never lit after the raw hold persisted > 300ms (debounce stuck)');
    else ok('holding lit after the raw hold persisted past ~300ms (debounce released)');
  } finally {
    globalThis.__flashvisHoldShowMs = savedSeam;
  }
}

// ---------------------------------------------------------------------------
async function testGrantContinuityNoAccumulation() {
  console.log('\n[7] I10 grant-every-frame + I4 derived-not-accumulated: idle grants never burst');
  const rig = makeRig({ speed: 20000 });   // finite: a real chunk per frame
  await flushTurns(4);
  rig.coord.setMode('race');
  // NOT running, no work: keep granting for many frames. playbackNs must stay put
  // (no consumption ⇒ rel pinned at chunk ⇒ the ADR-0020 idle burst cannot re-enter).
  await run(rig, 30);
  const idlePb = FS_ORDER.map((f) => pb(rig, f));
  if (idlePb.some((v) => v > 0)) fail(`playback advanced while idle with no work (${idlePb}), a grant leaked execution (I10 no-op violated)`);
  else ok('30 idle grants advanced no playback (no-op grants, I10)');
  // now queue ONE small command; it must start at Speed (one chunk), not burst the
  // whole banked idle time (the leak counter-model).
  const { index } = rig.coord.broadcast({ ops: [1] }, 'one');
  rig.coord.start();
  await frame(rig);
  const afterOne = pb(rig, 'fastffs');
  // one op costs unit (1e6); a burst of "banked" idle grants would be many chunks.
  if (afterOne > 2e6) fail(`first post-idle grant burst (playback ${(afterOne / 1e6).toFixed(1)}ms > one op), grant was accumulated, not derived (I4)`);
  else ok(`post-idle command started metered at Speed (playback ${(afterOne / 1e6).toFixed(2)}ms ≈ one op), rel derived, not banked (I4)`);
  await run(rig, 20);
  if (!FS_ORDER.every((f) => rig.byId[f].acked.entriesDrained >= index)) fail('post-idle command never drained');
  else ok('post-idle command drained on both');
}

// ---------------------------------------------------------------------------
async function testResetEpochDiscard() {
  console.log('\n[8] reset() bumps the epoch; pre-reset stragglers are discarded (I5)');
  const rig = makeRig({ speed: 1e7 });
  await flushTurns(4);
  rig.coord.setMode('race');
  rig.coord.start();
  await run(rig, 20);
  const e0 = rig.coord.epoch;
  rig.coord.reset();
  const e1 = rig.coord.epoch;
  if (e1 <= e0) fail('reset did not bump the epoch');
  else ok(`reset bumped epoch ${e0}→${e1}`);
  await flushTurns(4);
  if (rig.workers.fastffs.epoch !== e1 || rig.workers.littlefs.epoch !== e1) fail(`workers did not adopt the reset epoch (got ${rig.workers.fastffs.epoch}, ${rig.workers.littlefs.epoch})`);
  else ok('both workers rebuilt on the new epoch');
  // cursors zeroed on the fresh epoch
  const s = snapById(rig);
  if (s.fastffs.stepCursor !== 0 || s.littlefs.stepCursor !== 0) fail(`cursors not zeroed after reset (${s.fastffs.stepCursor}, ${s.littlefs.stepCursor})`);
  else ok('cursors zeroed on the fresh epoch (no stale carryover)');
  // and it runs cleanly again
  rig.coord.start();
  await run(rig, 20);
  if (snapById(rig).fastffs.stepCursor < 5) fail('coordinator did not resume after reset');
  else ok('coordinator ran cleanly on the fresh epoch');
}

// ---------------------------------------------------------------------------
// Boot / header-Reset flow (spec/ui.md): reset() bumps epoch → worker rebuilds a fresh
// (blanked) chip; the ONE real format ships as a broadcast command AFTER reset (no
// format wire field); a header Reset NEVER switches race/pace mode.
async function testBootResetFlow() {
  console.log('\n[11] boot/header-Reset flow: reset→blank, format-as-broadcast, mode preserved');
  const rig = makeRig({ speed: 1e7 });
  await flushTurns(4);
  rig.coord.setMode('race');                     // set a non-default mode
  const modeBefore = rig.coord.mode;
  rig.coord.reset();                             // header Reset
  if (rig.coord.mode !== modeBefore) fail(`reset() switched mode ${modeBefore}→${rig.coord.mode}, spec says it must not`);
  else ok(`reset() preserved mode '${modeBefore}' (header Reset never switches race/pace)`);
  // the boot sequence: broadcast the ONE format command right after reset
  const { index } = rig.coord.broadcast({ ops: [1, 1] }, 'format()');
  if (index !== 0) fail(`format command not at the frontier index 0 after reset (got ${index})`);
  else ok('format command queued at index 0 on the fresh sequence');
  rig.coord.start();
  await run(rig, 20);
  if (!FS_ORDER.every((f) => rig.byId[f].acked.entriesDrained >= 0)) fail('post-reset format command did not execute on every worker');
  else ok('post-reset format command executed on every worker (boot flow works without a format wire field)');
}

// ---------------------------------------------------------------------------
// RACE SCALE (regression for the two reported symptoms). The COORDINATOR grants a
// per-frame race ceiling that grows by chunk = scale × MS_PER_FRAME, so a higher
// scale MUST yield a proportionally larger per-frame race advance, provided the
// worker can BURN the granted headroom (no drain cap). These pin the coordinator side
// of both symptoms so a future worker-side fix can be verified against a correct clock.
// Uncapped mock worker = "worker not drain-capped" (the §2 laggard can burn its headroom).
async function measurePerFrameAdvance(scale, { unit = 1e4 } = {}) {
  const rig = makeRig({ speed: scale, units: { fastffs: unit, littlefs: unit }, maxOpsPerGrant: Infinity });
  await flushTurns(4);
  rig.coord.setMode('race');
  rig.coord.start();
  await run(rig, 20);                                   // skip the ramp
  const a = pb(rig, 'fastffs');
  await run(rig, 20);
  const b = pb(rig, 'fastffs');
  return (b - a) / 20;                                  // sim-ns of playback advanced per frame
}
async function testRaceScaleProportional() {
  console.log('\n[12] RACE scale (slow-mo): per-frame playback advance scales with speed where playback is the limit');
  // SLOW-MO, tiny op cost (unit 1e4 = 0.01ms << chunk): the worker always keeps up, so
  // PLAYBACK (the §2 chunk = scale × MS_PER_FRAME), not entries, is the binding limit.
  // S = 5e4 (~1/20 real-time) and 2S = 1e5, both sub-op: doubling scale doubles Δ/frame.
  const S = 5e4;
  const adv1 = await measurePerFrameAdvance(S);
  const adv2 = await measurePerFrameAdvance(2 * S);
  const ratio = adv2 / adv1;
  // chunk = scale × MS_PER_FRAME ⇒ doubling scale doubles the per-frame advance.
  if (!(ratio > 1.8 && ratio < 2.2)) fail(`per-frame race advance did not track scale: adv(S)=${(adv1 / 1e6).toFixed(2)}ms, adv(2S)=${(adv2 / 1e6).toFixed(2)}ms, ratio ${ratio.toFixed(2)} (want ~2). The coordinator clock is not scale-driven.`);
  else ok(`per-frame race advance ~doubled with scale (adv(S)=${(adv1 / 1e6).toFixed(2)}ms, adv(2S)=${(adv2 / 1e6).toFixed(2)}ms, ratio ${ratio.toFixed(2)}) : grant.scale/chunk drives the race rate`);
  // expected magnitude: chunk = scale × MS_PER_FRAME
  const expected = S * (1000 / 60);
  const relErr = Math.abs(adv1 - expected) / expected;
  if (relErr > 0.15) fail(`per-frame advance ${(adv1 / 1e6).toFixed(2)}ms is not ≈ chunk=scale×MS_PER_FRAME=${(expected / 1e6).toFixed(2)}ms (rel err ${(relErr * 100).toFixed(0)}%)`);
  else ok(`per-frame advance ≈ chunk = scale × MS_PER_FRAME (${(adv1 / 1e6).toFixed(2)}ms ≈ ${(expected / 1e6).toFixed(2)}ms)`);
}
async function testBoundedRaceClock() {
  console.log('\n[13] RACE bounded-MAX (slow-mo): an exec-bound laggard pins the leader to slowest + 2Δ (symptom 1)');
  // BETWEEN-OPS slow-mo (scale 2e5 = ~1/5 real-time, Δ 3.33ms/frame): playback paces, and
  // an EXECUTION-bound laggard (per-grant op cap) genuinely cannot burn its headroom, so
  // the bounded-MAX must PIN the leader at slowest + 2Δ and light its hold (not runaway).
  const scale = 2e5;
  const chunk = scale * (1000 / 60);   // Δ per frame
  const BOUND = 2 * chunk;   // RACE_LEAD_BOUND_FRAMES = 2 (the slowest + 2Δ ceiling)
  // (a) BOTH keep up (uncapped, equal unit): flash time stays level, no false hold.
  {
    const rig = makeRig({ speed: scale, units: { fastffs: 1e4, littlefs: 1e4 }, maxOpsPerGrant: Infinity });
    await flushTurns(4);
    rig.coord.setMode('race'); rig.coord.start();
    let sawHold = false;
    await run(rig, 40, () => { const s = snapById(rig); if (s.fastffs.holding || s.littlefs.holding) sawHold = true; });
    const a = pb(rig, 'fastffs'), b = pb(rig, 'littlefs');
    const rel = Math.abs(a - b) / Math.max(a, b);
    if (rel > 0.1) fail(`both-keep-up race flash time NOT level (${(rel * 100).toFixed(0)}% apart)`);
    else ok(`both keep up: flash time level within ${(rel * 100).toFixed(1)}% (MAX clock, under the bound)`);
    if (sawHold) fail('a false hold fired while both FS kept up (small-jitter race must stay hold-free)');
    else ok('no false hold while both kept up (bound not engaged under small jitter)');
  }
  // (b) ONE FS is EXECUTION-bound (a tight per-grant op cap): it genuinely cannot burn
  // the granted headroom, so it falls behind. The leader must PIN at slowest + 2×chunk
  // (bounded divergence, NOT runaway) and read holding while pinned; the laggard, being
  // the one still executing, must never read holding.
  {
    const rig = makeRig({ speed: scale, units: { fastffs: 1e4, littlefs: 1e4 }, caps: { fastffs: Infinity, littlefs: 1 } });
    await flushTurns(4);
    rig.coord.setMode('race'); rig.coord.start();
    let maxLead = 0, sawLeaderHold = false, sawLaggardHold = false;
    await run(rig, 80, () => {
      const lead = pb(rig, 'fastffs') - pb(rig, 'littlefs');
      maxLead = Math.max(maxLead, lead);
      const s = snapById(rig);
      if (s.fastffs.holding) sawLeaderHold = true;
      if (s.littlefs.holding) sawLaggardHold = true;
    });
    const lead = pb(rig, 'fastffs') - pb(rig, 'littlefs');
    // The leader may overshoot the ceiling by at most one op (unit) beyond the bound.
    const tol = BOUND + 2e4;
    if (lead > tol) fail(`leader ran away: lead ${(lead / 1e6).toFixed(1)}ms > bound 2×chunk=${(BOUND / 1e6).toFixed(1)}ms, the race clock is NOT bounded`);
    else ok(`leader pinned at slowest + 2×chunk: lead ${(lead / 1e6).toFixed(2)}ms ≤ bound ${(BOUND / 1e6).toFixed(2)}ms (bounded MAX, no runaway); peak lead ${(maxLead / 1e6).toFixed(2)}ms`);
    if (!(maxLead > BOUND * 0.4)) fail(`the laggard was not actually held back (peak lead ${(maxLead / 1e6).toFixed(2)}ms), test not exercising the bound`);
    else ok(`the exec-bound laggard did fall behind toward the bound (peak lead ${(maxLead / 1e6).toFixed(2)}ms)`);
    if (!sawLeaderHold) fail('leader never read holding while pinned at the bound (the bounded-race hold must show)');
    else ok('leader read holding while pinned at the bound (a real race hold, only for the too-far-behind case)');
    if (sawLaggardHold) fail('the exec-bound laggard wrongly read holding (it is the one still executing)');
    else ok('the exec-bound laggard never read holding (only the pinned leader holds)');
  }
}

// ---------------------------------------------------------------------------
// setSpeed input guard: reject non-finite or negative speed (Infinity/-Infinity/
// NaN/<0) instead of silently clamping; valid finite speed still works. 0 is
// allowed (reserved as a future freeze option) and is NOT asserted here.
function testSetSpeedGuard() {
  console.log('\n[14] setSpeed guard: rejects non-finite / negative, accepts valid finite');
  const { coord } = makeRig();
  const throws = (v, label) => {
    let threw = false;
    try { coord.setSpeed(v); } catch { threw = true; }
    if (threw) ok(`setSpeed(${label}) threw (rejected, not silently clamped)`);
    else fail(`setSpeed(${label}) did NOT throw (must reject non-finite/negative)`);
  };
  throws(Infinity, 'Infinity');
  throws(-1, '-1');
  throws(NaN, 'NaN');
  let ranClean = true;
  try { coord.setSpeed(1e6); } catch { ranClean = false; }
  if (ranClean) ok('setSpeed(1e6) accepted a valid finite speed (no throw)');
  else fail('setSpeed(1e6) threw on a valid finite speed (guard too aggressive)');
}

// ---- run all ----
console.log('ADR-0024 coordinator-over-the-wire suite (mock transport + mock workers)');
await testHandshake();
await testRaceDivergence();
await testRaceCommand();
await testPaceLockstep();
await testSustainedPaceHold();
await testReseatBurstNoStall();
await testRaceToPaceCatchupHold();
await testGrantContinuityNoAccumulation();
await testResetEpochDiscard();
await testCsActive();
await testHoldDebounce();
await testBootResetFlow();
await testRaceScaleProportional();
await testBoundedRaceClock();
testSetSpeedGuard();

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - Race + Pace drive the mock-worker pair over the wire with correct');
console.log('       grant/ack/round semantics; holding (sustained, debounced) + csActive');
console.log('       (raw per-frame) derived from acks; boot/reset flow intact.');
process.exit(0);
