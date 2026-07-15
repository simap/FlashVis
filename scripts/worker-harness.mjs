/*
 * worker-harness.mjs: rig for the ADR-0024 concurrency suite's REAL-PATH cut.
 *
 * Composes the whole production stack end to end over the faithful mock
 * transport (scripts/mock-worker-transport.mjs: structuredClone + async
 * queued delivery):
 *
 *   createChurnModel  →  createLockstep (real coordinator, §2 algebra)
 *                          │  N × createSessionProxy (real wire endpoints)
 *                          │        │  mock transport pair (mainPort/workerPort)
 *                          │        │        │  installWorkerHost (REAL worker host)
 *                          │        │        │        │  createRunner → REAL WASM
 *
 * So a coord.broadcast()/setMode()/start()/step()/reset() drives real
 * filesystems on real emulated flash, reached only through the frozen
 * protocol.js wire. This is the §13 acceptance path: the converted concurrency
 * scenarios green against the REAL production worker backend, not a stub.
 *
 * Two mutation/integration seams carry forward the FV_LOCKSTEP/FV_SESSION
 * pattern from the pre-0024 suite:
 *
 *   FV_COORDINATOR  module exporting createLockstep, the real coordinator
 *                   (web/src/lockstep.js) by default; point at a scratch copy
 *                   with one guard reintroduced-as-a-bug to prove a scenario
 *                   fails under its target defect.
 *   FV_WORKER_HOST  module exporting installWorkerHost (alias createWorkerHost /
 *                   attachWorkerHost also accepted), the real production host
 *                   (web/src/session-worker.js) by default; same mutation role
 *                   for worker-side guards.
 *
 * (The old ref-worker-host.mjs, which wrapped the retained main-thread
 * session.js, is retired now that the real standalone worker host is here,
 * see LANE-REPORT.md.)
 */
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
import { createSessionProxy } from './../web/src/session-proxy.js';
import { createChurnModel, CHURN_CLASS } from './../web/src/churn.js';

const coordModule = process.env.FV_COORDINATOR || './../web/src/lockstep.js';
const { createLockstep } = await import(coordModule);
const workerHostModule = process.env.FV_WORKER_HOST || './../web/src/session-worker.js';
const hostMod = await import(workerHostModule);
const installHost = hostMod.installWorkerHost || hostMod.createWorkerHost || hostMod.attachWorkerHost;
if (typeof installHost !== 'function') throw new Error(`FV_WORKER_HOST module ${workerHostModule} exports no installWorkerHost/createWorkerHost/attachWorkerHost`);

export const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
// Mirrors web/src/playground.js's boot config EXACTLY (scaled to the 256 KiB
// device), including the `profile` (class weights: large weight 0 ⇒ writes cap
// at the 20 KB medium class, so a single churn write never exceeds the chip) and
// `slotCount`. Omitting the profile falls back to churn.js's default, which emits
// 350 KB writes that a fresh 256 KB chip rejects with -4 (a real worker throws
// synchronously in pump on that, see LANE-REPORT). The faithful config is the
// point: the auto-workload the suite drives must behave as shipped.
export const CHURN_CFG = {
  seed: 0x00c0ffee,
  targetLiveBytes: 96 * 1024,
  targetWrittenBytes: 0xffffffff,
  targetSlackBytes: 16 * 1024,
  forceLargeAfterBytes: 0xffffffff,
  slotCount: 256,
  profile: {
    namePrefix: 'w',
    replacePercent: 25,
    protectFirstLarge: false,
    classes: [
      { key: CHURN_CLASS.SMALL,  name: 'small',  weight: 800, minSize: 2 * 1024,  maxSize: 6 * 1024 },
      { key: CHURN_CLASS.MEDIUM, name: 'medium', weight: 150, minSize: 8 * 1024,  maxSize: 20 * 1024 },
      { key: CHURN_CLASS.LARGE,  name: 'large',  weight: 0,   minSize: 40 * 1024, maxSize: 40 * 1024 },
    ],
  },
};
export const FS_ORDER = ['fastffs', 'littlefs'];

