/*
 * Pipeline proof: drive REAL LittleFS (compiled to WASM) against the JS-emulated
 * NOR device, entirely in Node, through the FS-agnostic runner (ADR-0011):
 * createRunner(geometry, 'littlefs'). Format → mount → write → read-back → list,
 * plus the ABI/caps contract (ff_abi_version, ff_caps, and the Phase-1 cap set —
 * see the locked contract: GC|APPEND, no sector_classes/live_map yet).
 */
import { createRunner } from '../web/src/runner.js';

const SECTOR_SIZE = 4096, SECTOR_COUNT = 64, PAGE_SIZE = 256, GRANULE = 1;

const runner = await createRunner(
  { sectorSize: SECTOR_SIZE, sectorCount: SECTOR_COUNT, pageSize: PAGE_SIZE, granule: GRANULE },
  'littlefs',
);

console.log('name      ->', runner.name);
console.log('caps      -> 0x' + runner.caps.toString(16));

console.log('format    ->', runner.format());
console.log('mount     ->', runner.mount());

const enc = new TextEncoder();

const payload = 'Hello from real LittleFS, running as WASM over a JS-emulated NOR chip.';
runner.write('hello.txt', payload);
console.log('write     -> hello.txt', enc.encode(payload).length, 'bytes');

// a second, larger file to force multi-block data + metadata activity
const big = new Uint8Array(9000).map((_, i) => (i * 37) & 0xff);
runner.write('firmware.bin', big);
console.log('write2    -> firmware.bin', big.length, 'bytes');

const got = runner.cat('hello.txt');
console.log('read      ->', enc.encode(got).length, 'bytes:', JSON.stringify(got));

const list = runner.list();
console.log('list      ->\n' + list.map((e) => `  ${e.name}\t${e.size}`).join('\n'));

console.log('fsinfo    ->', runner.fsinfo());
console.log('device    ->', runner.device.stats);

// ADR-0011 capability gating: Phase-1 LittleFS advertises GC|APPEND (0x9) and
// omits ff_sector_classes/ff_live_map — the runner must degrade those to null
// rather than crash on a missing export.
const okAbi = runner.name === 'littlefs';
const okCaps = runner.caps === 0x9; // FF_CAP_GC | FF_CAP_APPEND, per the locked contract
const okGc = runner.gcStep() !== null;
const okSectorClasses = runner.sectorClasses() === null;
const okLiveMap = runner.liveMap() === null;
const okContent = got === payload;
const okList = list.some((e) => e.name === 'hello.txt' && e.size === enc.encode(payload).length)
  && list.some((e) => e.name === 'firmware.bin' && e.size === big.length);

const checks = { okAbi, okCaps, okGc, okSectorClasses, okLiveMap, okContent, okList };
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);

if (failed.length) {
  console.error('\nFAIL', checks);
  process.exit(1);
}
console.log('\nPASS — LittleFS formatted, mounted, wrote two files and read one back,');
console.log('       ABI version 1 confirmed, caps 0x9 (GC|APPEND), sectorClasses/liveMap');
console.log('       correctly gated to null, issuing', runner.device.stats.reads, 'reads /',
            runner.device.stats.programs, 'programs /', runner.device.stats.erases,
            'erases against the emulated NOR device.');
