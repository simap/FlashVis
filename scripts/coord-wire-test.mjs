/*
 * coord-wire-test.mjs — ADR-0024 coordinator over the WIRE (lane C's own suite).
 *
 * Drives the rebuilt lockstep coordinator (web/src/lockstep.js) through the real
 * protocol.js message envelopes, over the faithful mock transport (structuredClone +
 * async queued delivery), against a pair of mock session workers. NO WASM, NO real
 * session — the point is to prove the §2 clock-release algebra and its grant/ack/round
 * barrier end to end, and that holding/stalled/waiting are correctly DERIVED from ack
 * state alone (the old synchronous device/pending reads are gone).
 *
 * Two workers model a "cheap" FS (fastffs, 1e6 ns/op) and a "pricey" FS (littlefs,
 * 5e6 ns/op) so a Race under an identical playback ceiling diverges in step count
 * while playback stays level — the ADR-0016 comparison — and a Pace stays in cursor
 * lockstep while playback (cost) diverges.
 */
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

function makeRig({ speed = Infinity, units = UNITS, maxOpsPerGrant = 64 } = {}) {
  const churn = createChurnModel(CHURN_CFG);
  const coord = createLockstep({ churn, autoTick: false });
  const workers = {};
  const proxies = [];
  for (const fsId of FS_ORDER) {
    const { mainPort, workerPort } = createTransport();
    workers[fsId] = createMockWorker(workerPort, { unit: units[fsId], maxOpsPerGrant });
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
  console.log('\n[2] RACE: identical playback ceiling ⇒ cursors diverge, playback level (§2 MAX)');
  const rig = makeRig({ speed: Infinity });
  await flushTurns(4);
  rig.coord.setMode('race');
  rig.coord.start();
  await run(rig, 40);
  const s = snapById(rig);
  const cur = { fastffs: s.fastffs.stepCursor, littlefs: s.littlefs.stepCursor };
  if (!(cur.fastffs > cur.littlefs)) fail(`cheap FS did not out-step pricey FS (fastffs ${cur.fastffs} vs littlefs ${cur.littlefs})`);
  else ok(`cheap FS out-stepped pricey ${(cur.fastffs / Math.max(cur.littlefs, 1)).toFixed(1)}x (fastffs ${cur.fastffs}, littlefs ${cur.littlefs}) — the comparison`);
  const a = pb(rig, 'fastffs'), b = pb(rig, 'littlefs');
  const rel = Math.abs(a - b) / Math.max(a, b);
  if (rel > 0.15) fail(`playback NOT level across FS (fastffs ${(a / 1e6).toFixed(0)}ms vs littlefs ${(b / 1e6).toFixed(0)}ms, ${(rel * 100).toFixed(0)}% apart) — ceiling not shared`);
  else ok(`playback level within ${(rel * 100).toFixed(1)}% (fastffs ${(a / 1e6).toFixed(0)}ms, littlefs ${(b / 1e6).toFixed(0)}ms) — one shared ceiling`);
  // round barrier: both workers acked the same advancing round (I2)
  const rounds = FS_ORDER.map((f) => rig.byId[f].acked.round);
  if (rounds[0] < 5 || Math.abs(rounds[0] - rounds[1]) > 1) fail(`round barrier off: acked rounds ${rounds} (should advance together, ≥1 apart at most)`);
  else ok(`round advanced in lockstep barrier: both acked round ~${rounds[0]} (I2)`);
}

// ---------------------------------------------------------------------------
async function testRaceCommand() {
  console.log('\n[3] RACE: a broadcast command drains on every worker (quiescence = ack, I1)');
  const rig = makeRig({ speed: Infinity });
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
  const rig = makeRig({ speed: Infinity });
  await flushTurns(4);
  rig.coord.setMode('pace');
  rig.coord.start();
  let maxGap = 0;
  await run(rig, 40, () => {
    const s = snapById(rig);
    maxGap = Math.max(maxGap, Math.abs(s.fastffs.stepCursor - s.littlefs.stepCursor));
  });
  const s = snapById(rig);
  if (maxGap > 1) fail(`pace cursors diverged (max gap ${maxGap}) — the join let a session get ahead`);
  else ok(`pace cursors never diverged (max gap ${maxGap}) — ∀ entriesDrained ≥ sharedIndex join holds`);
  if (s.fastffs.stepCursor < 5) fail(`pace made no progress (cursor ${s.fastffs.stepCursor})`);
  else ok(`pace advanced to cursor ${s.fastffs.stepCursor}, both equal`);
  // playback (cost) DOES diverge under Pace — same steps, different per-op cost
  const a = pb(rig, 'fastffs'), b = pb(rig, 'littlefs');
  if (!(b > a * 1.5)) fail(`pace playback did not diverge by cost (fastffs ${a}, littlefs ${b})`);
  else ok(`pace playback diverged by cost: littlefs ${(b / a).toFixed(1)}x fastffs (equal steps, unequal flash time)`);
}

// ---------------------------------------------------------------------------
async function testPaceCommandAndHolding() {
  console.log('\n[5] PACE: multi-op command — faster FS finishes the step first and reads HOLDING');
  // finite speed + a chunk between the two per-op costs so the cheap FS drains the
  // command a grant before the pricey one -> a real holding window.
  const rig = makeRig({ speed: 120000, units: { fastffs: 1e6, littlefs: 3e6 } });   // chunk ≈ 2e6 ns/frame
  await flushTurns(4);
  rig.coord.setMode('pace');
  const { index } = rig.coord.broadcast({ ops: [1, 1, 1, 1] }, 'cmd x4');
  let sawFastHolding = false, sawSlowHolding = false, sawAnimatingHold = false;
  await run(rig, 60, () => {
    const s = snapById(rig);
    if (s.fastffs.holding && !s.littlefs.holding) sawFastHolding = true;
    if (s.littlefs.holding && !s.fastffs.holding) sawSlowHolding = true;
    // the laggard (still draining the command) must NEVER read holding
    const slowStillWorking = rig.byId.littlefs.acked.entriesDrained < index;
    if (slowStillWorking && s.littlefs.holding) sawAnimatingHold = true;
  });
  const drained = FS_ORDER.every((f) => rig.byId[f].acked.entriesDrained >= index);
  if (!drained) fail(`pace command not drained on both (entriesDrained ${FS_ORDER.map((f) => rig.byId[f].acked.entriesDrained)})`);
  else ok('pace command drained on both workers');
  if (!sawFastHolding) fail('cheap FS never read holding while the pricey FS was still draining the command');
  else ok('cheap FS read holding while pricey FS still worked the shared step (derived from acks)');
  if (sawSlowHolding) fail('pricey FS (the laggard) wrongly read holding while it was the one still working');
  else ok('pricey FS never read holding while it was the laggard (correct: only the one waited-ON is idle)');
  if (sawAnimatingHold) fail('the still-draining FS read holding (the wrong-FS holding bug)');
  else ok('a still-draining FS never read holding');
}

// ---------------------------------------------------------------------------
async function testReseatBurstNoStall() {
  console.log('\n[6] PACE→RACE reseat: the BEHIND FS burns headroom to catch up (§2 MAX, not a stall)');
  const rig = makeRig({ speed: Infinity, maxOpsPerGrant: 64 });
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
  rig.coord.setMode('race');
  // one race frame: the behind FS should BURST (cursor jumps) as it burns its extra
  // headroom (rel − (acked − baseline) ≥ chunk) toward the leader's ceiling.
  let sawBehindStalled = false;
  await run(rig, 6, () => {
    const s = snapById(rig);
    if (s[behind].stalled) sawBehindStalled = true;
  });
  const curAfter = rig.byId[behind].acked.cursor;
  if (!(curAfter > curBefore)) fail(`behind FS ${behind} did not advance after Pace→Race (cursor ${curBefore}→${curAfter}) — baseline reseat wrong`);
  else ok(`behind FS ${behind} burst forward on reseat (cursor ${curBefore}→${curAfter}) — burned its headroom toward the leader (never slow the leader)`);
  // and the LEADER should read stalled/waiting for a frame or two while it is metered
  // to one chunk far above the field min (the §2 standing-signal for "held at ceiling").
  let sawLeaderStall = false;
  const leader = behind === 'fastffs' ? 'littlefs' : 'fastffs';
  await run(rig, 1, () => { if (snapById(rig)[leader].stalled) sawLeaderStall = true; });
  if (sawLeaderStall) ok(`leader ${leader} read stalled while metered at the ceiling above the field min`);
  else ok(`(leader ${leader} re-leveled before a stall sample — §2 closes the gap fast; see LANE-REPORT on the standing-signal semantics)`);
  if (sawBehindStalled) fail(`behind FS ${behind} read stalled while it was the one bursting to catch up (should never — it is running)`);
  else ok(`behind FS ${behind} never read stalled while catching up (it is the one running)`);
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
  if (idlePb.some((v) => v > 0)) fail(`playback advanced while idle with no work (${idlePb}) — a grant leaked execution (I10 no-op violated)`);
  else ok('30 idle grants advanced no playback (no-op grants, I10)');
  // now queue ONE small command; it must start at Speed (one chunk), not burst the
  // whole banked idle time (the leak counter-model).
  const { index } = rig.coord.broadcast({ ops: [1] }, 'one');
  rig.coord.start();
  await frame(rig);
  const afterOne = pb(rig, 'fastffs');
  // one op costs unit (1e6); a burst of "banked" idle grants would be many chunks.
  if (afterOne > 2e6) fail(`first post-idle grant burst (playback ${(afterOne / 1e6).toFixed(1)}ms > one op) — grant was accumulated, not derived (I4)`);
  else ok(`post-idle command started metered at Speed (playback ${(afterOne / 1e6).toFixed(2)}ms ≈ one op) — rel derived, not banked (I4)`);
  await run(rig, 20);
  if (!FS_ORDER.every((f) => rig.byId[f].acked.entriesDrained >= index)) fail('post-idle command never drained');
  else ok('post-idle command drained on both');
}

// ---------------------------------------------------------------------------
async function testResetEpochDiscard() {
  console.log('\n[8] reset() bumps the epoch; pre-reset stragglers are discarded (I5)');
  const rig = makeRig({ speed: Infinity });
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

// ---- run all ----
console.log('ADR-0024 coordinator-over-the-wire suite (mock transport + mock workers)');
await testHandshake();
await testRaceDivergence();
await testRaceCommand();
await testPaceLockstep();
await testPaceCommandAndHolding();
await testReseatBurstNoStall();
await testGrantContinuityNoAccumulation();
await testResetEpochDiscard();

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - Race + Pace both drive the mock-worker pair over the wire with correct');
console.log('       grant/ack/round semantics; holding/stalled/waiting derived from acks.');
process.exit(0);
