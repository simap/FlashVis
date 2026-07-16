/*
 * Regression guard: a command op that THROWS through the real inner API must not
 * leak an unhandledRejection, and the coordinator must still drain/recover.
 *
 * The bug: session.js buildLocalApi.runOp did `p.finally(onSettle)` - the
 * finally() chain is a SEPARATE promise from the `p` it returns, so when `work`
 * throws (NO_SPACE, a read of a missing file) that chain rejected with nothing
 * awaiting it and leaked an unhandledRejection, even though runCommand correctly
 * swallows the returned promise's rejection. The fix appends `.catch(() => {})`
 * to the discarded finally-branch. This test drives a real throwing command op
 * end-to-end and asserts no leak fires, then that a following normal command
 * still runs (the command layer's own error handling is untouched).
 *
 * FV_SESSION points this at a scratch copy of session.js for mutation testing
 * (revert the `.catch` -> this test FAILs). Deterministic: bounded pumps, and the
 * leaked rejection (if any) is given a bounded number of macrotask turns to
 * surface (unhandledRejection is emitted once the microtask queue drains without
 * a handler - it needs turns, not wall-clock time).
 */
import { installFakeDom } from './fake-dom.mjs';
import { createChurnModel } from '../web/src/churn.js';
import { createLockstep } from '../web/src/lockstep.js';
const { createSession } = await import(process.env.FV_SESSION || '../web/src/session.js');

// Flag leaks; do NOT exit here - the assertion below decides, so the mutant fails
// with a clear message rather than the process aborting mid-setup.
let leaked = null;
process.on('unhandledRejection', (e) => { leaked = e; });

const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const CHURN_CFG = { seed: 0x00c0ffee, targetLiveBytes: 96 * 1024, targetWrittenBytes: 0xffffffff, targetSlackBytes: 16 * 1024, forceLargeAfterBytes: 0xffffffff };
const flushMacro = () => new Promise((r) => setTimeout(r, 0));

const dom = installFakeDom();
const sessions = [];
for (const fsId of ['fastffs', 'littlefs']) {
  sessions.push(await createSession(fsId, { geometry: GEOMETRY, container: document.createElement('div'), name: fsId }));
}
const coord = createLockstep({ churn: createChurnModel(CHURN_CFG) });
coord.setSessions(sessions);
coord.reset();
coord.setSpeed(1e7);   // 1e7 = MAX_SCALE (the value setSpeed clamps to)
coord.setMode('pace');

const cursors = () => coord.snapshots().map((s) => s.stepCursor);
const allAt = (n) => cursors().every((c) => c === n);

// [0] a command whose op throws (read of a nonexistent file, real inner API).
coord.broadcast(async (api) => { await api.readFile('does-not-exist.bin'); }, 'read missing');
// [1] a normal command behind it, to prove recovery.
coord.broadcast(async (api) => { await api.writeFile('after.bin', 4096); }, 'write after');

let ok = true;
const fail = (m) => { ok = false; console.error('FAIL -', m); };

// pump to quiescence (both cursors past both commands), bounded.
let converged = false;
for (let i = 0; i < 4000 && !converged; i++) { dom.tick(1); dom.runIntervals(); await flushMacro(); converged = allAt(2); }
if (!converged) fail(`coordinator did not drain after a throwing command op (cursors ${cursors()})`);

// give any leaked finally-branch rejection a bounded number of turns to surface.
for (let i = 0; i < 8; i++) await flushMacro();

if (leaked) fail(`a throwing command op leaked an unhandledRejection: ${(leaked && leaked.message) || leaked}`);
if (converged && !leaked) {
  // recovery sanity: the normal command actually wrote its file on both FS.
  for (const s of sessions) if (!s.runner.names().includes('after.bin')) fail(`${s.fsId} did not run the command after the throwing one (recovery broken)`);
}

if (!ok) process.exit(1);
console.log('PASS - a throwing command op did not leak an unhandledRejection; the coordinator drained');
console.log('       and the following normal command ran on both FS (command error handling intact).');
process.exit(0);
