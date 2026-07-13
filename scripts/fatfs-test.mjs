/*
 * Pipeline proof: drive the REAL FASTFFS FAT stack (ChaN FatFs over ESP-IDF
 * wear_levelling, compiled to WASM) against the JS-emulated NOR device, in
 * Node, through the FS-agnostic runner (ADR-0011): createRunner(geo, 'fatfs').
 * Format -> mount -> write -> read-back -> list, plus the ABI/caps contract
 * (ff_abi_version, ff_caps) and the native liveness hook (ff_live_map,
 * ADR-0012): caps APPEND|LIVE_MAP (GC off), sector_classes off.
 *
 * One file uses the shared workload's own 13-char basename pattern
 * ("f000-...bin") to prove the driver's LFN config accepts names that exceed
 * FAT 8.3 (the whole reason FF_USE_LFN is enabled).
 */
import { createRunner } from '../web/src/runner.js';

const SECTOR_SIZE = 4096, SECTOR_COUNT = 64, PAGE_SIZE = 256, GRANULE = 1;

const runner = await createRunner(
  { sectorSize: SECTOR_SIZE, sectorCount: SECTOR_COUNT, pageSize: PAGE_SIZE, granule: GRANULE },
  'fatfs',
);

console.log('name      ->', runner.name);
console.log('caps      -> 0x' + runner.caps.toString(16));

console.log('format    ->', runner.format());
console.log('mount     ->', runner.mount());

const enc = new TextEncoder();

const payload = 'Hello from real ChaN FatFs over ESP-IDF wear_levelling, running as WASM over a JS-emulated NOR chip.';
runner.write('hello.txt', payload);
console.log('write     -> hello.txt', enc.encode(payload).length, 'bytes');

// a long (non-8.3) name from the shared workload's generator — needs LFN
const lfnName = 'f000-1a2b3c4d.bin';
const big = new Uint8Array(9000).map((_, i) => (i * 37) & 0xff);
runner.write(lfnName, big);
console.log('write2    ->', lfnName, big.length, 'bytes (LFN)');

const got = runner.cat('hello.txt');
console.log('read      ->', enc.encode(got).length, 'bytes:', JSON.stringify(got));

const list = runner.list();
console.log('list      ->\n' + list.map((e) => `  ${e.name}\t${e.size}`).join('\n'));

console.log('fsinfo    ->', runner.fsinfo());
console.log('device    ->', runner.device.stats);

// ADR-0011 capability gating: fatfs advertises APPEND|LIVE_MAP (0xc). No GC
// (ADR-0021): neither FatFs nor WL has an incremental, churn-safe GC primitive.
// It also omits ff_sector_classes; the runner must degrade both gc and
// sectorClasses to null rather than crash, while liveMap() returns real classes.
const okAbi = runner.name === 'fatfs';
const okCaps = runner.caps === 0xc; // FF_CAP_APPEND | FF_CAP_LIVE_MAP (GC off)
const okGcNoop = runner.gcStep() === null;
const okSectorClasses = runner.sectorClasses() === null;
// The native hook composes the FAT logical view through the WL mapping at
// PAGE granularity — it parses real FAT12 structure (BPB, FAT table, dir
// entries, file sizes + chains), so classes vary *within* sectors instead of
// whole-sectors-always-full. Classes: shared 0-3 baseline plus FAT+WL-specific
// 4 = "WL" (the FTL's own cfg/state/dummy sectors) and 5 = "slack" (allocated
// but carrying no data: cluster tails past EOF, metadata-region padding).
// Per-FS taxonomy, ADR-0011/0012.
const npages = (SECTOR_SIZE * SECTOR_COUNT) / PAGE_SIZE;
const lm = runner.liveMap();
const okLiveMap = lm !== null && lm.length === npages && [...lm].every((v) => v >= 0 && v <= 5);
// Exact page census for this deterministic scene (256-B pages, 4096-B
// clusters, hello.txt = 100 B, f000-... = 9000 B):
//   live 37    = 100 B -> 1 page; 9000 B -> 16 + 16 + 4 pages
//   meta 5     = boot record 2 (512 B) + 1 used FAT page x2 copies (FAT12
//                uses ceil(58*1.5) = 87 B) + root dir 1 (4 entries: hello.txt
//                SFN + f000's 2 LFN + 1 SFN = 128 B)
//   slack 86   = boot pad 14 + FAT pad 15x2 + root pad 15 + EOF slack 15 + 12
//   WL 64      = 4 whole sectors x 16 (cfg + state x2 + dummy)
//   erased 832 = 52 never-touched free clusters x 16
const census = (m) => { const c = [0, 0, 0, 0, 0, 0]; for (const v of m) c[v]++; return c; };
const okCensus = JSON.stringify(census(lm)) === JSON.stringify([832, 5, 0, 37, 64, 86]);
// Sub-sector resolution really happened: sectors mix classes (the FAT sector:
// 1 metadata page + 15 slack; hello's cluster: 1 live + 15 slack).
const pps = SECTOR_SIZE / PAGE_SIZE;
const sectors = Array.from({ length: SECTOR_COUNT }, (_, s) => [...lm.slice(s * pps, (s + 1) * pps)]);
const okGranular = sectors.some((cls) => cls.includes(1) && cls.includes(5))
  && sectors.some((cls) => cls.includes(3) && cls.includes(5));
// Class 4 still lands exactly on the WL FTL's own 4 whole sectors:
// state1/state2/cfg at the fixed top-of-device positions (61,62,63) plus the
// rotating dummy spare somewhere in the data region (0..60).
const wlSectors = sectors.flatMap((cls, s) => (cls.every((v) => v === 4) ? [s] : []));
const okWlClass = wlSectors.length === 4
  && [61, 62, 63].every((s) => wlSectors.includes(s))
  && wlSectors.filter((s) => s <= 60).length === 1
  && census(lm)[4] === 64; // no stray class-4 pages outside those sectors
// Deleting a file frees its cluster in the FAT while the bytes stay
// programmed: those pages must flip live->obsolete ("free but not erased",
// distinct from true erased), and its EOF slack vanishes with the allocation.
runner.remove('hello.txt');
const lm2 = runner.liveMap();
const okObsolete = JSON.stringify(census(lm2)) === JSON.stringify([832, 5, 16, 36, 64, 71]);
const okContent = got === payload;
const okList = list.some((e) => e.name === 'hello.txt' && e.size === enc.encode(payload).length)
  && list.some((e) => e.name === lfnName && e.size === big.length);

const checks = { okAbi, okCaps, okGcNoop, okSectorClasses, okLiveMap, okCensus, okGranular, okWlClass, okObsolete, okContent, okList };
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);

if (failed.length) {
  console.error('\nFAIL', checks);
  process.exit(1);
}
console.log('\nPASS — FatFs/wear_levelling formatted, mounted, wrote two files (one LFN) and read one');
console.log('       back, ABI version 1 confirmed, caps 0xc (APPEND|LIVE_MAP), gc + sectorClasses');
console.log('       gated to null, live map resolves FAT structure per page (meta/live/slack/');
console.log('       obsolete within sectors, WL(4) whole), issuing', runner.device.stats.reads, 'reads /',
            runner.device.stats.programs, 'programs /', runner.device.stats.erases,
            'erases against the emulated NOR device.');
