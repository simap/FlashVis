/*
 * SPIKE — worst single-op main-thread stall. The frame-jank concern isn't the
 * average op, it's the one gcStep that triggers a full compaction (a synchronous
 * WASM burst of tens of thousands of device callbacks). This finds, per FS, the
 * single most expensive sequence step by wall time, plus the p99. That's the
 * blocking interval a worker split would move OFF the main thread.
 */
import { installFakeDom } from '../fake-dom.mjs';
import { createChurnModel, CHURN_EVENT } from '../../web/src/churn.js';
import { createSession } from '../../web/src/session.js';

const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const CHURN_CFG = {
  seed: 0x00c0ffee, targetLiveBytes: 96 * 1024, targetWrittenBytes: 0xffffffff,
  targetSlackBytes: 16 * 1024, forceLargeAfterBytes: 0xffffffff,
  profile: { namePrefix: 'w', replacePercent: 25, protectFirstLarge: false, classes: [
    { key: 'small', name: 'small', weight: 800, minSize: 2 * 1024, maxSize: 6 * 1024 },
    { key: 'medium', name: 'medium', weight: 150, minSize: 8 * 1024, maxSize: 20 * 1024 },
    { key: 'large', name: 'large', weight: 50, minSize: 40 * 1024, maxSize: 40 * 1024 },
  ] }, slotCount: 256,
};
function mulberry32(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function genSequence(n, gcRatio = 0.5) {
  const churn = createChurnModel(CHURN_CFG); const rnd = mulberry32(0x5eed0001); const seq = [];
  for (let i = 0; i < n; i++) {
    if (rnd() < gcRatio) { seq.push({ kind: 'gc' }); continue; }
    const ev = churn.next();
    if (ev.type === CHURN_EVENT.WRITE || ev.type === CHURN_EVENT.DELETE) churn.apply(ev);
    seq.push({ kind: 'event', ev });
  }
  return seq;
}
const now = () => Number(process.hrtime.bigint()) / 1e6;
const fmt = (n, d = 2) => Number(n).toFixed(d);

const STEPS = 20000;
const seq = genSequence(STEPS, 0.5);

for (const fsId of ['fastffs', 'littlefs', 'spiffs']) {
  installFakeDom();
  const s = await createSession(fsId, { geometry: GEOMETRY, container: document.createElement('div'), name: fsId });
  s.freshFormat();
  let evCount = 0;
  s.device.onEvent(() => { evCount++; });
  const times = [];
  for (const entry of seq) {
    const before = evCount;
    const a = now();
    try { if (entry.kind === 'gc') s.runGcStep(); else s.runChurnEvent(entry.ev); } catch {}
    times.push({ ms: now() - a, ev: evCount - before, kind: entry.kind });
  }
  times.sort((x, y) => y.ms - x.ms);
  const p = (q) => times[Math.floor(times.length * q)].ms;
  const worst = times[0];
  const over16 = times.filter((t) => t.ms > 16.7).length;
  const over8 = times.filter((t) => t.ms > 8).length;
  console.log(`${fsId.padEnd(9)}  worst op ${fmt(worst.ms)}ms (${worst.ev} events, kind=${worst.kind})  |  p999 ${fmt(p(0.001))}ms  p99 ${fmt(p(0.01))}ms  p50 ${fmt(p(0.5), 3)}ms  |  ops >16.7ms: ${over16}  >8ms: ${over8}`);
}
console.log('');