/**
 * Build a real-path rig: real coordinator, real proxies, real worker hosts
 * (real WASM), all over the mock transport. autoTick is off, drive frames
 * manually via frame()/run() so delivery is deterministic.
 *
 * ASYNC because a REAL worker host's INIT builds its runner ASYNCHRONOUSLY (a
 * WASM module load). setSessions() sends INIT; we must let that runner-build
 * LAND before coord.reset() sends the RESET, otherwise RESET's gen-bump starves
 * the in-flight INIT build (its `myGen !== gen` guard) and the worker is left
 * runner-less: real commands then park forever. The mock-worker suites don't
 * hit this (synchronous stub/mock workers); the real backend does. Once INIT
 * has landed, reset() reuses the built runner via device.reset() (no reload).
 */
export async function makeRig({ speed = Infinity, gcRatio = 0.5 } = {}) {
  const churn = createChurnModel(CHURN_CFG);
  const coord = createLockstep({ churn, gcRatio, autoTick: false });
  const hosts = {};
  const proxies = [];
  for (const fsId of FS_ORDER) {
    const { mainPort, workerPort } = createTransport();
    hosts[fsId] = installHost(workerPort, {});          // REAL worker host on the worker side
    proxies.push(createSessionProxy(mainPort, { fsId, name: fsId, geometry: GEOMETRY }));
  }
  coord.setSessions(proxies);                           // sends INIT (async runner build)
  await flushTurns(8);                                  // let every worker's runner build land
  coord.reset();                                        // now safe, reuses the built runner
  coord.setSpeed(speed);
  await flushTurns(4);                                  // let the RESET rebuild land
  const byId = Object.fromEntries(proxies.map((p) => [p.fsId, p]));
  const rig = { coord, proxies, hosts, byId, churn };
  await bootFormat(rig);                                // the ADR-0024 boot flow: format ships as a broadcast command
  return rig;
}

/**
 * The ADR-0024 boot / header-Reset flow (spec/ui.md, coord-wire testBootResetFlow):
 * a fresh worker chip is BLANK (INIT/RESET build+reset the device but never
 * format+mount). The ONE real format ships as a broadcast COMMAND after reset,
 * there is no `format` wire field. Every real-WASM scenario needs a mounted chip,
 * so makeRig() runs this once, and any scenario that calls coord.reset() itself
 * must call bootFormat(rig) again before issuing real workload. Consumes sequence
 * index 0 (the format command); real workload starts at index 1.
 */
export async function bootFormat(rig) {
  const { index } = rig.coord.broadcast('await format()', 'format()');
  const savedMode = rig.coord.mode;
  rig.coord.setMode('pace');
  await pumpUntil(rig, () => allDrainedTo(rig, index), 'bootFormat');
  rig.coord.setMode(savedMode);
  return index;
}

// One coordinator frame + enough macrotask turns for grant->worker delivery,
// worker execution (a real async command settles over several macrotasks via
// the quiescence re-check, ADR-0019), and ack->proxy delivery. 4 turns is a
// safe steady-state budget; pumpUntil below adds frames until a condition holds
// for anything that spans more.
export async function frame(rig, turns = 4) {
  rig.coord._tick();
  await flushTurns(turns);
}
export async function run(rig, n, sampleEach) {
  for (let i = 0; i < n; i++) { await frame(rig); if (sampleEach) sampleEach(i); }
}

/** Tick frames until pred() holds (or throw at the bound: a hang is a failure,
 *  never an infinite wait). */
export async function pumpUntil(rig, pred, label, maxFrames = 400) {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return i;
    await frame(rig);
  }
  if (pred()) return maxFrames;
  throw new Error(`pumpUntil(${label}) exceeded ${maxFrames} frames, coordinator never converged (frozen FS / broken lock?)`);
}

export const snapById = (rig) => Object.fromEntries(rig.coord.snapshots().map((s) => [s.fsId, s]));
export const cursorsEqualAt = (rig, n) => rig.proxies.every((p) => p.acked.cursor === n);
export const allDrainedTo = (rig, idx) => rig.proxies.every((p) => p.acked.entriesDrained >= idx);

/** Pull a session worker's journal over the wire (§7) and return its lines.
 *  The ONLY channel data leaves a session by, used for dispatch counting and
 *  journal-print byte-identity (no byte side-channel exists). */
export async function pullJournal(rig, fsId, { limit = 2000 } = {}) {
  rig.byId[fsId].pull({ journal: { since: -1, limit } });
  await flushTurns(3);
  const f = rig.byId[fsId].frame;
  return f && f.journal ? f.journal : [];
}

export { flushTurns };
