/*
 * Backend fidelity guard: run a heavy churn workload against real JesFS over the
 * emulated NOR device and assert every file reads back byte-exact — through
 * delete/rewrite churn and JesFS's just-in-time sector reclamation. Sibling to
 * littlefs-integrity.mjs, driven through the same FS-agnostic runner (ADR-0011)
 * with fsId 'jesfs'; if JesFS's mapping of our NOR emulation (device.js AND-only
 * program, 4K sector erase) ever drifts from the reference, this catches it.
 *
 * JesFS advertises no FF_CAP_GC (ADR-0021), so runner.gcStep() is a no-op here;
 * reclamation happens inline in fs_open/fs_write when the allocator reuses a
 * 'todelete' sector, which is exactly what the write/delete churn exercises.
 */
import { createRunner } from '../web/src/runner.js';

const runner = await createRunner({ sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 }, 'jesfs');
runner.format(); runner.mount();

// JesFS filenames are capped at FNAMELEN (21). Keep names short.
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
    if (r < 0.6) { const n = NAMES[rnd(NAMES.length)], d = rbytes(80 + rnd(3000)); runner.write(n, d); truth.set(n, d); }
    else if (r < 0.78) runner.gcStep();
    else if (r < 0.9 && truth.size) { const n = [...truth.keys()][rnd(truth.size)]; runner.remove(n); truth.delete(n); }
    else if (truth.size) verify([...truth.keys()][rnd(truth.size)]);
  } catch { /* NO_SPACE etc. — JesFS keeps the last committed version; truth unchanged */ }
}
for (const name of truth.keys()) verify(name);

const s = runner.device.stats;
console.log(`ops 3000 | files ${truth.size} | read-backs ${checks} | ${s.programs} programs, ${s.erases} erases`);
console.log(mismatches === 0
  ? `PASS — every read-back byte-exact through churn + reclamation; NOR backend is faithful.`
  : `FAIL — ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
