/*
 * worker-conformance-test.mjs — message-level executable spec for the ADR-0024
 * worker-per-session wire contract (web/src/protocol.js §2/§4/§5/§9).
 *
 * Drives a worker host over scripts/mock-worker-transport.mjs (a faithful
 * in-realm Worker-port model: structuredClone per message, async macrotask
 * delivery) with scripted INIT/ENTRIES/GRANT/PULL/RESET and asserts the
 * emitted GRANT_ACK/FRAME conform to the protocol. The suite plays the
 * COORDINATOR role by hand (it computes entryLimit/playLimitNs/round itself,
 * scenario by scenario) so each invariant can be forced into the exact
 * window that exercises it — this is normal for a message-level conformance
 * suite: the coordinator's own §2 algebra is asserted directly (I4) as well
 * as through a real worker's responses to it.
 *
 * SEAM: the worker host under test is swapped with one line, the same
 * pattern as FV_LOCKSTEP (lockstep-concurrency-test.mjs) / FV_SESSION
 * (command-error-test.mjs):
 *
 *   const { installWorkerHost } = await import(process.env.FV_WORKER_HOST || './stub-worker-host.mjs');
 *
 * Until the real worker host (lane/worker) lands, this runs against
 * scripts/stub-worker-host.mjs — a host built ONLY to shape these
 * assertions (see that file's header). Pointing at the real host is:
 *   FV_WORKER_HOST=../web/src/worker-host.js node scripts/worker-conformance-test.mjs
 * (or whatever path/export name the real host lands under; update the
 * default import above once it exists in this worktree, not the assertions).
 *
 * OBSERVABILITY: every assertion below reads GRANT_ACK fields
 * (playbackNs/cursor/entriesDrained/drainedCounters) — the IN-BAND wire
 * observables ADR-0024 defines. No in-realm closure counts executions: the
 * mock transport structuredClone's every message, which severs closures
 * exactly like a real Worker boundary would, so a closure counter would
 * silently read stale/undefined state. This suite counts nothing that
 * didn't cross the wire.
 *
 * Coverage (bound, per the lane brief): I1, I2, I4, I5, I10, and the §9 prep
 * bracket join, all at message level. I3/I6/I7/I8/I9 are not asserted here.
 */
import { C2W, W2C, msg } from '../web/src/protocol.js';
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
const { installWorkerHost } = await import(process.env.FV_WORKER_HOST || './stub-worker-host.mjs');

process.on('unhandledRejection', (e) => { console.error('\nFAIL - unhandled rejection:', (e && e.stack) || e); process.exit(1); });

let failures = 0;
function fail(m) { failures++; console.error('  FAIL - ' + m); }
function ok(m) { console.log('  ok   - ' + m); }
function assertEq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  else ok(`${label} === ${expected}`);
}
function assertTrue(cond, label) {
  if (!cond) fail(label);
  else ok(label);
}

// ---- rig: one mock session (transport + installed worker host) ----------
function makeSession() {
  const { mainPort, workerPort } = createTransport();
  installWorkerHost(workerPort);
  const inbox = { grantAck: [], frame: [], telemetry: [] };
  mainPort.onmessage = ({ data: m }) => {
    if (m.type === W2C.GRANT_ACK) inbox.grantAck.push(m);
    else if (m.type === W2C.FRAME) inbox.frame.push(m);
    else if (m.type === W2C.TELEMETRY) inbox.telemetry.push(m);
  };
  function send(type, payload) { mainPort.postMessage(msg(type, payload)); }
  return { mainPort, workerPort, send, inbox };
}

async function initSession(epoch, extra = {}) {
  const s = makeSession();
  s.send(C2W.INIT, { epoch, fsId: 'test-fs', geometry: { sectorSize: 4096, sectorCount: 4, pageSize: 256 }, name: 's', ...extra });
  await flushTurns(1);
  return s;
}

function lastAck(s) { return s.inbox.grantAck[s.inbox.grantAck.length - 1]; }

async function grant(s, { epoch, round, entryLimit, playLimitNs, scale = 1 }) {
  const before = s.inbox.grantAck.length;
  s.send(C2W.GRANT, { epoch, round, entryLimit, playLimitNs, scale });
  // Two macrotask turns: turn 1 delivers GRANT to the worker (which, on
  // receipt, synchronously calls postMessage(ack) — that's the SECOND
  // postMessage in the chain); turn 2 delivers that ack back to main. A
  // discarded (stale-epoch) GRANT never posts an ack, so this resolves once
  // 2 turns pass regardless — callers check inbox.length to tell the cases apart.
  await flushTurns(2);
  return s.inbox.grantAck.length > before ? lastAck(s) : undefined;
}

