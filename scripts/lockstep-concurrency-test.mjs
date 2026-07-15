/*
 * Busy-lock / no-double-execution concurrency regression suite — ADR-0024
 * (worker-per-session) CONVERSION.
 *
 * See LANE-REPORT.md (this worktree) for the full OLD->NEW observable mapping,
 * the seam this suite binds through, and which of the old suite's 16
 * scenarios are converted here vs. deferred (with rationale) pending
 * lane/coord + lane/worker landing. Short version:
 *
 * WHY THE OLD MECHANISM DOESN'T SURVIVE THE THREAD BOUNDARY
 * -----------------------------------------------------------
 * The old suite imported createSession/createLockstep DIRECTLY and counted
 * re-dispatches via a CLOSURE mutated inside the command fn, gated by a
 * test-held promise the command's closure referenced directly. Under
 * ADR-0024, commands ship as SOURCE TEXT and compile *inside the worker*;
 * scripts/mock-worker-transport.mjs structuredClone's every message, so a
 * closure counter would be silently severed — structurally wrong, not just
 * inconvenient. This suite instead:
 *   - counts dispatches from the worker's own JOURNAL (W2C.FRAME.journal, via
 *     C2W.PULL) — a command that runs twice appends its op lines twice. This
 *     is already an ADR-0018 in-band log, not a new field grafted onto the
 *     wire; protocol.js stays untouched.
 *   - corroborates via `drainedCounters` (fileOpCount/flashTimeNs) — a
 *     double-executed write always reprograms, so a real double-dispatch
 *     inflates both. (Cross-FS byte identity, the old suite's OTHER
 *     corroboration, is NOT available: protocol.js has no message that
 *     returns raw file bytes — see LANE-REPORT.md's protocol-ambiguity
 *     section. Flagged for the lead, not guessed at here.)
 *   - forces the busy window with a GATED command exactly as before, but the
 *     gate itself is TEST RIGGING (a `globalThis.__fvTestGate` the harness
 *     sets before compiling the command source), not a shared closure the
 *     command depends on for its logic — see scripts/ref-worker-host.mjs's
 *     banner for the exact boundary this crosses vs. doesn't.
 *
 * WHAT MOVED: coordinator-shared "busy" -> worker-LOCAL re-entrancy
 * -------------------------------------------------------------------
 * The old bug class was two DIFFERENT JS call paths (paceStep/raceTick/step())
 * racing on shared coordinator state to dispatch the same sequence[i] twice.
 * ADR-0024 makes that architecturally impossible AT THE COORDINATOR (I9: "no
 * per-op wire" — a worker executes its own entries serially, alone). The
 * equivalent hazard moves worker-side: two GRANT messages (e.g. an overlapping
 * round while a command is still mid-flight) must not spawn two concurrent
 * dispatch loops touching the same cursor. Scenario 1 below targets exactly
 * that guard in scripts/ref-worker-host.mjs (mutation-proven — see
 * LANE-REPORT.md).
 */
import { makeRig, drainTo, flushTurns } from './worker-harness.mjs';

process.on('unhandledRejection', (e) => { console.error('\nFAIL - unhandled rejection:', (e && e.stack) || e); process.exit(1); });

let failures = 0;
function fail(msg) { failures++; console.error('  FAIL - ' + msg); }
function ok(msg) { console.log('  ok   - ' + msg); }

// ---- gated command primitive (see file banner + ref-worker-host.mjs) ----
const GATE_A = 'gate-a.bin', GATE_B = 'gate-b.bin', GATE_SIZE = 4096;
const GATED_SOURCE = `async (api) => {
  await api.writeFile('${GATE_A}', ${GATE_SIZE});
  await globalThis.__fvTestGate.promise;
  await api.writeFile('${GATE_B}', ${GATE_SIZE});
}`;
function makeGate() {
  let release;
  const promise = new Promise((r) => { release = r; });
  globalThis.__fvTestGate = { promise };
  return { release: () => release() };
}
function gatedEntry(index, seed = 1) { return { index, kind: 'command', payload: GATED_SOURCE, seed }; }

const countLines = (journal, substr) => journal.filter((j) => j.text.includes(substr)).length;

