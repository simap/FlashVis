/*
 * Pipeline proof: drive REAL LittleFS (compiled to WASM) against the JS-emulated
 * NOR device, entirely in Node, through the FS-agnostic runner (ADR-0011):
 * createRunner(geometry, 'littlefs'). Format → mount → write → read-back → list,
 * plus the ABI/caps contract (ff_abi_version, ff_caps) and the native liveness
 * hook (ff_live_map, ADR-0012): caps APPEND|LIVE_MAP (GC off), sector_classes off.
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

// ADR-0011 capability gating: LittleFS advertises APPEND|LIVE_MAP (0xc). GC is
// deliberately OFF: littlefs is copy-on-write with no GC pass to model, and its
// lfs_fs_gc() is an idle-loop hint, not workload reclamation. It also omits
// ff_sector_classes; the runner must degrade both gc and sectorClasses to null
// rather than crash, while liveMap() returns a real classification.
const okAbi = runner.name === 'littlefs';
const okCaps = runner.caps === 0xc; // FF_CAP_APPEND | FF_CAP_LIVE_MAP (GC off)
const okGcNoop = runner.gcStep() === null; // GC cap off: gc step is a no-op for littlefs
const okSectorClasses = runner.sectorClasses() === null;
// The native hook (ADR-0012) classifies erased/metadata/obsolete/live per page.
// With two files written, expect a valid map that shows both metadata and live
// data — proving it actually walked the FS, not just returned zeros.
const npages = (SECTOR_SIZE * SECTOR_COUNT) / PAGE_SIZE;
const lm = runner.liveMap();
const okLiveMap = lm !== null && lm.length === npages && [...lm].every((v) => v >= 0 && v <= 3)
  && [...lm].some((v) => v === 1) && [...lm].some((v) => v === 3);
const okContent = got === payload;
const okList = list.some((e) => e.name === 'hello.txt' && e.size === enc.encode(payload).length)
  && list.some((e) => e.name === 'firmware.bin' && e.size === big.length);

const checks = { okAbi, okCaps, okGcNoop, okSectorClasses, okLiveMap, okContent, okList };
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);

if (failed.length) {
  console.error('\nFAIL', checks);
  process.exit(1);
}
console.log('\nPASS — LittleFS formatted, mounted, wrote two files and read one back,');
console.log('       ABI version 1 confirmed, caps 0xc (APPEND|LIVE_MAP), gc + sectorClasses');
console.log('       gated to null, live map classifies metadata+data, issuing', runner.device.stats.reads, 'reads /',
            runner.device.stats.programs, 'programs /', runner.device.stats.erases,
            'erases against the emulated NOR device.');