async function ship(s, epoch, entries) {
  s.send(C2W.ENTRIES, { epoch, entries });
  await flushTurns(1);
}

// ═══════════════════════════════════════════════════════════════════════
// I5 — epoch coherence: msg.epoch !== current => discard
// ═══════════════════════════════════════════════════════════════════════
async function testI5() {
  console.log('\nI5 epoch coherence — a message with a stale epoch is discarded');
  const s = await initSession(5);
  await ship(s, 5, [{ index: 0, kind: 'event', payload: { costNs: 1000 }, seed: 0 }]);

  // A GRANT under the WRONG epoch must produce no ack and no execution.
  s.send(C2W.GRANT, { epoch: 4, round: 1, entryLimit: 1, playLimitNs: 1_000_000, scale: 1 });
  await flushTurns(1);
  assertEq(s.inbox.grantAck.length, 0, 'stale-epoch GRANT produced no ack');

  // The correct-epoch GRANT is processed normally.
  const ack1 = await grant(s, { epoch: 5, round: 1, entryLimit: 1, playLimitNs: 1_000_000 });
  assertTrue(!!ack1, 'current-epoch GRANT was acked');
  assertEq(ack1.epoch, 5, 'ack carries current epoch');
  assertEq(ack1.cursor, 1, 'current-epoch GRANT executed the shipped entry');

  // RESET bumps the epoch; the OLD epoch is now stale and must be discarded,
  // including for a session mid-flight (I5's "session rebuilds").
  s.send(C2W.RESET, { epoch: 6 });
  await flushTurns(1);
  const beforeStale = s.inbox.grantAck.length;
  s.send(C2W.GRANT, { epoch: 5, round: 2, entryLimit: 1, playLimitNs: 1_000_000, scale: 1 });
  await flushTurns(2);
  assertEq(s.inbox.grantAck.length, beforeStale, 'post-reset, the OLD epoch is discarded (no new ack)');

  const ack2 = await grant(s, { epoch: 6, round: 1, entryLimit: 0, playLimitNs: 0 });
  assertEq(ack2.epoch, 6, 'new-epoch GRANT after reset is acked under epoch 6');
  assertEq(ack2.cursor, 0, 'reset voided the prior cursor (session rebuilt, not carried over)');
}

// ═══════════════════════════════════════════════════════════════════════
// I10 — grant continuity: unchanged limits while idle => no-op ack, no
// device activity (asserted in-band via grantAck/drainedCounters).
// ═══════════════════════════════════════════════════════════════════════
async function testI10() {
  console.log('\nI10 grant continuity — unchanged limits while idle => no-op ack, no device activity');
  const s = await initSession(1);
  await ship(s, 1, [{ index: 0, kind: 'event', payload: { costNs: 500 }, seed: 0 }]);

  // Round 1: authorize nothing (entryLimit 0) — idle by construction.
  const ack1 = await grant(s, { epoch: 1, round: 1, entryLimit: 0, playLimitNs: 1_000_000 });
  assertEq(ack1.cursor, 0, 'round 1 (entryLimit 0): cursor unmoved');
  assertEq(ack1.drainedCounters.fileOpCount, 0, 'round 1: fileOpCount unmoved');

  // Round 2: SAME limits again (this is what "always sent, no-op when idle"
  // looks like on the wire) — must be acked, and must show ZERO activity.
  const ack2 = await grant(s, { epoch: 1, round: 2, entryLimit: 0, playLimitNs: 1_000_000 });
  assertTrue(!!ack2, 'a repeated no-op GRANT is still acked (every grant acked on receipt)');
  assertEq(ack2.cursor, ack1.cursor, 'no-op re-grant: cursor identical to previous ack');
  assertEq(ack2.playbackNs, ack1.playbackNs, 'no-op re-grant: playbackNs identical (in-band, not a closure read)');
  assertEq(ack2.entriesDrained, ack1.entriesDrained, 'no-op re-grant: entriesDrained identical');
  assertEq(ack2.drainedCounters.fileOpCount, ack1.drainedCounters.fileOpCount, 'no-op re-grant: fileOpCount identical (in-band)');
  assertEq(ack2.drainedCounters.flashTimeNs, ack1.drainedCounters.flashTimeNs, 'no-op re-grant: flashTimeNs identical (in-band)');

  // Now authorize the one shipped entry and confirm activity WOULD show up
  // in-band if it happened — proves the previous rounds' silence was real
  // absence of work, not an assertion that can't detect activity.
  const ack3 = await grant(s, { epoch: 1, round: 3, entryLimit: 1, playLimitNs: 1_000_000 });
  assertTrue(ack3.cursor > ack2.cursor, 'sanity: a genuinely authorizing GRANT DOES move cursor (in-band detectable)');

  // Round 4: limits unchanged from round 3 AND the one entry is already
  // drained (gate now closed) — this must again be a true no-op.
  const ack4 = await grant(s, { epoch: 1, round: 4, entryLimit: 1, playLimitNs: 1_000_000 });
  assertEq(ack4.cursor, ack3.cursor, 'post-drain no-op re-grant: cursor identical');
  assertEq(ack4.drainedCounters.fileOpCount, ack3.drainedCounters.fileOpCount, 'post-drain no-op re-grant: fileOpCount identical');
}

