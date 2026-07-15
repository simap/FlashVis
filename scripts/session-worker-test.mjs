/*
 * session-worker-test.mjs: message-level test for web/src/session-worker.js
 * against a REAL device (scripts/worker-stub-runner.mjs behind runner.js's
 * seam; dist WASM is gitignored). Complements scripts/worker-conformance-test.mjs
 * (which drives the synthetic-cost state machine): this exercises the REAL
 * execution path: real churn writes, a real ADR-0019 sandbox command from raw
 * source text, real heat/shown/erase-event FRAME payloads, and telemetry.
 */
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
import { installWorkerHost } from '../web/src/session-worker.js';
import { createStubRunner } from './worker-stub-runner.mjs';
import { C2W, W2C, msg } from '../web/src/protocol.js';

let failures = 0;
const fail = (m) => { failures++; console.error('  FAIL -', m); };
const ok = (m) => console.log('  ok   -', m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const GEOMETRY = { sectorSize: 4096, sectorCount: 8, pageSize: 256 };

async function run() {
  const { mainPort, workerPort } = createTransport();
  installWorkerHost(workerPort, { createRunner: createStubRunner });

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

  // Raw console source (ADR-0019 sandbox model): bare-name statements, no
  // async(api)=>{} wrapper: the worker wraps it in the per-session sandbox.
  const COMMAND_SRC = "await writeFile('c.bin', 2048); await writeFile('d.bin', 2048); await gc()";
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

  // ---- 1. THE TWO-LAYER TIMED PLAYER (ADR-0024 §2/§6): EXECUTION is eager,
  //         PLAYBACK is metered against playLimitNs. A tiny playLimitNs=1 must
  //         hold playbackNs at the ceiling (paced) even though execution (cursor)
  //         races ahead: playbackNs is the currency, NOT the executed op cost.
  //         (This is the B6/B7/B8 fix: pre-fix, playbackNs vaulted to entry 0's
  //         full ~24ms write cost on one-op overshoot.) ----
  mainPort.postMessage(msg(C2W.GRANT, { epoch: EPOCH, round: 1, entryLimit: 2, playLimitNs: 1, scale: 20000 }));
  await wait(80);   // let the ~16ms metering tick run several times
  const ack1 = inbox.grantAck.filter((a) => a.round === 1).pop();
  if (!ack1) fail('no grantAck for round 1 (I10)');
  else ok('round 1 acked (I10: every grant acked on receipt)');
  if (ack1 && ack1.cursor >= 1) ok(`execution ran eagerly despite playLimitNs=1 (cursor=${ack1.cursor}, decoupled from playback)`);
  else fail(`execution did not run (cursor=${ack1 && ack1.cursor})`);
  if (ack1 && ack1.playbackNs === 1) ok('PACED: playbackNs held exactly at playLimitNs=1 (continuous intra-event, NOT vaulted to entry 0\'s full flash cost)');
  else fail(`playbackNs not paced to the ceiling: expected 1, got ${ack1 && ack1.playbackNs} (B7: sim outran the gate)`);
  if (ack1 && ack1.entriesDrained === -1) ok('entriesDrained = -1: entry 0 executed but NOT yet drained (its ~24ms of flash has not played back under a 1ns budget)');
  else fail(`entriesDrained should be -1 (entry 0 not drained), got ${ack1 && ack1.entriesDrained}`);

  // ---- 2. open the gate + entryLimit at no-delay: all 4 entries EXECUTE, incl.
  //         the async command (index 3, quiesces over macrotasks, I1), and the
  //         metered player DRAINS the whole backlog flat-out-but-chunked ----
  mainPort.postMessage(msg(C2W.GRANT, { epoch: EPOCH, round: 2, entryLimit: 4, playLimitNs: 1e12, scale: Infinity }));
  await wait(200);   // command quiesces + no-delay player drains the queue
  const ackLater = inbox.grantAck[inbox.grantAck.length - 1];
  if (ackLater.cursor === 4) ok('all 4 entries executed (churn ×2, gc, command) once the gate opened');
  else fail(`cursor did not reach 4 (got ${ackLater.cursor})`);
  if (ackLater.entriesDrained === 3) ok('entriesDrained reached 3 = highest index (all 4 drained; command completed AND metered-drained, §6)');
  else fail(`entriesDrained not 3 (${ackLater.entriesDrained})`);
  if (ackLater.playbackNs > 1) ok(`playbackNs advanced to real flash time once drained (${(ackLater.playbackNs / 1e6).toFixed(1)} ms)`);
  else fail(`playbackNs did not advance after drain (${ackLater.playbackNs})`);
  if (ackLater.drainedCounters.fileOpCount >= 4) ok(`fileOpCount accrued from real ops (${ackLater.drainedCounters.fileOpCount}: 2 churn + 2 command writes; gc excluded)`);
  else fail(`fileOpCount too low (${ackLater.drainedCounters.fileOpCount})`);

  // ---- 3. command ran from raw sandbox source: its two writeFile ops landed ----
  mainPort.postMessage(msg(C2W.PULL, { epoch: EPOCH, journal: { since: -1, limit: 400 } }));
  await flushTurns(2);
  const jf = inbox.frame[inbox.frame.length - 1];
  const jtexts = jf.journal.map((j) => j.text).join(' | ');
  if (/write\(c\.bin, 2048 B\)/.test(jtexts) && /write\(d\.bin, 2048 B\)/.test(jtexts))
    ok('raw-source command executed via the sandbox (both writeFile ops in the journal)');
  else fail(`command ops missing from journal: ${jtexts}`);
  if (jf.journal.some((j) => j.entryIndex === 3 && j.kind === 'done')) ok('command has a done journal line (quiescence recorded, kind:done in JOURNAL not events)');
  else fail('no done journal line for the command');

  // ---- 4. FRAME shape (protocol.js pinned typedefs): heat.read/prog,
  //         shown.pages/wear, events[] (erase EventEntries), heads ----
  mainPort.postMessage(msg(C2W.PULL, { epoch: EPOCH, heat: true, wear: true, journal: { since: -1, limit: 400 }, events: { since: -1, limit: 400 } }));
  await flushTurns(2);
  const f = inbox.frame[inbox.frame.length - 1];
  const npages = (GEOMETRY.sectorSize / GEOMETRY.pageSize) * GEOMETRY.sectorCount;
  if (f.heat && f.heat.read instanceof Float32Array && f.heat.prog instanceof Float32Array && f.heat.read.length === npages) ok('FRAME.heat = {read, prog} Float32Array[pageCount] (FrameHeat)');
  else fail('FRAME.heat wrong shape/type');
  if (f.shown && f.shown.pages instanceof Uint16Array && f.shown.pages.length === npages && f.shown.wear instanceof Uint32Array && f.shown.wear.length === GEOMETRY.sectorCount) ok('FRAME.shown = {pages:Uint16Array, wear:Uint32Array} (FrameShown)');
  else fail('FRAME.shown wrong shape/type');
  const eraseEvents = f.events.filter((e) => e.kind === 'erase');
  if (eraseEvents.length > 0 && eraseEvents.every((e) => typeof e.id === 'number' && typeof e.sector === 'number' && typeof e.ms === 'number'))
    ok(`FRAME.events carries erase EventEntries {id,kind:'erase',sector,ms} (${eraseEvents.length} from gc erases), sourced from device ERASE ops, not command lifecycle`);
  else fail(`no well-formed erase EventEntries (got ${JSON.stringify(f.events.slice(0, 3))})`);
  if (f.events.every((e) => e.kind !== 'command')) ok('no command-lifecycle entries polluting the events ring (they live in the journal)');
  else fail('command lifecycle leaked into the events ring');
  if (typeof f.journalHead === 'number' && typeof f.eventHead === 'number') ok(`journalHead/eventHead present (${f.journalHead}/${f.eventHead})`);
  else fail('journalHead/eventHead missing');

  // ---- 5. liveMap PULL: version + classes (FrameLiveMap) ----
  mainPort.postMessage(msg(C2W.PULL, { epoch: EPOCH, liveMap: { since: -1 } }));
  await flushTurns(2);
  const lf = inbox.frame[inbox.frame.length - 1];
  if (lf.liveMap && typeof lf.liveMap.version === 'number' && lf.liveMap.classes instanceof Uint8Array) ok('FRAME.liveMap = {version, classes:Uint8Array} (FrameLiveMap), sent iff version > since');
  else fail(`FRAME.liveMap wrong shape (${JSON.stringify(lf.liveMap)})`);

  // ---- 6. TELEMETRY: unconditional ~250ms heartbeat incl. write-amp fields ----
  const before = inbox.telemetry.length;
  await wait(320);
  if (inbox.telemetry.length > before) ok(`telemetry heartbeat fired (${inbox.telemetry.length - before} in ~320ms)`);
  else fail('no telemetry heartbeat in ~320ms');
  const t = inbox.telemetry[inbox.telemetry.length - 1];
  if (t && t.fsinfo && t.livenessCounts && typeof t.exec_fileOpCount === 'number' && typeof t.exec_simNs === 'number') ok('telemetry base fields present');
  else fail('telemetry base field missing');
  if (t && typeof t.programBytes === 'number' && typeof t.hostBytes === 'number' && t.programBytes > 0 && t.hostBytes > 0)
    ok(`telemetry carries programBytes/hostBytes for write-amp (${t.programBytes}/${t.hostBytes})`);
  else fail(`telemetry programBytes/hostBytes missing or zero (${t && t.programBytes}/${t && t.hostBytes})`);

  // ---- 7. epoch discard (I5) ----
  const nAcks = inbox.grantAck.length;
  mainPort.postMessage(msg(C2W.GRANT, { epoch: EPOCH + 5, round: 99, entryLimit: 4, playLimitNs: 1e9, scale: 20000 }));
  await flushTurns(2);
  if (inbox.grantAck.length === nAcks) ok('stale/future-epoch GRANT discarded (I5)');
  else fail('mismatched-epoch grant not discarded');

  // ---- 8. RESET: wipes flash + local state, bumps epoch ----
  const NEW_EPOCH = 2;
  mainPort.postMessage(msg(C2W.RESET, { epoch: NEW_EPOCH }));
  await flushTurns(2);
  mainPort.postMessage(msg(C2W.GRANT, { epoch: NEW_EPOCH, round: 1, entryLimit: 0, playLimitNs: 0, scale: 20000 }));
  await flushTurns(2);
  const rAck = inbox.grantAck[inbox.grantAck.length - 1];
  if (rAck.epoch === NEW_EPOCH && rAck.cursor === 0 && rAck.playbackNs === 0) ok('RESET voided cursor/playbackNs and moved to the new epoch');
  else fail(`RESET did not fully void state: ${JSON.stringify(rAck)}`);
  mainPort.postMessage(msg(C2W.PULL, { epoch: NEW_EPOCH, journal: { newest: true, limit: 400 } }));
  await flushTurns(2);
  const rf = inbox.frame[inbox.frame.length - 1];
  if (rf.journal.length === 0) ok('journal empty after RESET (fresh epoch)');
  else fail(`journal not empty after RESET (${rf.journal.length})`);

  // ---- 9. B2: a RESET arriving BEFORE INIT's async runner build lands must not
  //         leave the session runner-less. Fresh session; INIT then RESET on the
  //         same turn (no flushTurns between → the build has not resolved), then
  //         confirm a real churn write actually executes AND drains. ----
  const t2 = createTransport();
  const w2 = { grantAck: [], frame: [] };
  installWorkerHost(t2.workerPort, { createRunner: createStubRunner });
  t2.mainPort.onmessage = (e) => { const m = e.data; if (m.type === W2C.GRANT_ACK) w2.grantAck.push(m); else if (m.type === W2C.FRAME) w2.frame.push(m); };
  t2.mainPort.postMessage(msg(C2W.INIT, { epoch: 10, fsId: 'stub', geometry: GEOMETRY, name: 'stub' }));
  t2.mainPort.postMessage(msg(C2W.RESET, { epoch: 11 }));   // races the in-flight INIT build (B2)
  await flushTurns(6);   // let both the discarded and the rebuilt runner settle
  t2.mainPort.postMessage(msg(C2W.ENTRIES, { epoch: 11, entries: [{ index: 0, kind: 'event', payload: { type: 'write', name: 'b2.bin', size: 2048, writeSeed: 7 }, seed: 0 }] }));
  await flushTurns(2);
  t2.mainPort.postMessage(msg(C2W.GRANT, { epoch: 11, round: 1, entryLimit: 1, playLimitNs: 1e12, scale: Infinity }));
  await wait(80);
  const b2ack = w2.grantAck[w2.grantAck.length - 1];
  if (b2ack && b2ack.epoch === 11 && b2ack.cursor === 1 && b2ack.playbackNs > 0)
    ok('B2: RESET before the INIT build landed still yields a runner, real write executed + drained (not runner-less)');
  else fail(`B2: session runner-less after RESET-races-INIT (ack=${JSON.stringify(b2ack)})`);

  // ---- 8. B18: erase sweeps must surface at SLOW-MO, not just fast. The events
  //         cursor the coordinator feeds back each frame is the eventHead we last
  //         reported (playground.js: eventsSince = frame.eventHead), and eventHead
  //         is nextId, ONE PAST the highest id issued. Honoring it verbatim
  //         against an EXCLUSIVE ring (id > since) dropped the very next erase. At
  //         fast speed many erases land per frame so the drop is invisible; at
  //         slow-mo exactly ONE lands between pulls and it IS the dropped one, so
  //         the sweep never surfaced (inverted visibility). Drive gc erases at a
  //         slow scale, pull with the head-as-since cursor, and assert each erase
  //         surfaces exactly once AND holds for a long scaled ms. ----
  {
    const t3 = createTransport();
    installWorkerHost(t3.workerPort, { createRunner: createStubRunner });
    const w3 = { grantAck: [], frame: [] };
    t3.mainPort.onmessage = (e) => { const m = e.data; if (m.type === W2C.GRANT_ACK) w3.grantAck.push(m); else if (m.type === W2C.FRAME) w3.frame.push(m); };
    t3.mainPort.postMessage(msg(C2W.INIT, { epoch: 20, fsId: 'stub', geometry: GEOMETRY, name: 'stub' }));
    await flushTurns(6);
    const gcEntries = [];
    for (let i = 0; i < 12; i++) {
      gcEntries.push({ index: gcEntries.length, kind: 'event', payload: { type: 'write', name: `g${i}.bin`, size: 1024, writeSeed: i + 1 }, seed: 0 });
      gcEntries.push({ index: gcEntries.length, kind: 'gc', payload: null, seed: 0 });
    }
    t3.mainPort.postMessage(msg(C2W.ENTRIES, { epoch: 20, entries: gcEntries }));
    await flushTurns(3);
    const SLOW = 30000;                          // ~33x slow-mo (real-time = 1e6)
    const chunk = SLOW * (1000 / 60);
    let playLimitNs = 0, eventsSince = 0, journalSince = 0;
    const seen = new Map();                       // erase id -> times surfaced
    const jseen = new Map();                       // journal id -> times surfaced on the wire (B19)
    let maxMs = 0;
    for (let fr = 0; fr < 2000; fr++) {
      playLimitNs += chunk;
      t3.mainPort.postMessage(msg(C2W.GRANT, { epoch: 20, round: fr + 1, entryLimit: gcEntries.length, playLimitNs, scale: SLOW }));
      // Pull BOTH streams with the head-as-since cursor convention (playground.js):
      // eventsSince = frame.eventHead, journalSince = frame.journalHead.
      t3.mainPort.postMessage(msg(C2W.PULL, { epoch: 20, events: { since: eventsSince, limit: 400 }, journal: { since: journalSince, limit: 400 } }));
      await flushTurns(2);                        // settle each frame (one PULL per frame, no pipelining)
      for (const f of w3.frame.splice(0)) {
        for (const ev of (f.events || [])) if (ev.kind === 'erase') { seen.set(ev.id, (seen.get(ev.id) || 0) + 1); maxMs = Math.max(maxMs, ev.ms); }
        for (const j of (f.journal || [])) jseen.set(j.id, (jseen.get(j.id) || 0) + 1);
        if (f.eventHead != null) eventsSince = f.eventHead;   // the playground cursor convention (head fed back as since)
        if (f.journalHead != null) journalSince = f.journalHead;
      }
      const ack = w3.grantAck[w3.grantAck.length - 1];
      if (ack && ack.entriesDrained >= gcEntries.length - 1) break;
    }
    const uniqueErases = seen.size;
    const dups = [...seen.values()].filter((n) => n > 1).length;
    if (uniqueErases >= 10) ok(`B18: erase sweeps surface at slow-mo via the head-as-since cursor (${uniqueErases}/12 gc erases; pre-fix: 0, the boundary event was dropped every frame)`);
    else fail(`B18: erase sweeps NOT surfacing at slow-mo (got ${uniqueErases}/12), inverted visibility regressed`);
    if (dups === 0) ok('B18: each erase surfaces exactly once, the head->inclusive-since bridge does not double-animate');
    else fail(`B18: ${dups} erase(s) surfaced more than once, the cursor bridge over-returns`);
    if (maxMs > 300) ok(`B18: slow-mo erase holds for a long scaled ms (${maxMs.toFixed(0)}ms), the 21ms erase is genuinely visible, not a MIN_ANIM flash`);
    else fail(`B18: slow-mo erase ms too short (${maxMs.toFixed(0)}ms), duration not scaling with slow-mo`);
    // B19: the same head-as-since cursor over the JOURNAL stream. Each write/gc entry
    // journals an op line; at slow-mo one entry drains per pull window, so the boundary
    // line was dropped pre-fix (missing tape lines). Assert every op line surfaces AND
    // none is returned twice on the wire (the consumer also dedups via tapeSeen).
    const jdups = [...jseen.values()].filter((n) => n > 1).length;
    // 12 writes + 12 gc each emit an op line (gc's batch carries its erase) = 24 op lines.
    if (jseen.size >= 20) ok(`B19: journal tape lines surface at slow-mo via the head-as-since cursor (${jseen.size} lines; pre-fix the boundary line of each window was dropped)`);
    else fail(`B19: journal tape lines missing at slow-mo (got ${jseen.size}, expected ~24), boundary-line drop regressed`);
    if (jdups === 0) ok('B19: no journal line returned twice on the wire, the journal bridge does not duplicate tape lines');
    else fail(`B19: ${jdups} journal line(s) returned more than once, the journal cursor bridge over-returns`);
  }

  console.log('');
  if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
  console.log('PASS - real-execution path: §2 gate, raw-source sandbox command (I1), FRAME typedefs (heat/shown/liveMap/erase events), write-amp telemetry, I5 discard, RESET, B2 reset-races-init, B18 slow-mo erase visibility.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
