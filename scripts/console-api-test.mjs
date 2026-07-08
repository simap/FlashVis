/*
 * Handle-API guard: exercises the ADR-0014 handle-based FS surface against real
 * FASTFFS over the emulated NOR device — partial/seeked reads, short-read/EOF,
 * write→read round-trips through a handle, static-pool exhaustion + reuse (files
 * and dirs), stat/mkdir, and prefix-scoped directory listing. Sibling to
 * integrity-test.mjs (whole-file churn fidelity); this one targets the newer
 * per-handle ABI (`open`, `openDir`, `stat`, `mkdir`) described in
 * adr/0014-console-fs-api.md.
 */
import { createRunner } from '../web/src/runner.js';

const FF_MAX_FILES = 8; // bindings/fastffs/shim.c pool size — see contract
const FF_MAX_DIRS = 4;

const runner = await createRunner({ sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 });
runner.format();
runner.mount();

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const pattern = (n, seed = 0) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 31 + 7 + seed) & 0xff; return a; };

const results = [];
function check(n, name, fn) {
  try {
    fn();
    results.push({ n, name, ok: true });
    console.log(`  [${n}] PASS — ${name}`);
  } catch (e) {
    results.push({ n, name, ok: false, err: e });
    console.log(`  [${n}] FAIL — ${name}: ${e.message}`);
  }
}

// 1. Partial/seeked reads byte-exact.
check(1, 'partial/seeked reads byte-exact', () => {
  const data = pattern(3000);
  runner.write('pattern.dat', data);

  const h = runner.open('pattern.dat', 'r');
  try {
    // whole read from the start
    assert(eq(h.read(3000), data), 'full read mismatch');

    // seek(set) + partial read
    assert(h.seek(100, 'set') === 100, 'seek(set) returned wrong position');
    assert(eq(h.read(50), data.slice(100, 150)), 'seek(set)+read mismatch');

    // seek(cur) relative to the position read() just advanced to (150)
    assert(h.seek(10, 'cur') === 160, 'seek(cur) returned wrong position');
    assert(eq(h.read(40), data.slice(160, 200)), 'seek(cur)+read mismatch');

    // seek(end) with a negative offset
    assert(h.seek(-100, 'end') === 2900, 'seek(end) returned wrong position');
    assert(eq(h.read(50), data.slice(2900, 2950)), 'seek(end)+read mismatch');

    // back to the start
    assert(h.seek(0, 'set') === 0, 'seek(set,0) returned wrong position');
    assert(eq(h.read(3000), data), 'reread from start mismatch');
  } finally { h.close(); }
});

// 2. Short-read at EOF: fewer bytes than requested, then 0 — never an error.
check(2, 'short-read at EOF, never an error', () => {
  const h = runner.open('pattern.dat', 'r');
  try {
    assert(h.seek(-10, 'end') === 2990, 'seek near end returned wrong position');
    const tail = h.read(100); // only 10 bytes remain
    assert(tail.length === 10, `expected short read of 10 bytes, got ${tail.length}`);
    assert(eq(tail, pattern(3000).slice(2990, 3000)), 'short-read bytes mismatch');

    const eof = h.read(100); // now exactly at EOF
    assert(eof.length === 0, `expected 0-length EOF read, got ${eof.length}`);
  } finally { h.close(); }
});

// 3. Handle write→read round-trip (including sequential writes advancing position).
check(3, 'handle write->read round-trip', () => {
  const chunkA = pattern(300, 1);
  const chunkB = pattern(200, 2);

  const w = runner.open('roundtrip.dat', 'w');
  try {
    const nA = w.write(chunkA);
    assert(nA === chunkA.length, `write returned ${nA}, expected ${chunkA.length}`);
    const nB = w.write(chunkB);
    assert(nB === chunkB.length, `second write returned ${nB}, expected ${chunkB.length}`);
  } finally { w.close(); }

  const r = runner.open('roundtrip.dat', 'r');
  try {
    const back = r.read(chunkA.length + chunkB.length);
    assert(back.length === chunkA.length + chunkB.length, `readback length ${back.length}`);
    assert(eq(back.slice(0, chunkA.length), chunkA), 'first chunk mismatch on readback');
    assert(eq(back.slice(chunkA.length), chunkB), 'second chunk mismatch on readback');
  } finally { r.close(); }

  // also cross-check against the whole-file raw read
  assert(eq(runner.read('roundtrip.dat'), new Uint8Array([...chunkA, ...chunkB])), 'whole-file read mismatch');
});