// ═══════════════════════════════════════════════════════════════════════
// I1 — quiescence-as-ack: a command entry's quiescence ack IS its
// completion. No partial credit before the settling round.
// ═══════════════════════════════════════════════════════════════════════
async function testI1() {
  console.log('\nI1 quiescence-as-ack — a command entry completes exactly on its quiescence ack, never before');
  const s = await initSession(1);
  // A command that only settles on the 3rd GRANT that reaches it (models an
  // in-flight op straddling macrotask boundaries — ADR-0019/0024's
  // "quiescence re-check runs at a macrotask boundary").
  await ship(s, 1, [{ index: 0, kind: 'command', payload: { costNs: 9_000_000, fileOps: 1, ticks: 3 }, seed: 0 }]);

  const round1 = await grant(s, { epoch: 1, round: 1, entryLimit: 1, playLimitNs: 100_000_000 });
  assertEq(round1.cursor, 0, 'tick 1/3: not quiesced yet, cursor still 0');
  assertEq(round1.playbackNs, 0, 'tick 1/3: no partial playbackNs credit');
  assertEq(round1.drainedCounters.fileOpCount, 0, 'tick 1/3: no partial fileOpCount credit');

  const round2 = await grant(s, { epoch: 1, round: 2, entryLimit: 1, playLimitNs: 100_000_000 });
  assertEq(round2.cursor, 0, 'tick 2/3: STILL not quiesced, cursor still 0');
  assertEq(round2.playbackNs, 0, 'tick 2/3: still no partial credit (I1: quiescence is atomic, not gradual)');

  const round3 = await grant(s, { epoch: 1, round: 3, entryLimit: 1, playLimitNs: 100_000_000 });
  assertEq(round3.cursor, 1, 'tick 3/3: quiescence ack IS completion — cursor advances exactly here');
  assertEq(round3.playbackNs, 9_000_000, 'tick 3/3: the WHOLE entry cost lands atomically at quiescence');
  assertEq(round3.entriesDrained, 1, 'tick 3/3: entriesDrained matches — completed AND drained together');
  assertEq(round3.drainedCounters.fileOpCount, 1, 'tick 3/3: fileOpCount credited exactly at quiescence, in-band');
}