async function pullJournal(rig, fsId, limit = 200) {
  const frame = await rig.pull(fsId, { journal: { since: 0, limit } });
  return frame ? frame.journal : [];
}

// Poll a session's pulled journal until `pred(journal)` holds, or throw at the bound.
async function pumpUntilJournal(rig, fsId, pred, label, maxIter = 200) {
  for (let i = 0; i < maxIter; i++) {
    const j = await pullJournal(rig, fsId);
    if (pred(j)) return j;
    await flushTurns(1);
  }
  throw new Error(`pumpUntilJournal(${label}) exceeded ${maxIter} iterations`);
}

// ---- [0] exactly-once reference: a single gated command, released immediately ----
// OLD: buildGatedReference() — dispatched===sessions.length, captured device cost.
// NEW: same intent, dispatch counted from the worker's own journal (in-band).
async function buildReference() {
  console.log('\n[0] exactly-once reference for a single gated command');
  const rig = await makeRig();
  rig.broadcastEntries([gatedEntry(0)]);
  const gate = makeGate();
  gate.release();                                    // no parking: a clean single run
  await drainTo(rig, 1);
  const ref = {};
  for (const s of rig.sessions) {
    const j = await pullJournal(rig, s.fsId);
    const dispatches = countLines(j, `write(${GATE_A}`);
    if (dispatches !== 1) fail(`reference: ${s.fsId} dispatched ${dispatches}x, expected 1`);
    ref[s.fsId] = { drainedCounters: s.standing.drainedCounters };
  }
  ok(`reference captured (fastffs cost=${JSON.stringify(ref.fastffs.drainedCounters)}, littlefs cost=${JSON.stringify(ref.littlefs.drainedCounters)})`);
  return ref;
}

// ---- [1] exactly-once dispatch under an OVERLAPPING grant round (the new
// analog of old scenarios 1-3: a second GRANT lands while the worker's dispatch
// loop is already mid-command). Targets ref-worker-host.mjs's per-epoch
// re-entrancy guard (runningEpoch) — the worker-LOCAL equivalent of the old
// coordinator busy-map. Mutation-proven: FV_REF_HOST_NO_GUARD=1 makes this FAIL
// (see LANE-REPORT.md "Mutation evidence"). ----
async function scenarioOverlappingGrant(reference) {
  console.log('\n[1] exactly-once dispatch under an overlapping GRANT round (worker-local re-entrancy)');
  const rig = await makeRig();
  rig.broadcastEntries([gatedEntry(0)]);
  const gate = makeGate();
  // round 0: entryLimit=1 — every session starts the gated command and parks
  // at the gate (writes GATE_A, then awaits). Fire without waiting for the
  // barrier (the ack won't land until the gate opens).
  for (const s of rig.sessions) s.send('grant', { epoch: rig.getEpoch(), round: 0, entryLimit: 1, playLimitNs: 1e15, scale: 1 });
  for (const fsId of ['fastffs', 'littlefs']) {
    await pumpUntilJournal(rig, fsId, (j) => countLines(j, `write(${GATE_A}`) >= 1, `s1-window-${fsId}`);
  }
  ok('window reached: both sessions parked mid-command (wrote GATE_A, awaiting the gate)');
  // round 1: OVERLAPPING grant while still parked — a broken re-entrancy guard
  // would spawn a second dispatch loop and re-run entries[0] from scratch.
  for (const s of rig.sessions) s.send('grant', { epoch: rig.getEpoch(), round: 1, entryLimit: 1, playLimitNs: 1e15, scale: 1 });
  await flushTurns(10);
  for (const fsId of ['fastffs', 'littlefs']) {
    const j = await pullJournal(rig, fsId);
    const n = countLines(j, `write(${GATE_A}`);
    if (n !== 1) fail(`s1: ${fsId} dispatched ${n}x after the overlapping grant (expected 1 — a re-dispatch = double execution)`);
    else ok(`s1: ${fsId} still dispatched exactly 1x after the overlapping grant`);
  }
  gate.release();
  await drainTo(rig, 1);
  for (const s of rig.sessions) {
    const j = await pullJournal(rig, s.fsId);
    const nA = countLines(j, `write(${GATE_A}`), nB = countLines(j, `write(${GATE_B}`);
    if (nA !== 1 || nB !== 1) fail(`s1: ${s.fsId} final dispatch count A=${nA} B=${nB}, expected 1/1`);
    else ok(`s1: ${s.fsId} settled at exactly 1 dispatch (A and B each written once)`);
    const dc = s.standing.drainedCounters, rc = reference[s.fsId].drainedCounters;
    if (dc.fileOpCount !== rc.fileOpCount || dc.flashTimeNs !== rc.flashTimeNs) {
      fail(`s1: ${s.fsId} drainedCounters diverged from the clean reference (fileOpCount ${dc.fileOpCount} vs ${rc.fileOpCount}, flashTimeNs ${dc.flashTimeNs} vs ${rc.flashTimeNs})`);
    } else ok(`s1: ${s.fsId} drainedCounters match the clean single-dispatch reference`);
  }
}

