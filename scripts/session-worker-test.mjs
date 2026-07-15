/*
 * session-worker-test.mjs — message-level conformance test for
 * web/src/session-worker.js (ADR-0024 lane W). Drives the worker host
 * through scripts/mock-worker-transport.mjs (structuredClone + async ordered
 * delivery — a faithful in-realm Worker-port model, ADR-0024 §13) acting as
 * the coordinator: INIT / ENTRIES / GRANT / PULL / RESET in, asserting
 * GRANT_ACK / FRAME / TELEMETRY shapes and the §2 gate out.
 *
 * dist/*.mjs (real WASM filesystems) is gitignored and not present in every
 * worktree — this test injects scripts/worker-stub-runner.mjs (a real
 * device.js behind a small in-memory file table) via session-worker.js's
 * `createRunner` seam, per the lane brief.
 */
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
import { createWorkerHost } from '../web/src/session-worker.js';
import { createStubRunner } from './worker-stub-runner.mjs';
import { C2W, W2C, msg } from '../web/src/protocol.js';

let failures = 0;
const fail = (m) => { failures++; console.error('  FAIL -', m); };
const ok = (m) => console.log('  ok   -', m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const GEOMETRY = { sectorSize: 4096, sectorCount: 8, pageSize: 256 };

async function run() {
  const { mainPort, workerPort } = createTransport();
  createWorkerHost(workerPort, { createRunner: createStubRunner });

  const inbox = { grantAck: [], frame: [], telemetry: [] };
  mainPort.onmessage = (e) => {
    const m = e.data;
    if (m.type === W2C.GRANT_ACK) inbox.grantAck.push(m);
    else if (m.type === W2C.FRAME) inbox.frame.push(m);
    else if (m.type === W2C.TELEMETRY) inbox.telemetry.push(m);
  };

  const EPOCH = 1;
  mainPort.postMessage(msg(C2W.INIT, { epoch: EPOCH, fsId: 'stub', geometry: GEOMETRY, name: 'stub' }));
  await flushTurns(4);   // let INIT's async runner build land

  // ---- entries: two churn writes, one gc, one command (two more writes) ----
  const COMMAND_SRC = "async (api) => { await api.writeFile('c.bin', 2048); await api.writeFile('d.bin', 2048); }";
  mainPort.postMessage(msg(C2W.ENTRIES, {
    epoch: EPOCH,
    entries: [
      { index: 0, kind: 'event', payload: { type: 'write', name: 'a.bin', size: 4096, writeSeed: 1 }, seed: 0 },
      { index: 1, kind: 'event', payload: { type: 'write', name: 'b.bin', size: 1024, writeSeed: 2 }, seed: 0 },
      { index: 2, kind: 'gc', payload: null, seed: 0 },
      { index: 3, kind: 'command', payload: COMMAND_SRC, seed: 42 },
    ],
  }));
  await flushTurns(2);

  // ---- 1. §2 gate: a tiny playLimitNs caps playback to ONE op's worth (the
  //         gate is only re-checked BETWEEN ops — "one-op overshoot" — so
  //         with entryLimit:2 and playLimitNs:1, entry 0 (the one op already
  //         queued when the gate was open) fully plays out, but entry 1's
  //         playback never STARTS: entriesDrained must stop at 0, not 1, even
  //         though execution (fast, synchronous) may race both entries ahead ----
  mainPort.postMessage(msg(C2W.GRANT, { epoch: EPOCH, round: 1, entryLimit: 2, playLimitNs: 1, scale: Infinity }));
  await flushTurns(2);
  await wait(40);   // let at least one 16ms tick run so the player has a chance to drain

  const acksRound1 = inbox.grantAck.filter((a) => a.round === 1);
  if (!acksRound1.length) fail('no grantAck received for round 1 (I10: every grant must be acked on receipt)');
  else ok(`round 1 acked (${acksRound1.length} ack(s))`);
  const lastAck1 = acksRound1[acksRound1.length - 1];
  if (lastAck1 && lastAck1.cursor >= 1) ok(`entry 0 executed (cursor=${lastAck1.cursor}) despite the tiny playback cap — execution and playback are decoupled`);
  else fail(`entry 0 did not execute even though entryLimit=2 (cursor=${lastAck1 && lastAck1.cursor})`);
  if (lastAck1 && lastAck1.entriesDrained === 0) ok(`entriesDrained stopped at entry 0 (${lastAck1.entriesDrained}) — one-op overshoot played entry 0 out, but entry 1's playback never started past the watermark`);
  else fail(`entriesDrained should be exactly 0, got ${lastAck1 && lastAck1.entriesDrained} (playLimitNs=1 gate not honored)`);

  // ---- 2. raise playLimitNs + entryLimit across further "frames" (a no-op
  //         grant when unchanged is I10; here every round genuinely changes) ----
  let round = 2;
  let playLimitNs = 60_000_000;   // covers entry 0's ~24.3ms write comfortably
  for (; round <= 6; round++) {
    mainPort.postMessage(msg(C2W.GRANT, { epoch: EPOCH, round, entryLimit: 4, playLimitNs, scale: Infinity }));
    await flushTurns(2);
    await wait(30);
    playLimitNs += 200_000_000;
  }
  const acksLater = inbox.grantAck.filter((a) => a.round === round - 1);
  const lastAckLater = acksLater[acksLater.length - 1] || inbox.grantAck[inbox.grantAck.length - 1];
  if (lastAckLater.cursor === 4) ok('all 4 entries executed once entryLimit opened up (cursor=4)');
  else fail(`cursor did not reach 4 (got ${lastAckLater.cursor}) after raising entryLimit/playLimitNs`);
  if (lastAckLater.entriesDrained >= 3) ok(`entriesDrained caught up to the tail (${lastAckLater.entriesDrained}) once playback had headroom`);
  else fail(`entriesDrained did not catch up (${lastAckLater.entriesDrained}) despite ample playLimitNs`);

  // ---- 3. quiescence-as-ack (I1): the command entry (index 3) completed —
  //         both writeFile calls it issued must actually have landed ----
  await mainPort.postMessage(msg(C2W.PULL, { epoch: EPOCH, journal: { since: -1, limit: 400 } }));
  await flushTurns(2);
  const frame1 = inbox.frame[inbox.frame.length - 1];
  if (!frame1) fail('no FRAME received for a journal PULL');
  else {
    const texts = frame1.journal.map((j) => j.text).join(' | ');
    if (/write\(c\.bin, 2048 B\)/.test(texts) && /write\(d\.bin, 2048 B\)/.test(texts))
      ok('command entry\'s two writeFile ops both landed in the journal (quiescence ran the whole command)');
    else fail(`command ops missing from journal: ${texts}`);
    const doneLine = frame1.journal.find((j) => j.entryIndex === 3 && j.kind === 'done');
    if (doneLine) ok('command entry has a done journal line (quiescence recorded)');
    else fail('no done journal line for the command entry');
  }

  // ---- 4. FRAME shape: heat / shown+wear / journalHead / eventHead ----
  await mainPort.postMessage(msg(C2W.PULL, { epoch: EPOCH, heat: true, wear: true, journal: { since: -1, limit: 400 }, events: { since: -1, limit: 400 } }));
  await flushTurns(2);
  const frame2 = inbox.frame[inbox.frame.length - 1];
  const npages = (GEOMETRY.sectorSize / GEOMETRY.pageSize) * GEOMETRY.sectorCount;
  if (frame2.heat && frame2.heat.readHeat.length === npages && frame2.heat.progHeat.length === npages) ok('heat is full per-page state, sized to the geometry');
  else fail('heat field missing or wrong length');
  if (frame2.shown && frame2.shown.shown.length === npages && frame2.shown.wear.length === GEOMETRY.sectorCount) ok('shown+wear sized correctly');
  else fail('shown/wear field missing or wrong length');
  if (typeof frame2.journalHead === 'number' && typeof frame2.eventHead === 'number') ok(`journalHead/eventHead present (${frame2.journalHead}/${frame2.eventHead})`);
  else fail('journalHead/eventHead missing');

  // ---- 5. TELEMETRY: unconditional ~250ms heartbeat ----
  const before = inbox.telemetry.length;
  await wait(320);
  if (inbox.telemetry.length > before) ok(`telemetry heartbeat fired (${inbox.telemetry.length - before} message(s) in ~320ms)`);
  else fail('no telemetry heartbeat observed in ~320ms (should be unconditional every ~250ms)');
  const t = inbox.telemetry[inbox.telemetry.length - 1];
  if (t && t.fsinfo && t.livenessCounts && typeof t.exec_fileOpCount === 'number' && typeof t.exec_simNs === 'number') ok('telemetry payload shape correct');
  else fail('telemetry payload missing a field');

  // ---- 6. epoch discard (I5): a stale-epoch GRANT is ignored ----
  const ackCountBefore = inbox.grantAck.length;
  mainPort.postMessage(msg(C2W.GRANT, { epoch: EPOCH + 1, round: 99, entryLimit: 4, playLimitNs: 1e9, scale: Infinity }));
  await flushTurns(2);
  if (inbox.grantAck.length === ackCountBefore) ok('a grant with a stale/future epoch was discarded (I5)');
  else fail('a mismatched-epoch grant was NOT discarded');

  // ---- 7. RESET: halts, wipes flash, entries/cursor void, epoch bumps ----
  const NEW_EPOCH = 2;
  mainPort.postMessage(msg(C2W.RESET, { epoch: NEW_EPOCH }));
  await flushTurns(2);
  mainPort.postMessage(msg(C2W.GRANT, { epoch: NEW_EPOCH, round: 1, entryLimit: 0, playLimitNs: 0, scale: Infinity }));
  await flushTurns(2);
  const postResetAck = inbox.grantAck[inbox.grantAck.length - 1];
  if (postResetAck.epoch === NEW_EPOCH && postResetAck.cursor === 0 && postResetAck.playbackNs === 0)
    ok('RESET voided cursor/playbackNs and moved to the new epoch');
  else fail(`RESET did not fully void state: ${JSON.stringify(postResetAck)}`);

  await mainPort.postMessage(msg(C2W.PULL, { epoch: NEW_EPOCH, journal: { newest: true, limit: 400 } }));
  await flushTurns(2);
  const frame3 = inbox.frame[inbox.frame.length - 1];
  if (frame3.journal.length === 0) ok('journal is empty after RESET (fresh epoch, no stale lines)');
  else fail(`journal not empty after RESET: ${frame3.journal.length} lines`);

  console.log('');
  if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
  console.log('PASS - session-worker.js answers INIT/ENTRIES/GRANT/PULL/RESET correctly (§2 gate, I1 quiescence, I5 epoch discard verified).');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