// ═══════════════════════════════════════════════════════════════════════
// I2 — barrier: release round+1 only after EVERY current session acked
// round.
// ═══════════════════════════════════════════════════════════════════════
async function testI2() {
  console.log('\nI2 barrier — round+1 released only after every current session acked round');
  const a = await initSession(1);
  const b = await initSession(1);
  await ship(a, 1, [{ index: 0, kind: 'event', payload: { costNs: 100 }, seed: 0 }]);
  await ship(b, 1, [{ index: 0, kind: 'event', payload: { costNs: 100 }, seed: 0 }]);

  // A tiny coordinator-side barrier tracker: exactly what I2 requires the
  // real coordinator to enforce. Its correctness depends entirely on the
  // worker's ack.round field being trustworthy, which is what's under test.
  const ackedRound = new Map(); // sessionId -> highest round acked

  async function grantAndTrack(sessId, s, round) {
    const a2 = await grant(s, { epoch: 1, round, entryLimit: 1, playLimitNs: 1_000_000 });
    ackedRound.set(sessId, a2.round);
    return a2;
  }
  function barrierReady(round, sessIds) {
    return sessIds.every((id) => (ackedRound.get(id) ?? -1) >= round);
  }

  // Only A is granted+acked round 1; B has not been sent round 1 at all.
  await grantAndTrack('A', a, 1);
  assertTrue(!barrierReady(1, ['A', 'B']), 'barrier NOT ready: B has not acked round 1 (never sent it)');

  // Now B acks round 1 too.
  await grantAndTrack('B', b, 1);
  assertTrue(barrierReady(1, ['A', 'B']), 'barrier ready: both A and B have acked round 1');

  // Only once the barrier is ready may round 2 be issued to either session;
  // demonstrate it lands correctly for both, honoring the just-checked gate.
  const a2 = await grantAndTrack('A', a, 2);
  const b2 = await grantAndTrack('B', b, 2);
  assertEq(a2.round, 2, 'round 2 correctly issued to A only after the round-1 barrier closed');
  assertEq(b2.round, 2, 'round 2 correctly issued to B only after the round-1 barrier closed');
}

// ═══════════════════════════════════════════════════════════════════════
// I4 — derived limit: playLimitNs is NEVER accumulated across rounds.
// Demonstrates the exact ADR-0024 §2 counter-model failure ("a banked tiny
// read must not keep the gate open against a large chunk after a scale
// change") by running the SAME scenario through a correct DERIVED
// coordinator and a WRONG ACCUMULATING one, against real worker acks.
// ═══════════════════════════════════════════════════════════════════════
function computeRelDerived({ ackedPlaybackNs, baselineNs, chunkNs }) {
  // §2: rel = MAX over s of (acked_s - baseline_s) + chunk  (recomputed every
  // round from ACKED playbackNs — never accumulated from the prior grant).
  return Math.max(ackedPlaybackNs - baselineNs, 0) + chunkNs;
}

async function testI4() {
  console.log('\nI4 derived limit — playLimitNs is recomputed from acked playbackNs every round, never accumulated');

  const BACKLOG = 2000;
  function backlogEntries() {
    const entries = [{ index: 0, kind: 'event', payload: { costNs: 70_000 }, seed: 0 }]; // the "tiny read"
    for (let i = 1; i <= BACKLOG; i++) entries.push({ index: i, kind: 'event', payload: { costNs: 200 }, seed: 0 });
    return entries;
  }

  const chunk1 = 150_000_000; // fast scale: 150ms chunk

  // ---- correct: DERIVED recompute every round ---------------------------
  // Isolate the scale-change transition: one round of "large chunk, but
  // entryLimit withholds all but the tiny read" (the banked state), then a
  // scale change to a tiny chunk, recomputed fresh from acked playbackNs.
  const derived2 = await initSession(2);
  await ship(derived2, 2, backlogEntries());
  // Round 1: large chunk, but entryLimit=1 so only the tiny read CAN run —
  // this is the "banked" state: acked playbackNs=70_000 while the grant's
  // chunk was 150ms.
  const banked = await grant(derived2, { epoch: 2, round: 1, entryLimit: 1, playLimitNs: computeRelDerived({ ackedPlaybackNs: 0, baselineNs: 0, chunkNs: chunk1 }) });
  assertEq(banked.playbackNs, 70_000, 'banked round: only the tiny read consumed (entryLimit withheld the rest)');
  assertEq(banked.cursor, 1, 'banked round: cursor advanced past only the tiny read');

  // Scale change: user switches to deep slow-mo, chunk shrinks to 50µs.
  const chunk2 = 50_000;
  const derivedPlayLimit2 = computeRelDerived({ ackedPlaybackNs: banked.playbackNs, baselineNs: 0, chunkNs: chunk2 });
  assertEq(derivedPlayLimit2, 120_000, 'derived playLimitNs after scale change: acked(70_000) + chunk(50_000), NOT accumulated');
  const dAfterScaleChange = await grant(derived2, { epoch: 2, round: 2, entryLimit: BACKLOG + 1, playLimitNs: derivedPlayLimit2, scale: 1 });
  const derivedEntriesRun = dAfterScaleChange.cursor - banked.cursor;
  assertTrue(derivedEntriesRun < 300, `derived: scale-change round executed a BOUNDED number of entries (${derivedEntriesRun}), matching the new tiny chunk's headroom`);

  // ---- wrong: ACCUMULATING model (playLimitNs += chunk, never recomputed
  // from acked) — the rejected counter-model this invariant guards against.
  const accum = await initSession(3);
  await ship(accum, 3, backlogEntries());
  let accumPlayLimit = 0 + chunk1; // baseline(0) + chunk1, same as round 1 above
  const accBanked = await grant(accum, { epoch: 3, round: 1, entryLimit: 1, playLimitNs: accumPlayLimit });
  assertEq(accBanked.cursor, 1, 'accumulating rig: same banked state as the derived rig (only the tiny read ran)');
  // WRONG: accumulate instead of recompute from acked.
  accumPlayLimit += chunk2; // 150_000_000 + 50_000 — the leaked-open gate
  const accAfterScaleChange = await grant(accum, { epoch: 3, round: 2, entryLimit: BACKLOG + 1, playLimitNs: accumPlayLimit, scale: 1 });
  const accumEntriesRun = accAfterScaleChange.cursor - accBanked.cursor;
  assertTrue(accumEntriesRun >= BACKLOG - 1, `accumulating (WRONG) model: the leaked-open gate drains almost the WHOLE backlog (${accumEntriesRun} entries) in one round after a scale change to slow-mo — exactly the bug I4 forbids`);
  assertTrue(accumEntriesRun > derivedEntriesRun * 5, `accumulating model runs far more entries (${accumEntriesRun}) than the derived model (${derivedEntriesRun}) for the identical scale-change scenario`);
}

