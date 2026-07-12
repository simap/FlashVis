/*
 * ADR-0023 guard: the file-granular op count (session.fileOpCount) measures
 * HIGH-LEVEL file operations, decoupled from the coordinator's sequence cursor,
 * and GC is background time — never a file op.
 *
 * Runs a REAL FASTFFS session (real WASM over the emulated NOR device) under the
 * fake DOM, driving the friendly API through session.runCommand() exactly as the
 * console/coordinator does. Asserts the ADR's observability contract at the unit
 * level:
 *   (a) one writeFile raises fileOpCount by exactly 1;
 *   (b) a loop of K file ops inside ONE command raises it by K — the console-loop
 *       case (`for (i=0;i<K;i++) …`) the ADR calls out. This is what makes the
 *       test NON-VACUOUS: the whole loop is ONE atomic command, so if the metric
 *       were still the sequence cursor it would rise by 1, not K;
 *   (c) N gc() calls (both the console gc() and the churn runGcStep() paths) leave
 *       fileOpCount UNCHANGED while device flash time (device.stats.simNs) climbs
 *       on an FS with real GC (FASTFFS) — ops flat, time up.
 * Also spot-checks that the counted set is exactly the file rung: fs-level handle
 * ops (open/read/close) do NOT count.
 */
import { installFakeDom } from './fake-dom.mjs';

const dom = installFakeDom();
const geometry = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };

const { createSession } = await import('../web/src/session.js');
const session = await createSession('fastffs', { geometry, container: dom.getEl('dieStack'), name: 'FASTFFS' });

const results = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
function check(name, fn) {
  return fn().then(
    () => { results.push({ name, ok: true }); console.log(`  ok   - ${name}`); },
    (e) => { results.push({ name, ok: false, err: e }); console.log(`  FAIL - ${name}: ${e.message}`); },
  );
}
// Run one atomic command (async (api) => …) to quiescence, like the coordinator.
const run = (fn) => session.runCommand(fn, 1, null);
const simNs = () => session.device.stats.simNs;

// Fresh chip: freshFormat() zeroes fileOpCount (a fresh chip has done no ops).
session.freshFormat();
assert(session.fileOpCount === 0, `fresh chip should have fileOpCount 0, got ${session.fileOpCount}`);

// (a) one writeFile → +1.
await check('one writeFile raises fileOpCount by exactly 1', async () => {
  const before = session.fileOpCount;
  await run(async (api) => { await api.writeFile('a.bin', 2048); });
  assert(session.fileOpCount === before + 1, `expected +1, got +${session.fileOpCount - before}`);
});

// (b) a K-iteration loop inside ONE command → +K (non-vacuous: one command,
// so a cursor-based metric would rise by 1).
const K = 12;
await check(`a loop of K=${K} file ops in ONE command raises fileOpCount by K (not 1)`, async () => {
  const before = session.fileOpCount;
  await run(async (api) => { for (let i = 0; i < K; i++) await api.writeFile('loop' + i + '.bin', 1024); });
  const delta = session.fileOpCount - before;
  assert(delta === K, `expected +${K} (per file op), got +${delta} — a cursor-based count would be +1`);
});

// mixed file ops in one command each count once: readFile + ls + stat + delete = 4.
await check('mixed file ops (read+ls+stat+delete) count once each', async () => {
  const before = session.fileOpCount;
  await run(async (api) => {
    await api.readFile('a.bin');
    await api.ls();
    await api.stat('a.bin');
    await api.deleteFile('a.bin');
  });
  const delta = session.fileOpCount - before;
  assert(delta === 4, `expected +4 (one per file op), got +${delta}`);
});

// fs-level handle ops are the fs rung, NOT counted: a whole open→read→close
// touches the device but does not move the FILE-op count.
await check('fs-level handle ops (open/read/close) do NOT count', async () => {
  await run(async (api) => { await api.writeFile('handle.bin', 4096); });   // one counted file op to have data
  const before = session.fileOpCount;
  await run(async (api) => {
    const h = await api.fs.open('handle.bin', 'r');
    await h.read(256);
    await h.read(256);
    await h.close();
  });
  const delta = session.fileOpCount - before;
  assert(delta === 0, `fs handle ops should not count, but fileOpCount moved by +${delta}`);
});

// (c) GC spam: create garbage (overwrite existing files so old versions go
// obsolete), then spam gc — fileOpCount stays flat while simNs climbs, on both
// the console gc() path and the churn runGcStep() path.
await check('N console gc() calls: fileOpCount flat, flash time (simNs) climbs (FASTFFS real GC)', async () => {
  // Build garbage: write then overwrite a batch of files; the superseded versions
  // become obsolete pages GC can reclaim.
  await run(async (api) => { for (let i = 0; i < 16; i++) await api.writeFile('g' + i + '.bin', 3072); });
  await run(async (api) => { for (let i = 0; i < 16; i++) await api.writeFile('g' + i + '.bin', 3072); });
  await run(async (api) => { for (let i = 0; i < 16; i++) await api.writeFile('g' + i + '.bin', 3072); });

  const opsBefore = session.fileOpCount;
  const simBefore = simNs();
  await run(async (api) => { for (let i = 0; i < 40; i++) await api.gc(); });
  const opsDelta = session.fileOpCount - opsBefore;
  const simDelta = simNs() - simBefore;
  assert(opsDelta === 0, `gc() must not change fileOpCount, but it moved by +${opsDelta}`);
  assert(simDelta > 0, `gc() must charge flash time on FASTFFS, but simNs did not climb (Δ=${simDelta})`);
});

await check('N churn runGcStep() calls: fileOpCount flat, flash time climbs', async () => {
  // More garbage to guarantee the churn-path GC has work to do.
  await run(async (api) => { for (let i = 0; i < 16; i++) await api.writeFile('h' + i + '.bin', 3072); });
  await run(async (api) => { for (let i = 0; i < 16; i++) await api.writeFile('h' + i + '.bin', 3072); });

  const opsBefore = session.fileOpCount;
  const simBefore = simNs();
  for (let i = 0; i < 40; i++) session.runGcStep();
  const opsDelta = session.fileOpCount - opsBefore;
  const simDelta = simNs() - simBefore;
  assert(opsDelta === 0, `runGcStep() must not change fileOpCount, but it moved by +${opsDelta}`);
  assert(simDelta > 0, `runGcStep() must charge flash time on FASTFFS, but simNs did not climb (Δ=${simDelta})`);
});

// churn WRITE/DELETE events count as one file op each (the auto-workload rung).
await check('churn write/delete events count as one file op each', async () => {
  const before = session.fileOpCount;
  session.runChurnEvent({ type: 'write', name: 'churn.bin', size: 1024, writeSeed: 7 });
  session.runChurnEvent({ type: 'delete', name: 'churn.bin' });
  const delta = session.fileOpCount - before;
  assert(delta === 2, `expected +2 for one write + one delete churn event, got +${delta}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${failed.length} failed.`);
console.log(failed.length === 0
  ? 'PASS - fileOpCount counts high-level FILE ops (per-call, not per-command), GC is excluded and only charges flash time (ADR-0023).'
  : `FAIL - ${failed.length} check(s) failed: ${failed.map((r) => r.name).join(', ')}`);
dom.uninstall();
process.exit(failed.length === 0 ? 0 : 1);