// ---- [2] grant continuity / no-op re-grant is idempotent (I10) ----
// OLD: not directly covered (implicit in the old suite's cost-equality checks).
// NEW coverage required by ADR-0024 §13: "activity in a no-op ack = a bug".
async function scenarioNoOpGrantIdempotent() {
  console.log('\n[2] a re-sent grant with unchanged limits is a true no-op (I10)');
  const rig = await makeRig();
  rig.broadcastEntries([{ index: 0, kind: 'command', payload: `async (api) => { await api.writeFile('once.bin', 2048); }`, seed: 7 }]);
  await drainTo(rig, 1);
  const before = {};
  for (const s of rig.sessions) before[s.fsId] = { j: (await pullJournal(rig, s.fsId)).length, dc: { ...s.standing.drainedCounters } };
  // re-send the SAME (already-satisfied) limits at a fresh round number —
  // protocol.js: "ALWAYS sent per frame; a no-op grant... when idle".
  const r = 999;
  for (const s of rig.sessions) s.send('grant', { epoch: rig.getEpoch(), round: r, entryLimit: 1, playLimitNs: 1e15, scale: 1 });
  await flushTurns(5);
  for (const s of rig.sessions) {
    if (s.standing.round < r) fail(`s2: ${s.fsId} never acked the no-op re-grant (round stuck at ${s.standing.round})`);
    else ok(`s2: ${s.fsId} acked the no-op re-grant (round ${s.standing.round})`);
    const j = await pullJournal(rig, s.fsId);
    const dc = s.standing.drainedCounters;
    if (j.length !== before[s.fsId].j || dc.fileOpCount !== before[s.fsId].dc.fileOpCount || dc.flashTimeNs !== before[s.fsId].dc.flashTimeNs) {
      fail(`s2: ${s.fsId} showed activity on a no-op grant (journal ${before[s.fsId].j}->${j.length}, cost changed)`);
    } else ok(`s2: ${s.fsId} showed no activity on the no-op re-grant (journal/cost unchanged)`);
  }
  // a re-sent/duplicated ENTRIES window for the SAME index (e.g. a retried
  // prefetch after a dropped ack) must not double-append -> double-execute.
  for (const s of rig.sessions) s.send('entries', { epoch: rig.getEpoch(), entries: [{ index: 0, kind: 'command', payload: `async (api) => { await api.writeFile('once.bin', 2048); }`, seed: 7 }] });
  for (const s of rig.sessions) s.send('grant', { epoch: rig.getEpoch(), round: 1000, entryLimit: 5, playLimitNs: 1e15, scale: 1 });
  await flushTurns(10);
  for (const s of rig.sessions) {
    const j = await pullJournal(rig, s.fsId);
    const n = countLines(j, 'write(once.bin');
    if (n !== 1) fail(`s2: ${s.fsId} entries[0] executed ${n}x after a duplicated ENTRIES resend (expected 1 — dedup by index required)`);
    else ok(`s2: ${s.fsId} a duplicated ENTRIES resend for index 0 did not re-execute it`);
    if (s.standing.cursor !== 1) fail(`s2: ${s.fsId} cursor moved to ${s.standing.cursor} off a duplicate-only resend (expected to stay at 1, nothing new queued)`);
  }
}

