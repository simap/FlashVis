/*
 * Regression guard: a command op that THROWS through the real inner API must not
 * leak an unhandledRejection, and the coordinator must still drain/recover.
 *
 * The bug (pre-ADR-0024): session.js buildLocalApi.runOp did `p.finally(onSettle)`
 * - the finally() chain is a SEPARATE promise from the `p` it returns, so when
 * `work` throws (NO_SPACE, a read of a missing file) that chain rejected with
 * nothing awaiting it and leaked an unhandledRejection, even though runCommand
 * correctly swallows the returned promise's rejection. Post-0024, the equivalent
 * path is web/src/session-worker.js's buildLocalApi op() (op() catches, journals,
 * and RE-THROWS synchronously into the same promise chain startRealCommand's
 * `fn(tracked)` awaits - no separate finally-branch promise exists to leak). This
 * test drives a real throwing command op end-to-end over the worker wire and
 * asserts no leak fires, then that a following normal command still runs (the
 * worker's own error handling, session-worker.js:498-501, is untouched).
 *
 * WORKER-SIDE THROW: session-worker.js's REAL (non-synthetic) command path always
 * runs against a runner (opts.createRunner, default runner.js's real WASM loader).
 * scripts/worker-stub-runner.mjs's read() already throws `Error('read NAME: not
 * found')` for a missing file (real device traffic, no WASM build required), so
 * `api.readFile('does-not-exist.bin')` forces the throw without needing a real
 * NO_SPACE write. FV_WORKER_HOST/FV_CREATE_RUNNER below let this point at a
 * scratch copy of session-worker.js or a real-WASM runner for mutation testing
 * (revert session-worker.js's op() catch+rethrow -> this test still passes,
 * because the bug was in the DISCARDED finally-chain that no longer exists; the
 * meaningful mutation guard is dropping op()'s try/catch re-throw entirely, which
 * would instead surface as command error text never journaling, not a leak - see
 * the LANE-REPORT for detail).
 *
 * Deterministic: bounded pumps, and the leaked rejection (if any) is given a
 * bounded number of macrotask turns to surface (unhandledRejection is emitted
 * once the microtask queue drains without a handler - it needs turns, not
 * wall-clock time).
 */
import { createTransport, flushTurns } from './mock-worker-transport.mjs';
import { createSessionProxy } from '../web/src/session-proxy.js';
import { createChurnModel } from '../web/src/churn.js';
const { createLockstep } = await import(process.env.FV_LOCKSTEP || '../web/src/lockstep.js');
const { installWorkerHost } = await import(process.env.FV_WORKER_HOST || '../web/src/session-worker.js');
const { createStubRunner } = await import(process.env.FV_CREATE_RUNNER || './worker-stub-runner.mjs');

// Flag leaks; do NOT exit here - the assertion below decides, so the mutant fails
// with a clear message rather than the process aborting mid-setup.
let leaked = null;
process.on('unhandledRejection', (e) => { leaked = e; });

const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const CHURN_CFG = { seed: 0x00c0ffee, targetLiveBytes: 96 * 1024, targetWrittenBytes: 0xffffffff, targetSlackBytes: 16 * 1024, forceLargeAfterBytes: 0xffffffff };
const FS_ORDER = ['fastffs', 'littlefs'];

const proxies = [];
for (const fsId of FS_ORDER) {
  const { mainPort, workerPort } = createTransport();
  installWorkerHost(workerPort, { createRunner: createStubRunner });
  proxies.push(createSessionProxy(mainPort, { fsId, name: fsId, geometry: GEOMETRY }));
}
const coord = createLockstep({ churn: createChurnModel(CHURN_CFG), autoTick: false });
coord.setSessions(proxies);              // sends INIT (async runner build on the stub runner)
await flushTurns(8);                     // let every worker's runner build land
coord.reset();                           // reuses the built runner (device.reset())
await flushTurns(4);
coord.setSpeed(1e7);                     // 1e7 = MAX_SCALE (the value setSpeed clamps to)
coord.setMode('pace');

const cursors = () => coord.snapshots().map((s) => s.stepCursor);
const allAt = (n) => cursors().every((c) => c === n);

// [0] a command whose op throws (read of a nonexistent file, real inner API,
// the stub runner's real device path).
coord.broadcast('await readFile("does-not-exist.bin")', 'read missing');
// [1] a normal command behind it, to prove recovery.
coord.broadcast('await writeFile("after.bin", 4096)', 'write after');

let ok = true;
const fail = (m) => { ok = false; console.error('FAIL -', m); };

// pump to quiescence (both cursors past both commands), bounded.
let converged = false;
for (let i = 0; i < 4000 && !converged; i++) { coord._tick(); await flushTurns(1); converged = allAt(2); }
if (!converged) fail(`coordinator did not drain after a throwing command op (cursors ${cursors()})`);

// give any leaked finally-branch rejection a bounded number of turns to surface.
for (let i = 0; i < 8; i++) await flushTurns(1);

if (leaked) fail(`a throwing command op leaked an unhandledRejection: ${(leaked && leaked.message) || leaked}`);
if (converged && !leaked) {
  // recovery sanity: the normal command actually wrote its file on both FS,
  // pulled from the worker journal (the only channel data leaves a session by).
  for (const p of proxies) {
    p.pull({ journal: { since: -1, limit: 2000 } });
  }
  await flushTurns(3);
  for (const p of proxies) {
    const lines = (p.frame && p.frame.journal) || [];
    const wroteAfter = lines.some((l) => typeof l.text === 'string' && l.text.includes('write(after.bin'));
    if (!wroteAfter) fail(`${p.fsId} did not run the command after the throwing one (recovery broken)`);
  }
}

if (!ok) process.exit(1);
console.log('PASS - a throwing command op did not leak an unhandledRejection; the coordinator drained');
console.log('       and the following normal command ran on both FS (command error handling intact).');
process.exit(0);
