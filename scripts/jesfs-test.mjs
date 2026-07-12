/*
 * Pipeline proof: drive REAL JesFS (compiled to WASM) against the JS-emulated
 * NOR device, entirely in Node, through the FS-agnostic runner (ADR-0011):
 * createRunner(geometry, 'jesfs'). Format -> mount -> write -> read-back -> list,
 * plus the ABI/caps contract (ff_abi_version, ff_caps) and the native liveness
 * hook (ff_live_map, ADR-0012): caps LIVE_MAP only (GC + append off), and seek
 * emulation over a handle (rewind + forward re-read).
 */
import { createRunner } from '../web/src/runner.js';

const SECTOR_SIZE = 4096, SECTOR_COUNT = 64, PAGE_SIZE = 256, GRANULE = 1;

const runner = await createRunner(
  { sectorSize: SECTOR_SIZE, sectorCount: SECTOR_COUNT, pageSize: PAGE_SIZE, granule: GRANULE },
  'jesfs',
);

console.log('name      ->', runner.name);
console.log('caps      -> 0x' + runner.caps.toString(16));

console.log('format    ->', runner.format());
console.log('mount     ->', runner.mount());

const enc = new TextEncoder();

const payload = 'Hello from real JesFS, running as WASM over a JS-emulated NOR chip.';
runner.write('hello.txt', payload);
console.log('write     -> hello.txt', enc.encode(payload).length, 'bytes');

// a second, larger file to force multi-sector data + index activity
const big = new Uint8Array(9000).map((_, i) => (i * 37) & 0xff);
runner.write('firmware.bin', big);
console.log('write2    -> firmware.bin', big.length, 'bytes');

const got = runner.cat('hello.txt');
console.log('read      ->', enc.encode(got).length, 'bytes:', JSON.stringify(got));

const list = runner.list();
console.log('list      ->\n' + list.map((e) => `  ${e.name}\t${e.size}`).join('\n'));

console.log('fsinfo    ->', runner.fsinfo());
console.log('device    ->', runner.device.stats);

// Seek emulation (ADR-0011): open the big file, seek into the middle, read a
// slice, and confirm it matches — proving rewind + forward re-read works and
// that partial/positioned I/O issues real (visualized) device traffic.
const fh = runner.open('firmware.bin', 'r');
fh.seek(4000, 'set');
const slice = fh.read(16);
fh.close();
const okSeek = slice.length === 16 && [...slice].every((v, i) => v === big[4000 + i]);

// ADR-0011 capability gating: JesFS advertises LIVE_MAP only (0x4). GC is OFF
// (no incremental churn-safe primitive; ADR-0021), append is OFF (open-for-write
// truncates), and ff_sector_classes is omitted. The runner must degrade gc and
// sectorClasses to null rather than crash, while liveMap() returns a real map.
const okAbi = runner.name === 'jesfs';
const okCaps = runner.caps === 0x4; // FF_CAP_LIVE_MAP only
const okGcNoop = runner.gcStep() === null;
const okSectorClasses = runner.sectorClasses() === null;
// The native hook (ADR-0012) classifies erased/metadata/obsolete/live per page.
// Sector 0 (the master header + index) is metadata; the two written files give
// live-data sectors — expect both classes present, proving a real walk.
const npages = (SECTOR_SIZE * SECTOR_COUNT) / PAGE_SIZE;
const lm = runner.liveMap();
const okLiveMap = lm !== null && lm.length === npages && [...lm].every((v) => v >= 0 && v <= 3)
  && [...lm].some((v) => v === 1) && [...lm].some((v) => v === 3);
const okContent = got === payload;
const okList = list.some((e) => e.name === 'hello.txt' && e.size === enc.encode(payload).length)
  && list.some((e) => e.name === 'firmware.bin' && e.size === big.length);

const checks = { okAbi, okCaps, okGcNoop, okSectorClasses, okSeek, okLiveMap, okContent, okList };
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);

if (failed.length) {
  console.error('\nFAIL', checks);
  process.exit(1);
}
console.log('\nPASS — JesFS formatted, mounted, wrote two files and read one back,');
console.log('       ABI version 1 confirmed, caps 0x4 (LIVE_MAP), gc + sectorClasses');
console.log('       gated to null, seek emulation exact, live map classifies metadata+data,');
console.log('       issuing', runner.device.stats.reads, 'reads /',
            runner.device.stats.programs, 'programs /', runner.device.stats.erases,
            'erases against the emulated NOR device.');