// ---- [3] epoch discard (I5) + reset starves an in-flight round (§8) ----
// OLD scenario 16(b): "bare reset() abandons a parked command -- no zombie ops
// on the fresh chip". NEW: same intent, in-band via drainedCounters/journal
// pulled post-reset, and epoch is the wire-level discriminant instead of an
// in-process token/abort.
async function scenarioEpochDiscard() {
  console.log('\n[3] reset() bumps epoch; a mid-flight round starves, never lands in the new epoch (I5 + §8)');
  const rig = await makeRig();
  rig.broadcastEntries([gatedEntry(0)]);
  const gate = makeGate();
  for (const s of rig.sessions) s.send('grant', { epoch: rig.getEpoch(), round: 0, entryLimit: 1, playLimitNs: 1e15, scale: 1 });
  for (const fsId of ['fastffs', 'littlefs']) {
    await pumpUntilJournal(rig, fsId, (j) => countLines(j, `write(${GATE_A}`) >= 1, `s3-window-${fsId}`);
  }
  ok('both sessions parked mid-command (round 0, pre-reset epoch)');
  await rig.reset();                                 // epoch bumps; cursor/entries/playbackNs rebuilt fresh
  const postResetCost = Object.fromEntries(rig.sessions.map((s) => [s.fsId, s.standing.drainedCounters || { fileOpCount: 0, flashTimeNs: 0 }]));
  gate.release();                                     // wake the stale round; it must STARVE, not land
  await flushTurns(20);
  for (const s of rig.sessions) {
    const dc = s.standing.drainedCounters || { fileOpCount: 0, flashTimeNs: 0 };
    if (dc.fileOpCount !== postResetCost[s.fsId].fileOpCount || dc.flashTimeNs !== postResetCost[s.fsId].flashTimeNs) {
      fail(`s3: ${s.fsId} the abandoned round wrote into the fresh epoch after reset (fileOpCount ${postResetCost[s.fsId].fileOpCount}->${dc.fileOpCount})`);
    } else ok(`s3: ${s.fsId} the abandoned round left no trace after reset (starved, per §8)`);
    if (s.standing.cursor !== 0) fail(`s3: ${s.fsId} cursor is ${s.standing.cursor} after reset, expected 0`);
    const j = await pullJournal(rig, s.fsId);
    if (j.some((line) => line.text.includes(GATE_B))) fail(`s3: ${s.fsId} the zombie command's second write (${GATE_B}) landed after reset`);
    else ok(`s3: ${s.fsId} the zombie's post-gate write never happened (no ${GATE_B} in the post-reset journal)`);
  }
  // the fresh epoch must still be fully live: broadcast + drain a real command.
  rig.broadcastEntries([{ index: 0, kind: 'command', payload: `async (api) => { await api.writeFile('post-reset.bin', 1024); }`, seed: 3 }]);
  await drainTo(rig, 1);
  for (const s of rig.sessions) {
    if (s.standing.cursor !== 1) fail(`s3: ${s.fsId} did not advance in the fresh epoch (coordinator wedged after abandoning the stale round?)`);
    else ok(`s3: ${s.fsId} stayed live in the fresh epoch (drained a fresh command to cursor 1)`);
  }
}

// ---- [4] grant/ack round barrier (I2): round+1 releases only once EVERY
// current session has acked round r, never early on a faster peer's ack. ----
// NEW coverage required by ADR-0024 §13.
async function scenarioRoundBarrier() {
  console.log('\n[4] grant/ack round barrier: the round only settles once every session has acked (I2)');
  const rig = await makeRig();
  rig.byId.fastffs.send('entries', { epoch: rig.getEpoch(), entries: [gatedEntry(0)] }); // only fastffs has work — parks here
  // littlefs gets no entries at all — nothing to run, so it acks round 0 immediately
  const gate = makeGate();
  let barrierSettled = false;
  const barrier = rig.grantRound({ entryLimit: 1, playLimitNs: 1e15 }).then(() => { barrierSettled = true; });
  await pumpUntilJournal(rig, 'fastffs', (j) => countLines(j, `write(${GATE_A}`) >= 1, 's4-window');
  await flushTurns(5);
  if (rig.byId.littlefs.standing.round < 0) fail('s4: littlefs (idle) never acked round 0');
  else ok('s4: littlefs (idle, nothing to run) acked round 0 promptly');
  if (barrierSettled) fail('s4: the round barrier settled BEFORE fastffs (still mid-command) acked — I2 violated');
  else ok('s4: the round barrier correctly held open while fastffs is still mid-command');
  gate.release();
  await barrier;
  if (!barrierSettled) fail('s4: the round barrier never settled after fastffs completed and acked');
  else ok('s4: the round barrier settled once every session (including the laggard) acked round 0');
}

