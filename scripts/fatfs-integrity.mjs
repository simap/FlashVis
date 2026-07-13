/*
 * Backend fidelity guard: run a heavy churn workload against the real FatFs /
 * wear_levelling stack over the emulated NOR device and assert every file reads
 * back byte-exact — through file replacement, deletion, and WL dummy-sector
 * rotation. Sibling to littlefs-integrity.mjs, driven through the same
 * FS-agnostic runner (ADR-0011) with fsId 'fatfs'. If FatFs's or WL's use of
 * our NOR emulation (device.js AND-only program, sector erase) ever drifts from
 * the reference, this catches it.
 *
 * File sizes reach ~8 KiB and the working set ~110 KiB — the brief's steady
 * state (files 2-32 KiB, ~96-112 KiB live) — well under the ~224 KiB the FAT12
 * volume exposes on the 240 KiB WL region, so writes never hit ENOSPC (FatFs is
 * not copy-on-write: a failed mid-write would leave a truncated file, unlike
 * littlefs, so the test deliberately stays within capacity).
 */
import { createRunner } from '../web/src/runner.js';

const runner = await createRunner({ sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 }, 'fatfs');
runner.format(); runner.mount();

const NAMES = Array.from({ length: 14 }, (_, i) => `file${i}.dat`);
const rnd = (n) => Math.floor(Math.random() * n);
const rbytes = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = rnd(256); return a; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const truth = new Map();
let checks = 0, mismatches = 0;
function verify(name) {
  checks++;
  if (!eq(runner.read(name), truth.get(name))) {
    mismatches++;
    if (mismatches <= 5) console.log(`  MISMATCH ${name}`);
  }
}

for (let op = 0; op < 3000; op++) {
  const r = Math.random();
  try {
    if (r < 0.6) { const n = NAMES[rnd(NAMES.length)], d = rbytes(200 + rnd(7800)); runner.write(n, d); truth.set(n, d); }
    else if (r < 0.78) runner.gcStep();  // no-op for fatfs (no FF_CAP_GC); must not corrupt
    else if (r < 0.9 && truth.size) { const n = [...truth.keys()][rnd(truth.size)]; runner.remove(n); truth.delete(n); }
    else if (truth.size) verify([...truth.keys()][rnd(truth.size)]);
  } catch { /* keep last committed version; truth unchanged */ }
}
for (const name of truth.keys()) verify(name);

// Live-map sanity after heavy churn: classes stay in the driver's taxonomy
// (0-3 baseline + 4 WL + 5 slack), class 4 covers exactly the 3 FTL-written
// sectors (cfg + state x2 — the rotating dummy is NOT class 4, spec/ui.md),
// and the FAT resolution shows sub-sector structure: any surviving
// file whose size isn't a 4096-multiple must put live pages and EOF-slack
// pages in the same sector (its last cluster).
const lm = runner.liveMap();
const pps = 4096 / 256;
const wlPages = [...lm].filter((v) => v === 4).length;
const mixed = Array.from({ length: 64 }, (_, s) => [...lm.slice(s * pps, (s + 1) * pps)])
  .some((cls) => cls.includes(3) && cls.includes(5));
const expectMixed = [...truth.values()].some((d) => d.length % 4096 !== 0);
if (!(lm.length === 1024 && [...lm].every((v) => v >= 0 && v <= 5) && wlPages === 48
      && (mixed || !expectMixed))) {
  console.log(`FAIL — live-map sanity after churn: len ${lm.length}, wlPages ${wlPages}, mixed ${mixed}, expectMixed ${expectMixed}`);
  process.exit(1);
}

const live = [...truth.values()].reduce((s, d) => s + d.length, 0);
const s = runner.device.stats;
console.log(`ops 3000 | files ${truth.size} | live ${(live / 1024).toFixed(1)} KiB | read-backs ${checks} | ${s.programs} programs, ${s.erases} erases`);
console.log(mismatches === 0
  ? `PASS — every read-back byte-exact through churn + WL rotation; NOR backend is faithful.`
  : `FAIL — ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