// 4. Pool exhaustion + reuse — files (FF_MAX_FILES=8) and dirs (FF_MAX_DIRS=4).
check(4, 'file-pool exhaustion + reuse', () => {
  const handles = [];
  for (let i = 0; i < FF_MAX_FILES; i++) handles.push(runner.open(`pool${i}.dat`, 'w'));
  assert(handles.length === FF_MAX_FILES, 'did not open FF_MAX_FILES handles');

  let threw = false;
  try { runner.open('pool_overflow.dat', 'w'); } catch { threw = true; }
  assert(threw, 'expected the 9th concurrent open to fail (pool exhaustion)');

  // free one slot, then confirm a new open succeeds and is fully usable
  handles.shift().close();
  const reused = runner.open('pool_reused.dat', 'w');
  reused.write(pattern(64, 3));
  reused.close();
  assert(eq(runner.read('pool_reused.dat'), pattern(64, 3)), 'handle from reused slot did not read back correctly');

  for (const h of handles) h.close();
});

check(4, 'dir-pool exhaustion + reuse', () => {
  const dirs = [];
  for (let i = 0; i < FF_MAX_DIRS; i++) dirs.push(runner.openDir(''));
  assert(dirs.length === FF_MAX_DIRS, 'did not open FF_MAX_DIRS dir handles');

  let threw = false;
  try { runner.openDir(''); } catch { threw = true; }
  assert(threw, 'expected the 5th concurrent openDir to fail (pool exhaustion)');
  // NOTE: contract only says open() throws on ff_open<0 explicitly; openDir's
  // failure mode isn't spelled out. Assuming symmetric throw-on-negative, per
  // check()'s pattern elsewhere in runner.js — see report for this assumption.

  dirs.shift().close();
  const reused = runner.openDir('');
  // must be usable — read() should not itself error (null at end is fine)
  const entry = reused.read();
  assert(entry === null || (typeof entry.name === 'string' && typeof entry.size === 'number'), 'reused dir handle read() returned malformed entry');
  reused.close();

  for (const d of dirs) d.close();
});

// 5. stat/mkdir.
check(5, 'stat/mkdir', () => {
  const st = runner.stat('pattern.dat');
  assert(st !== null, 'stat of an existing file returned null');
  assert(st.name === 'pattern.dat', `stat name mismatch: ${st.name}`);
  assert(st.size === 3000, `stat size mismatch: ${st.size}`);

  assert(runner.stat('does-not-exist.xyz') === null, 'stat of a missing file did not return null');

  assert(runner.mkdir('mydir') === true, 'mkdir did not report success');
  runner.write('mydir/leaf.dat', 'hello from a nested-looking name');
  const leaf = runner.stat('mydir/leaf.dat');
  assert(leaf !== null && leaf.size === 'hello from a nested-looking name'.length, 'write under mkdir-created name failed to stat back correctly');
});

// 6. openDir(prefix) lists matching entries.
check(6, 'openDir(prefix) lists matching entries', () => {
  runner.write('sub/a.dat', 'aaa');
  runner.write('sub/b.dat', 'bbbb');
  runner.write('zzz.dat', 'unrelated, does not share the prefix');

  const dh = runner.openDir('sub');
  const names = [];
  try {
    let entry;
    while ((entry = dh.read()) !== null) names.push(entry.name);
  } finally { dh.close(); }

  assert(names.includes('sub/a.dat'), 'openDir(prefix) missing sub/a.dat');
  assert(names.includes('sub/b.dat'), 'openDir(prefix) missing sub/b.dat');
  assert(!names.includes('zzz.dat'), 'openDir(prefix) leaked an unrelated entry');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${failed.length} failed.`);
console.log(failed.length === 0
  ? 'PASS — console handle API (open/openDir/stat/mkdir) is simulation-correct against real FASTFFS.'
  : `FAIL — ${failed.length} check(s) failed: ${failed.map((r) => `[${r.n}] ${r.name}`).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
