/*
 * Boot single-format regression guard (the double-format bug) — ADR-0024
 * worker path.
 *
 * Boot used to format every chip TWICE: coordinator.reset() ran a silent
 * freshFormat() per session, then the broadcast boot `format()` command ran a
 * second full device format. SPIFFS made it visible — 2 x 64-erase sweeps
 * back-to-back at page load. Under the worker-per-session protocol
 * (ADR-0024) there is no format wire field at all: INIT and RESET both build
 * a BLANK chip (device.reset(), never format+mount — see
 * scripts/worker-harness.mjs's bootFormat doc), and the ONE real format ships
 * as an ordinary broadcast COMMAND, same as playground.js's boot sequence.
 * This guard re-homes the old assertion onto that path: it counts ERASE
 * EVENTS surfaced over the wire (FRAME.events, kind:'erase' — the only
 * observable that survives worker-side: runner.format() begins with
 * device.reset(), which zeroes stats AND wear, so post-format stats/wear read
 * "one format's worth" even when two formats ran) and the JOURNALED
 * format()-op line count, both BEFORE and AFTER the boot format command, and
 * across a subsequent coord.reset() + reformat cycle.
 *
 * Real WASM throughout (worker-harness.mjs's installWorkerHost default
 * createRunner), driven over the faithful mock transport — no stub runner.
 */
import { createRunner } from '../web/src/runner.js';
import { createChurnModel } from '../web/src/churn.js';
import { createLockstep } from '../web/src/lockstep.js';
import { createSessionProxy } from '../web/src/session-proxy.js';
import { installWorkerHost } from '../web/src/session-worker.js';
import { createTransport } from './mock-worker-transport.mjs';
import { GEOMETRY, CHURN_CFG, bootFormat, flushTurns } from './worker-harness.mjs';

process.on('unhandledRejection', (e) => { console.error('\nFAIL - unhandled rejection:', (e && e.stack) || e); process.exit(1); });
let failures = 0;
function fail(msg) { failures++; console.error('  FAIL - ' + msg); }
function ok(msg) { console.log('  ok   - ' + msg); }

// fastffs = the cheap-format control; spiffs = the 64-erase driver the user saw
// double-sweep. (The invariant is per-session mechanics, not per-driver.)
const FS_ORDER = ['fastffs', 'spiffs'];

// ---- rig: real coordinator + real proxies + real worker hosts (real WASM),
// over the mock transport, mirroring worker-harness.mjs's makeRig() but with
// this suite's own FS_ORDER and WITHOUT its automatic bootFormat() — this
// test needs to observe erase events straddling the boot format itself. ----
async function buildRig({ speed = 1e7 } = {}) {   // 1e7 = MAX_SCALE (the value setSpeed clamps to)
  const churn = createChurnModel(CHURN_CFG);
  const coord = createLockstep({ churn, autoTick: false });
  const proxies = [];
  for (const fsId of FS_ORDER) {
    const { mainPort, workerPort } = createTransport();
    installWorkerHost(workerPort, {});   // real WASM (default createRunner)
    proxies.push(createSessionProxy(mainPort, { fsId, name: fsId, geometry: GEOMETRY }));
  }
  coord.setSessions(proxies);   // sends INIT (async runner build); a fresh worker chip is BLANK
  await flushTurns(8);          // let every worker's runner build land
  coord.setSpeed(speed);
  const byId = Object.fromEntries(proxies.map((p) => [p.fsId, p]));
  return { coord, proxies, byId };
}

async function pullEvents(rig, fsId) {
  rig.byId[fsId].pull({ events: { since: -1, limit: 8192 } });
  await flushTurns(3);
  const f = rig.byId[fsId].frame;
  return f && f.events ? f.events : [];
}
async function pullJournal(rig, fsId) {
  rig.byId[fsId].pull({ journal: { since: -1, limit: 8192 } });
  await flushTurns(3);
  const f = rig.byId[fsId].frame;
  return f && f.journal ? f.journal : [];
}
const eraseCount = (events) => events.filter((e) => e.kind === 'erase').length;
const formatOpCount = (journal) => journal.filter((j) => j.kind === 'op' && /^format\(\)/.test(j.text)).length;