// ═══════════════════════════════════════════════════════════════════════
// §9 — prep bracket join: prep(false)@j withholds entry j (entryLimit=j)
// until every session's entriesDrained >= j-1, then releases j to all at
// once; on prep(false), displayed counters zero + baseline reseat.
// ═══════════════════════════════════════════════════════════════════════
async function testPrepBracketJoin() {
  console.log('\n§9 prep bracket join — entry j withheld until all sessions drained j-1, then released together; counters zero on exit');

  // Sequence: 0,1 ordinary entries; 2 = prep(true); 3,4 = entries inside the
  // bracket (must execute INSTANTLY, ignoring playLimitNs); 5 = prep(false)
  // (= j, the withheld entry); 6 = an ordinary entry after the bracket.
  const J = 5;
  function seq() {
    return [
      { index: 0, kind: 'event', payload: { costNs: 1000, fileOps: 1 }, seed: 0 },
      { index: 1, kind: 'event', payload: { costNs: 1000, fileOps: 1 }, seed: 0 },
      { index: 2, kind: 'command', payload: { prep: true }, seed: 0 },
      { index: 3, kind: 'event', payload: { costNs: 50_000_000, fileOps: 1 }, seed: 0 }, // huge cost, but inside prep => instant
      { index: 4, kind: 'event', payload: { costNs: 50_000_000, fileOps: 1 }, seed: 0 },
      { index: J, kind: 'command', payload: { prep: false, costNs: 500 }, seed: 0 },
      { index: 6, kind: 'event', payload: { costNs: 1000, fileOps: 1 }, seed: 0 },
    ];
  }

  const a = await initSession(1);
  const b = await initSession(1);
  await ship(a, 1, seq());
  await ship(b, 1, seq());

  // Coordinator withholds entryLimit at J for BOTH sessions (this is the
  // withholding half of the join — mechanical, since entryLimit is what
  // gates execution). playLimitNs is sized to cover the two ordinary
  // pre-bracket entries (cost 1000 each) normally, but is FAR smaller than
  // entries 3/4's cost (50_000_000 each) — proving those execute only
  // because prep suspends metering, not because the budget covers them.
  const TINY_PLAYLIMIT = 5000;
  const aWithheld = await grant(a, { epoch: 1, round: 1, entryLimit: J, playLimitNs: TINY_PLAYLIMIT });
  assertEq(aWithheld.entriesDrained, J, 'A: drained everything up TO the withheld entry (0..J-1), despite a budget far below entries 3/4\'s cost — prep suspends metering');
  assertEq(aWithheld.cursor, J, 'A: cursor sits exactly at the withheld entry, not past it');

  // B lags behind: only grant it enough to reach entry 1 (not yet through
  // the bracket) — the join condition (entriesDrained >= J-1 for ALL
  // sessions) is NOT yet satisfied.
  const bLag = await grant(b, { epoch: 1, round: 1, entryLimit: 2, playLimitNs: 1_000_000 });
  assertEq(bLag.entriesDrained, 2, 'B: lagging, only drained through entry 1');
  assertTrue(bLag.entriesDrained < J - 1, 'B has NOT reached the join threshold (entriesDrained >= J-1) yet');

  // Coordinator must NOT release entry J to anyone yet. Re-granting A with
  // the SAME withheld entryLimit is the correct behavior while B lags;
  // confirm A stays parked at J (no forward progress past the withheld
  // entry) — this is the observable half of "withheld until the join".
  const aStillWithheld = await grant(a, { epoch: 1, round: 2, entryLimit: J, playLimitNs: TINY_PLAYLIMIT });
  assertEq(aStillWithheld.cursor, J, 'A: still parked at the withheld entry while B has not joined');

  // B catches up to the join threshold (entriesDrained >= J-1).
  const bCaughtUp = await grant(b, { epoch: 1, round: 2, entryLimit: J, playLimitNs: TINY_PLAYLIMIT });
  assertEq(bCaughtUp.entriesDrained, J, 'B: now drained through J-1 (entryLimit=J caps it there) — prep entries instant despite tiny playLimit');
  assertTrue(bCaughtUp.entriesDrained >= J - 1, 'B has now reached the join threshold');

  // Join satisfied for both (A already was at J-1-drained-equivalent via
  // cursor=J meaning entries 0..J-1 done; B now matches). Coordinator
  // releases entry J to BOTH by raising entryLimit past J in the same
  // logical round.
  const aRelease = await grant(a, { epoch: 1, round: 3, entryLimit: J + 1, playLimitNs: 1_000_000 });
  const bRelease = await grant(b, { epoch: 1, round: 3, entryLimit: J + 1, playLimitNs: 1_000_000 });
  assertEq(aRelease.cursor, J + 1, 'A: prep(false)@J released and executed once the join closed');
  assertEq(bRelease.cursor, J + 1, 'B: prep(false)@J released and executed in the same release');

  // §9: on prep(false), displayed counters (fileOpCount, flashTimeNs) zero
  // at the exit join. Before J, both sessions had accrued fileOpCount from
  // entries 0/1 (2 file ops each, entries 3/4 also count) — confirm the
  // reset actually happened rather than merely coinciding with zero.
  assertTrue(aWithheld.drainedCounters.fileOpCount > 0, 'sanity: A had accrued nonzero fileOpCount before the exit join');
  assertEq(aRelease.drainedCounters.fileOpCount, 0, 'A: fileOpCount zeroed exactly at the prep(false) exit join');
  assertEq(aRelease.drainedCounters.flashTimeNs, 0, 'A: flashTimeNs zeroed exactly at the prep(false) exit join');
  assertEq(bRelease.drainedCounters.fileOpCount, 0, 'B: fileOpCount zeroed exactly at the prep(false) exit join');
  assertEq(bRelease.drainedCounters.flashTimeNs, 0, 'B: flashTimeNs zeroed exactly at the prep(false) exit join');

  // Post-bracket: an ordinary entry after J accrues normally again (counters
  // are zeroed, not frozen). playbackNs itself is NOT reset by prep(false)
  // (only the DISPLAYED counters are, per §9) — it already carries the two
  // huge in-bracket entries' cost, so playLimitNs here must clear that, not
  // just the tiny post-bracket entry's own cost.
  const aAfter = await grant(a, { epoch: 1, round: 4, entryLimit: J + 2, playLimitNs: 200_000_000 });
  assertEq(aAfter.cursor, J + 2, 'A: post-bracket entry executes normally');
  assertEq(aAfter.drainedCounters.fileOpCount, 1, 'A: post-bracket fileOpCount counts up fresh from the zeroed baseline');
}

// ---- run all --------------------------------------------------------------
console.log('worker-conformance suite (ADR-0024 §2/§4/§5/§9, message-level, over the mock transport)');
await testI5();
await testI10();
await testI1();
await testI2();
await testI4();
await testPrepBracketJoin();

console.log('');
if (failures) {
  console.error(`FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PASS - I1 (quiescence-as-ack), I2 (barrier), I4 (derived limit), I5 (epoch coherence),');
console.log('       I10 (grant continuity), and the §9 prep bracket join all conform.');
process.exit(0);
