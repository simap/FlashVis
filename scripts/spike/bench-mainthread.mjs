/*
 * SPIKE (lane/spike-workers) — throwaway benchmark for the "move sessions to
 * Web Workers" feasibility question. NOT shipped, NOT wired into npm test.
 *
 * Question 1: is N=5 concurrent sessions main-thread CPU bound, and where does
 * the time go? We drive real sessions (real WASM + real JS device) through the
 * SAME canonical churn/gc sequence the coordinator would, flat-out (the Race
 * no-delay synchronous burst path: raceTick -> advanceSync -> runChurnEvent/
 * runGcStep), and time three cost centres separately:
 *   1. WASM execution + JS device (runChurnEvent / runGcStep)
 *   2. liveness reachability walk (session.livenessCounts(), the compare-strip poll)
 *   3. event marshalling (structuredClone of a heavy op's device-event batch —
 *      the proxy for worker->main postMessage of the animation stream)
 *
 * Then a 2-session vs 5-session wall-time comparison (same per-session work).
 *
 * Node has NO render loop, so this measures execution + device + liveness only,
 * NOT heat-field render (ADR-0022, O(active cells)/frame) or DOM. Stated in the
 * report. Run: node scripts/spike/bench-mainthread.mjs
 */
import { installFakeDom } from '../fake-dom.mjs';
import { createChurnModel, CHURN_EVENT } from '../../web/src/churn.js';
import { createSession } from '../../web/src/session.js';

const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const CHURN_CFG = {
  seed: 0x00c0ffee,
  targetLiveBytes: 96 * 1024,
  targetWrittenBytes: 0xffffffff,
  targetSlackBytes: 16 * 1024,
  forceLargeAfterBytes: 0xffffffff,
  profile: {
    namePrefix: 'w', replacePercent: 25, protectFirstLarge: false,
    classes: [
      { key: 'small',  name: 'small',  weight: 800, minSize: 2 * 1024,  maxSize: 6 * 1024 },
      { key: 'medium', name: 'medium', weight: 150, minSize: 8 * 1024,  maxSize: 20 * 1024 },
      { key: 'large',  name: 'large',  weight: 50,  minSize: 40 * 1024, maxSize: 40 * 1024 },
    ],
  },
  slotCount: 256,
};

// mulberry32 gc/event coin — same idiom lockstep.js genStep() uses.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Generate ONE canonical sequence (the coordinator's genStep, extracted) so
// every session replays the identical churn/gc stream.
function genSequence(n, gcRatio = 0.5) {
  const churn = createChurnModel(CHURN_CFG);
  const rnd = mulberry32(0x5eed0001);
  const seq = [];
  for (let i = 0; i < n; i++) {
    if (rnd() < gcRatio) { seq.push({ kind: 'gc' }); continue; }
    const ev = churn.next();
    if (ev.type === CHURN_EVENT.WRITE || ev.type === CHURN_EVENT.DELETE) churn.apply(ev);
    seq.push({ kind: 'event', ev });
  }
  return seq;
}

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms

async function makeSessions(fsIds) {
  const dom = installFakeDom();
  const sessions = [];
  for (const fsId of fsIds) {
    const s = await createSession(fsId, { geometry: GEOMETRY, container: document.createElement('div'), name: fsId });
    s.freshFormat();
    sessions.push(s);
  }
  return { dom, sessions };
}

// Replay `seq` on one session, timing execution and (at a realistic cadence)
// the liveness walk separately. `livenessEvery` = how many steps between
// compare-strip polls (0 = never poll).
function replay(session, seq, livenessEvery) {
  let tExec = 0, tLive = 0, liveCalls = 0, ops = 0;
  const t0 = now();
  for (let i = 0; i < seq.length; i++) {
    const a = now();
    const entry = seq[i];
    try {
      if (entry.kind === 'gc') session.runGcStep();
      else session.runChurnEvent(entry.ev);
    } catch { /* logged by session timed() */ }
    tExec += now() - a;
    ops++;
    if (livenessEvery && i % livenessEvery === 0) {
      const b = now();
      session.livenessCounts();
      tLive += now() - b;
      liveCalls++;
    }
  }
  const wall = now() - t0;
  return { wall, tExec, tLive, liveCalls, ops };
}

// Single liveness-walk cost: dirty the map with one write, then time one walk.
function oneWalkCost(session) {
  // force a flash change so ensureLiveness actually walks
  try { session.runChurnEvent({ type: CHURN_EVENT.WRITE, name: 'probe-walk.bin', size: 4096, writeSeed: 12345 }); } catch {}
  const a = now();
  const c = session.livenessCounts();
  const dt = now() - a;
  return { dt, counts: c };
}

