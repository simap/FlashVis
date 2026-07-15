/*
 * worker-harness.mjs — rig helpers for the ADR-0024 worker-per-session
 * conversion of scripts/lockstep-concurrency-test.mjs.
 *
 * SEAM (see LANE-REPORT.md): this suite drives sessions purely over the wire
 * (web/src/protocol.js) through a mock Worker-port pair
 * (scripts/mock-worker-transport.mjs). Two env vars carry forward the
 * FV_LOCKSTEP/FV_SESSION mutation-seam pattern from the old suite:
 *
 *   FV_WORKER_HOST  module exporting `attachWorkerHost(workerPort)` — wires
 *                   the worker side of one session. Defaults to
 *                   scripts/ref-worker-host.mjs (a REFERENCE host wrapping the
 *                   real session.js; lane/worker's production host is not in
 *                   this worktree yet — swap it in here once it lands).
 *
 * There is deliberately NO "FV_COORDINATOR" seam: the control-plane logic this
 * harness drives (grant/round barrier I2, derived-watermark I4, epoch discard
 * I5, grant continuity I10) is exactly what protocol.js's §2 algebra
 * specifies, so the test plays the coordinator role directly against the wire
 * rather than guess lane/coord's future JS method surface (setMode/broadcast/
 * snapshots/... are coordinator-internal API, not part of the frozen wire
 * contract). Scenarios that need lane/coord's actual Pace/Race mode
 * implementation (holding/stalled/waiting, opsPerSec, Pace<->Race reseat) are
 * NOT converted here for exactly this reason — see LANE-REPORT.md.
 */
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
import { C2W, W2C, msg } from '../web/src/protocol.js';

const workerHostModule = process.env.FV_WORKER_HOST || './ref-worker-host.mjs';
const { attachWorkerHost } = await import(workerHostModule);

export const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
export const FS_ORDER = ['fastffs', 'littlefs'];

/**
 * One session's coordinator-side handle: owns the mainPort, tracks the latest
 * standing (grantAck fields) and the latest pulled frame.
 */
function makeSessionHandle(fsId) {
  const { mainPort, workerPort } = createTransport();
  attachWorkerHost(workerPort);
  const standing = { epoch: -1, round: -1, playbackNs: 0, cursor: 0, entriesDrained: 0, drainedCounters: null };
  let lastFrame = null;
  const acks = []; // every GRANT_ACK received, in order — the in-band per-round log
  mainPort.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === W2C.GRANT_ACK) {
      acks.push(m);
      // coordinator keeps max per round (protocol.js W2C.GRANT_ACK doc)
      if (m.round >= standing.round) Object.assign(standing, m);
    } else if (m.type === W2C.FRAME) {
      lastFrame = m;
    }
  };
  return {
    fsId, mainPort, standing, acks,
    getFrame: () => lastFrame,
    send: (type, payload) => mainPort.postMessage(msg(type, payload)),
  };
}

/**
 * Build a rig: N session handles (fastffs, littlefs by default), each INIT'd
 * at epoch 0. Returns helpers to drive grant rounds and pull.
 */
export async function makeRig({ fsIds = FS_ORDER, name } = {}) {
  const sessions = fsIds.map((fsId) => makeSessionHandle(fsId));
  let epoch = 0;
  for (const s of sessions) s.send(C2W.INIT, { epoch, fsId: s.fsId, geometry: GEOMETRY, name: name || s.fsId });
  await flushTurns(2);

  const byId = Object.fromEntries(sessions.map((s) => [s.fsId, s]));

  function broadcastEntries(entries) {
    for (const s of sessions) s.send(C2W.ENTRIES, { epoch, entries });
  }

  let round = 0;
  /** Send one GRANT round to every session and wait for every session's ack
   *  of THIS round (the I2 barrier from the test's side). */
  async function grantRound({ entryLimit, playLimitNs, scale = 1 }, { maxTurns = 50 } = {}) {
    const r = round++;
    for (const s of sessions) s.send(C2W.GRANT, { epoch, round: r, entryLimit, playLimitNs, scale });
    for (let i = 0; i < maxTurns; i++) {
      await flushTurns(1);
      if (sessions.every((s) => s.standing.round >= r)) return r;
    }
    throw new Error(`grantRound: not all sessions acked round ${r} within ${maxTurns} turns`);
  }

  async function pull(fsId, opts) {
    byId[fsId].send(C2W.PULL, { epoch, ...opts });
    await flushTurns(2);
    return byId[fsId].getFrame();
  }

  async function reset() {
    epoch += 1;
    for (const s of sessions) s.send(C2W.RESET, { epoch });
    await flushTurns(2);
  }

  /** §8 teardown: drop a session from the barrier-wait set (setSessions-style
   *  removal) WITHOUT closing its port yet — a late/straggler ack from it must
   *  not corrupt survivor bookkeeping or wedge grantRound's barrier. */
  function dropSession(fsId) {
    const i = sessions.findIndex((s) => s.fsId === fsId);
    if (i >= 0) sessions.splice(i, 1);
  }
  /** §8 teardown: close a (already-dropped) session's port — models
   *  `worker.terminate()` post-settle. No further messages are delivered
   *  either direction after this. */
  function terminateSession(fsId) {
    byId[fsId].mainPort.close();
  }

  return { sessions, byId, broadcastEntries, grantRound, pull, reset, dropSession, terminateSession, getEpoch: () => epoch };
}

/** Grant repeatedly (large entryLimit/playLimitNs) until every session's
 *  entriesDrained reaches `n`, or throw after `maxRounds`. */
export async function drainTo(rig, n, { entryLimit = 1e9, playLimitNs = 1e15, maxRounds = 200 } = {}) {
  for (let i = 0; i < maxRounds; i++) {
    await rig.grantRound({ entryLimit, playLimitNs });
    if (rig.sessions.every((s) => s.standing.entriesDrained >= n)) return;
  }
  throw new Error(`drainTo(${n}): sessions never reached entriesDrained>=${n} within ${maxRounds} rounds (standings: ${JSON.stringify(rig.sessions.map((s) => s.standing.entriesDrained))})`);
}

export { flushTurns };