// ---- Reference: one format's worth of erases, per driver (a lone real runner). ----
const refErases = {};
for (const fsId of FS_ORDER) {
  const runner = await createRunner(GEOMETRY, fsId);
  let n = 0;
  runner.device.onEvent((ev) => { if (ev.op === 'erase') n++; });
  runner.format();   // the same op the boot command's fs.format() runs
  refErases[fsId] = n;
  if (!(n > 0)) fail(`reference: ${fsId} format produced no erase events?`);
}
console.log(`[ref] one format's worth of erases: ${FS_ORDER.map((f) => `${f}=${refErases[f]}`).join(', ')}`);

// ---- [1] Boot flow: INIT builds a BLANK chip (no erases), then the ONE
// broadcast format() command lands exactly one format's worth of erases and
// exactly one journaled format()-op line. ----
console.log("\n[1] boot flow: INIT builds a blank chip; broadcast format() lands exactly one device format");
{
  const rig = await buildRig();
  for (const fsId of FS_ORDER) {
    const got = eraseCount(await pullEvents(rig, fsId));
    if (got !== 0) fail(`${fsId}: INIT itself erased ${got} sectors (silent pre-format is back)`);
    else ok(`${fsId}: INIT performed no device format`);
  }
  await bootFormat(rig);   // the same format()+mount() pair playground.js's boot format() command compiles to
  for (const fsId of FS_ORDER) {
    const got = eraseCount(await pullEvents(rig, fsId));
    const want = refErases[fsId];
    if (got !== want) fail(`${fsId}: boot landed ${got} erase events, expected exactly one format's worth (${want}) - ${got > want ? 'DOUBLE FORMAT' : 'short format?'}`);
    else ok(`${fsId}: boot landed exactly one format's worth of erases (${got})`);
    const jGot = formatOpCount(await pullJournal(rig, fsId));
    if (jGot !== 1) fail(`${fsId}: journal shows ${jGot} format()-op lines, expected exactly 1`);
    else ok(`${fsId}: journal shows exactly one journaled format()`);
  }
  // The chip is genuinely usable after the boot flow (formatted + mounted).
  for (const fsId of FS_ORDER) {
    const before = rig.byId[fsId].acked.entriesDrained;
    const { index } = rig.coord.broadcast(`await writeFile('post-boot.bin', 512)`, 'post-boot write');
    for (let i = 0; i < 200 && rig.byId[fsId].acked.entriesDrained <= before; i++) { rig.coord._tick(); await flushTurns(4); }
    if (rig.byId[fsId].acked.entriesDrained >= index) ok(`${fsId}: chip writable after the boot flow (formatted + mounted)`);
    else fail(`${fsId}: chip NOT usable after the boot flow (write never drained)`);
  }
}

// ---- [2] coord.reset() blanks the chip again WITHOUT formatting (ADR-0024:
// no format wire field exists; reset() never formats, unlike the retired
// per-mode default-formats contract) — then a second broadcast format() still
// lands exactly one format's worth, guarding the double-format bug across a
// reset+reformat cycle too. ----
console.log('\n[2] coord.reset() blanks without formatting; a second broadcast format() still lands exactly once');
{
  const rig = await buildRig();
  await bootFormat(rig);
  for (const fsId of FS_ORDER) await pullEvents(rig, fsId);   // drain the first format's events before reset

  rig.coord.reset();
  await flushTurns(8);
  for (const fsId of FS_ORDER) {
    const got = eraseCount(await pullEvents(rig, fsId));
    if (got !== 0) fail(`${fsId}: coord.reset() itself erased ${got} sectors (reset must never format under ADR-0024)`);
    else ok(`${fsId}: coord.reset() performed no device format`);
  }
  await bootFormat(rig);
  for (const fsId of FS_ORDER) {
    const got = eraseCount(await pullEvents(rig, fsId));
    const want = refErases[fsId];
    if (got !== want) fail(`${fsId}: post-reset reformat landed ${got} erase events, expected exactly one format's worth (${want})`);
    else ok(`${fsId}: post-reset reformat landed exactly one format's worth of erases (${got})`);
  }
}

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - boot lands exactly ONE device format per FS (counted at the wire event stream,');
console.log('       which sees what post-format stats cannot); INIT/RESET blank the chip without');
console.log('       formatting, and each broadcast format() journals exactly one format()-op line.');
process.exit(0);