// Marshal cost: capture the device-event batch of the single heaviest op in a
// replay, then time structuredClone of it (the postMessage proxy). We hook the
// device's event stream to record batches per op.
function measureMarshal(session, seq) {
  let biggest = [];
  let cur = null;
  const off = session.device.onEvent((ev) => { if (cur && ev.op !== 'reset') cur.push(ev); });
  for (const entry of seq) {
    cur = [];
    try {
      if (entry.kind === 'gc') session.runGcStep();
      else session.runChurnEvent(entry.ev);
    } catch {}
    if (cur.length > biggest.length) biggest = cur;
  }
  off();
  // Plain-object copy (events already are plain {op,off,len,ns}); clone many
  // times to get a stable per-event marshalling number.
  const REPS = 200;
  const a = now();
  let sink = 0;
  for (let r = 0; r < REPS; r++) { const c = structuredClone(biggest); sink += c.length; }
  const dt = (now() - a) / REPS;
  return { biggestLen: biggest.length, cloneMs: dt, perEventUs: biggest.length ? (dt * 1000) / biggest.length : 0, sink };
}

function fmt(n, d = 2) { return Number(n).toFixed(d); }

async function main() {
  const STEPS = 20000;
  const seq = genSequence(STEPS, 0.5);
  const nWrite = seq.filter((e) => e.kind === 'event' && e.ev.type === CHURN_EVENT.WRITE).length;
  const nDel = seq.filter((e) => e.kind === 'event' && e.ev.type === CHURN_EVENT.DELETE).length;
  const nGc = seq.filter((e) => e.kind === 'gc').length;
  console.log(`\n=== flashvis worker-spike main-thread benchmark ===`);
  console.log(`sequence: ${STEPS} steps  (${nWrite} write, ${nDel} delete, ${nGc} gc)\n`);

  // ---- Per-FS single-session cost (execution + liveness) ----
  console.log('--- per-FS single-session cost (flat-out synchronous replay) ---');
  const perFs = {};
  for (const fsId of ['fastffs', 'littlefs', 'spiffs']) {
    const { sessions } = await makeSessions([fsId]);
    const s = sessions[0];
    // warm up caches / JIT with a short run on a clone sequence
    replay(s, seq.slice(0, 2000), 0);
    const { sessions: s2 } = await makeSessions([fsId]);
    const r = replay(s2[0], seq, 50);   // poll liveness every 50 steps (~strip cadence)
    const walk = oneWalkCost((await makeSessions([fsId])).sessions[0]);
    const marsh = measureMarshal((await makeSessions([fsId])).sessions[0], seq);
    perFs[fsId] = { r, walk, marsh };
    console.log(`${fsId.padEnd(9)}  exec ${fmt(r.tExec)}ms (${fmt(r.tExec / r.ops * 1000, 1)} µs/op, ${fmt(r.ops / r.tExec * 1000, 0)} ops/s)  |  liveness ${fmt(r.tLive)}ms over ${r.liveCalls} walks (${fmt(r.tLive / Math.max(1, r.liveCalls), 3)} ms/walk)  |  1-walk ${fmt(walk.dt, 3)}ms  |  wall ${fmt(r.wall)}ms`);
    console.log(`${''.padEnd(9)}  heaviest op = ${marsh.biggestLen} events; structuredClone ${fmt(marsh.cloneMs, 4)}ms (${fmt(marsh.perEventUs, 3)} µs/event)`);
  }

  // ---- 2-session vs 5-session wall time (same per-session work, sequential) ----
  // Single-threaded: this is what today's main thread does per macrotask if all
  // sessions burst in one tick. N=2 = [fastffs, littlefs]; N=5 = 2x each + spiffs.
  console.log('\n--- N-session aggregate wall time (all sessions, same sequence each) ---');
  for (const set of [['fastffs', 'littlefs'], ['fastffs', 'fastffs', 'littlefs', 'littlefs', 'spiffs']]) {
    const { sessions } = await makeSessions(set);
    const a = now();
    let totExec = 0, totLive = 0;
    for (const s of sessions) {
      const r = replay(s, seq, 50);
      totExec += r.tExec; totLive += r.tLive;
    }
    const wall = now() - a;
    console.log(`N=${sessions.length} [${set.join(',')}]  total wall ${fmt(wall)}ms  (exec ${fmt(totExec)}ms + liveness ${fmt(totLive)}ms)  =>  ${fmt(wall / STEPS / sessions.length * 1000, 2)} µs per (session·step)`);
  }

  // ---- Per-frame budget framing: how many steps fit in one 16.7ms frame? ----
  console.log('\n--- frame-budget framing (16.7ms/frame @ 60fps) ---');
  for (const fsId of ['fastffs', 'littlefs', 'spiffs']) {
    const usPerOp = perFs[fsId].r.tExec / perFs[fsId].r.ops * 1000;
    console.log(`${fsId.padEnd(9)}  ~${fmt(16700 / usPerOp, 0)} exec-ops fit in one frame (single session)`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
