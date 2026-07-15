/*
 * session-client.js against the faithful mock Worker-port transport
 * (mock-worker-transport.mjs, ADR-0024 §13): a hand-rolled fake worker-side
 * responder plays the W2C half of the protocol (grantAck/frame/telemetry) so
 * this test never needs the real worker host (session.js's worker-side
 * counterpart, owned by a different lane) — exactly the "you do not need the
 * real worker" latitude the lane brief grants.
 *
 * Asserts: INIT is sent on construction; PULL is a no-op while unfocused;
 * focusing sends PULL and the resulting FRAME reaches onFrame subscribers;
 * TELEMETRY arrives unconditionally regardless of focus; a message on a
 * stale epoch is discarded (I5); focus switch marks the next pull as a fresh
 * re-attach (`newest`).
 */
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
import { createSessionClient } from '../web/src/session-client.js';
import { C2W, W2C } from '../web/src/protocol.js';

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   -', m); } else { failed++; console.error('  FAIL -', m); } };

const geometry = { sectorSize: 4096, sectorCount: 64, pageSize: 256 };

// A minimal fake worker host: records every message it receives and can be
// told to reply. Mirrors just enough of the real worker's W2C surface.
function fakeWorkerHost(workerPort) {
  const received = [];
  let epoch = 0;
  workerPort.onmessage = (e) => {
    const m = e.data;
    received.push(m);
    if (m.type === C2W.INIT) epoch = m.epoch;
    if (m.type === C2W.PULL) {
      workerPort.postMessage({
        type: W2C.FRAME, epoch,
        heat: { read: [], prog: [] },
        shown: { pages: [], wear: [] },
        journal: [], events: [],
        journalHead: 0, eventHead: 0,
      });
    }
  };
  return {
    received,
    telemetry(extra = {}) { workerPort.postMessage({ type: W2C.TELEMETRY, epoch, fsinfo: { files: 0, bytes: 0 }, livenessCounts: { live: 0, obsolete: 0, metadata: 0 }, exec_fileOpCount: 0, exec_simNs: 0, ...extra }); },
  };
}

async function run() {
  const { mainPort, workerPort } = createTransport();
  const host = fakeWorkerHost(workerPort);
  const client = createSessionClient({ port: mainPort, fsId: 'fastffs', name: 'FASTFFS', geometry });

  await flushTurns(2);
  ok(host.received.length === 1 && host.received[0].type === C2W.INIT, 'INIT sent on construction');
  ok(host.received[0].fsId === 'fastffs' && host.received[0].name === 'FASTFFS', 'INIT carries fsId/name');

  // ---- unfocused: pull() is a no-op ----
  client.pull();
  await flushTurns(2);
  ok(host.received.length === 1, 'pull() sends nothing while unfocused (unfocused sessions stream nothing, §7)');
  ok(client.lastFrame === null, 'no FRAME arrives while never pulled');

  // ---- focus + pull: PULL goes out, FRAME comes back ----
  let framesSeen = 0;
  const unsubFrame = client.onFrame(() => { framesSeen++; });
  client.setFocused(true);
  ok(client.focused === true, 'setFocused(true) flips .focused');
  client.pull();
  await flushTurns(2);
  const pullMsg = host.received.find((m) => m.type === C2W.PULL);
  ok(!!pullMsg, 'focused pull() sent a PULL message');
  ok(pullMsg.journal.newest === true, 'the first pull after focusing re-attaches with journal.newest (snap repaint, §7)');
  ok(framesSeen === 1 && client.lastFrame && client.lastFrame.type === W2C.FRAME, 'the resulting FRAME reached the onFrame subscriber');
  unsubFrame();

  // second pull (still focused) is NOT a fresh re-attach
  client.pull();
  await flushTurns(2);
  const pulls = host.received.filter((m) => m.type === C2W.PULL);
  ok(pulls.length === 2 && pulls[1].journal.newest !== true, 'a subsequent pull while still focused is not a re-attach');

  // ---- TELEMETRY arrives unconditionally, focused or not ----
  let telSeen = 0;
  client.onTelemetry(() => { telSeen++; });
  client.setFocused(false);
  host.telemetry({ exec_fileOpCount: 7 });
  await flushTurns(2);
  ok(telSeen === 1 && client.lastTelemetry.exec_fileOpCount === 7, 'TELEMETRY reaches subscribers even while unfocused');

  // unfocused pull is a no-op again
  const before = host.received.length;
  client.pull();
  await flushTurns(2);
  ok(host.received.length === before, 'pull() is inert again once unfocused');

  // ---- refocusing marks the NEXT pull as a fresh re-attach ----
  client.setFocused(true);
  client.pull();
  await flushTurns(2);
  const lastPull = host.received.filter((m) => m.type === C2W.PULL).at(-1);
  ok(lastPull.journal.newest === true, 're-focusing re-attaches (newest) on the next pull');

  // ---- stale epoch is discarded (I5) ----
  const preFrame = client.lastFrame;
  workerPort.postMessage({ type: W2C.FRAME, epoch: 999, heat: { read: [], prog: [] }, shown: { pages: [], wear: [] }, journal: [], events: [] });
  await flushTurns(2);
  ok(client.lastFrame === preFrame, 'a FRAME on a stale/foreign epoch is discarded (I5)');

  // ---- dispose detaches ----
  client.dispose();
  const beforeDispose = host.received.length;
  client.pull();
  await flushTurns(2);
  ok(host.received.length === beforeDispose, 'dispose() stops issuing pulls');

  if (failed) { console.error(`\nFAIL - ${failed} check(s) failed.`); process.exit(1); }
  console.log(`\nPASS - session-client.js consumes PULL/FRAME/TELEMETRY per ADR-0024 §4/§7 (${pass} checks).`);
}

run();
