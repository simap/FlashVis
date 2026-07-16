/*
 * Boot single-format regression guard (the double-format bug).
 *
 * Boot used to format every chip TWICE: coordinator.reset() ran a silent
 * freshFormat() per session, then the broadcast boot `format()` command ran a
 * second full device format. SPIFFS made it visible — 2 × 64-erase sweeps
 * back-to-back at page load. The fix: playground boots with
 * coordinator.reset({ format: false }) (session.blankChip — unmount + device
 * reset, NO format) and the broadcast format() command performs the ONE real,
 * journaled format.
 *
 * The guard counts ERASE EVENTS at the device stream, hooked from session
 * creation — the only observable that survives: runner.format() begins with
 * device.reset(), which zeroes stats AND wear, so post-boot stats/wear read
 * "one format's worth" even when two formats ran. The event stream sees both.
 *
 * Also locks in: reset() DEFAULT still fresh-formats (ADR-0016 "participant-set
 * change resets everyone to a fresh chip" — the contract every direct caller
 * and test relies on), and the boot-flow chip is genuinely usable afterwards.
 */
import { installFakeDom } from './fake-dom.mjs';
import { createChurnModel } from '../web/src/churn.js';
import { createSession } from '../web/src/session.js';
import { createLockstep } from '../web/src/lockstep.js';

process.on('unhandledRejection', (e) => { console.error('\nFAIL - unhandled rejection:', (e && e.stack) || e); process.exit(1); });
let failures = 0;
function fail(msg) { failures++; console.error('  FAIL - ' + msg); }
function ok(msg) { console.log('  ok   - ' + msg); }

const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const CHURN_CFG = {
  seed: 0x00c0ffee, targetLiveBytes: 96 * 1024, targetWrittenBytes: 0xffffffff,
  targetSlackBytes: 16 * 1024, forceLargeAfterBytes: 0xffffffff,
};
// fastffs = the cheap-format control; spiffs = the 64-erase driver the user saw
// double-sweep. (The invariant is per-session mechanics, not per-driver.)
const FS_ORDER = ['fastffs', 'spiffs'];

const flushMacro = () => new Promise((r) => setTimeout(r, 0));

async function makeRig() {
  const dom = installFakeDom();
  const sessions = [];
  const erases = new Map();   // session -> erase events seen since CREATION
  for (const fsId of FS_ORDER) {
    const s = await createSession(fsId, { geometry: GEOMETRY, container: document.createElement('div'), name: fsId });
    erases.set(s, 0);
    s.device.onEvent((ev) => { if (ev.op === 'erase') erases.set(s, erases.get(s) + 1); });
    sessions.push(s);
  }
  const coord = createLockstep({ churn: createChurnModel(CHURN_CFG) });
  coord.setSessions(sessions);
  coord.setSpeed(1e7);   // 1e7 = MAX_SCALE (the value setSpeed clamps to)
  return { dom, coord, sessions, erases, byId: Object.fromEntries(sessions.map((s) => [s.fsId, s])) };
}

const cursorsAt = (coord, n) => coord.snapshots().every((s) => s.stepCursor === n);
async function pumpUntil(rig, cond, label, maxIter = 4000) {
  for (let i = 0; i < maxIter; i++) {
    if (cond()) return;
    rig.dom.tick(1); rig.dom.runIntervals();
    await flushMacro();
  }
  if (!cond()) { fail(`${label}: never converged within ${maxIter} iterations`); process.exit(1); }
}

// ---- Reference: one format's worth of erases, per driver (a lone session). ----
const refErases = {};
{
  const dom = installFakeDom();
  for (const fsId of FS_ORDER) {
    const s = await createSession(fsId, { geometry: GEOMETRY, container: document.createElement('div'), name: fsId });
    let n = 0;
    s.device.onEvent((ev) => { if (ev.op === 'erase') n++; });
    s.freshFormat();          // format + mount — the same pair the boot command runs
    refErases[fsId] = n;
    if (!(n > 0)) fail(`reference: ${fsId} format produced no erase events?`);
  }
  console.log(`[ref] one format's worth of erases: ${FS_ORDER.map((f) => `${f}=${refErases[f]}`).join(', ')}`);
  dom.uninstall();
}

// ---- [1] The BOOT flow: reset({format:false}) + broadcast format() = ONE format. ----
console.log('\n[1] boot flow: reset({ format: false }) + broadcast format() lands exactly one device format');
{
  const rig = await makeRig();
  rig.coord.reset({ format: false });
  for (const s of rig.sessions) {
    if (rig.erases.get(s) !== 0) fail(`${s.fsId}: reset({format:false}) itself erased ${rig.erases.get(s)} sectors (silent pre-format is back)`);
    else ok(`${s.fsId}: reset({format:false}) performed no device format`);
  }
  // The same format+mount pair playground's boot format() command compiles to.
  rig.coord.broadcast(async (api) => { await api.fs.format(); await api.fs.mount(); }, 'format()');
  await pumpUntil(rig, () => cursorsAt(rig.coord, 1), 'boot format command');
  for (const s of rig.sessions) {
    const got = rig.erases.get(s), want = refErases[s.fsId];
    if (got !== want) fail(`${s.fsId}: boot landed ${got} erase events, expected exactly one format's worth (${want}) — ${got > want ? 'DOUBLE FORMAT' : 'short format?'}`);
    else ok(`${s.fsId}: boot landed exactly one format's worth of erases (${got})`);
  }
  // The chip is genuinely usable after the boot flow (formatted + mounted).
  for (const s of rig.sessions) {
    try { s.runner.write('post-boot.bin', new Uint8Array(512)); ok(`${s.fsId}: chip writable after the boot flow (formatted + mounted)`); }
    catch (e) { fail(`${s.fsId}: chip NOT usable after the boot flow: ${e.message}`); }
  }
}

// ---- [2] Default reset() still fresh-formats every chip (ADR-0016). ----
console.log('\n[2] default reset() still fresh-formats (ADR-0016 participant-set contract)');
{
  const rig = await makeRig();
  rig.coord.reset();
  for (const s of rig.sessions) {
    const got = rig.erases.get(s), want = refErases[s.fsId];
    if (got !== want) fail(`${s.fsId}: default reset() erased ${got}, expected one format's worth (${want})`);
    else ok(`${s.fsId}: default reset() formatted the chip (${got} erases)`);
    try { s.runner.write('post-reset.bin', new Uint8Array(512)); ok(`${s.fsId}: chip writable immediately after default reset() (no command needed)`); }
    catch (e) { fail(`${s.fsId}: chip NOT usable after default reset(): ${e.message}`); }
  }
}

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - boot lands exactly ONE device format per FS (counted at the event stream,');
console.log('       which sees what post-format stats cannot); reset({format:false}) formats');
console.log('       nothing itself; default reset() still fresh-formats per ADR-0016.');
process.exit(0);