// ---- [5] teardown drains stragglers (§8): a removed session's late ack must
// not corrupt survivor bookkeeping or wedge the barrier; no delivery survives
// terminate(). ----
// OLD scenario 8(c): setSessions removal mid-command is a guarded no-op.
async function scenarioTeardownStragglers() {
  console.log('\n[5] teardown drains a straggler: a removed session\'s late ack is a guarded no-op (§8)');
  const rig = await makeRig();
  rig.broadcastEntries([gatedEntry(0)]);
  const gate = makeGate();
  for (const s of rig.sessions) s.send('grant', { epoch: rig.getEpoch(), round: 0, entryLimit: 1, playLimitNs: 1e15, scale: 1 });
  for (const fsId of ['fastffs', 'littlefs']) {
    await pumpUntilJournal(rig, fsId, (j) => countLines(j, `write(${GATE_A}`) >= 1, `s5-window-${fsId}`);
  }
  ok('both sessions parked mid-command');
  rig.dropSession('littlefs');                        // setSessions-style removal WHILE its command is in-flight
  if (rig.sessions.some((s) => s.fsId === 'littlefs')) fail('s5: littlefs still in the barrier-wait set after dropSession');
  else ok('s5: littlefs removed from the barrier-wait set');
  // the survivor must not be blocked by the now-untracked straggler.
  gate.release();
  await drainTo(rig, 1);                               // only waits on rig.sessions (fastffs now)
  if (rig.byId.fastffs.standing.cursor !== 1) fail(`s5: fastffs (survivor) did not complete (cursor ${rig.byId.fastffs.standing.cursor})`);
  else ok('s5: fastffs (survivor) completed without waiting on the removed straggler');
  // the straggler's late ack (it was released too — same gate) must not throw
  // or corrupt anything even though nothing awaits it anymore.
  await flushTurns(10);
  if (rig.byId.littlefs.standing.cursor !== 1) fail('s5: littlefs straggler never actually settled (harness bug, not a product one — check the gate)');
  else ok('s5: littlefs straggler settled quietly post-removal (late ack landed, nothing was waiting on it)');
  rig.terminateSession('littlefs');                    // worker.terminate() post-settle
  const before = rig.byId.littlefs.standing.cursor;
  rig.byId.littlefs.send('grant', { epoch: rig.getEpoch(), round: 50, entryLimit: 100, playLimitNs: 1e15, scale: 1 });
  await flushTurns(10);
  if (rig.byId.littlefs.standing.cursor !== before) fail('s5: a message was still delivered to a terminated session\'s port');
  else ok('s5: no message is delivered to a terminated session\'s port (mock Port honors close())');
}

// ---- run all ----
console.log('lockstep concurrency / no-double-execution suite — ADR-0024 worker-per-session conversion\n');
const reference = await buildReference();
await scenarioOverlappingGrant(reference);
await scenarioNoOpGrantIdempotent();
await scenarioEpochDiscard();
await scenarioRoundBarrier();
await scenarioTeardownStragglers();

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - exactly-once dispatch holds over the wire (worker-local re-entrancy, round barrier,');
console.log('       epoch discard, teardown-drains-stragglers); see LANE-REPORT.md for scenarios deferred');
console.log('       pending lane/coord + lane/worker (Pace/Race reseat, holding/stalled/waiting, opsPerSec,');
console.log('       reset byte-reproducibility, abort/reject recovery).');
process.exit(0);
