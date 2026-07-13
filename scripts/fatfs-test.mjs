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

// --- EMPTY-VOLUME census (the first-page-load state; spec/ui.md) ---
// With zero files, NOTHING may read as live data: everything is metadata of
// one kind or another, or not-yet-used space. Physical layout at 7 erases
// (no WL rotation yet): sector 0 = the clean dummy (erased), 1 = VBR (2 meta
// pages for the 512-B boot record + 14 slack), 2/3 = the two FAT copies
// (1 meta page each — FAT12 uses 87 bytes — + 15 slack), 4 = root dir (1 meta
// page: just the end-of-dir marker + 15 slack), 5..60 erased free clusters,
// 61/62/63 = the FTL-written state/cfg sectors (WL).
//   erased 912 = dummy 16 + 56 untouched clusters x 16
//   meta 5, slack 59 = 14+15+15+15, WL 48, live 0, obsolete 0
const censusEmpty = (() => {
  const m = runner.liveMap();
  const c = [0, 0, 0, 0, 0, 0];
  for (const v of m) c[v]++;
  return c;
})();
const okEmptyCensus = JSON.stringify(censusEmpty) === JSON.stringify([912, 5, 0, 0, 48, 59]);
const okEmptyNoLive = censusEmpty[3] === 0;

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
// 4 = "WL" (metadata the FTL itself writes: cfg + state x2 ONLY — spec/ui.md)
// and 5 = "slack" (allocated but carrying no data: cluster tails past EOF,
// metadata-region padding; rendered blank by the UI). Per-FS taxonomy,
// ADR-0011/0012.
const npages = (SECTOR_SIZE * SECTOR_COUNT) / PAGE_SIZE;
const lm = runner.liveMap();
const okLiveMap = lm !== null && lm.length === npages && [...lm].every((v) => v >= 0 && v <= 5);
// Exact page census for this deterministic scene (256-B pages, 4096-B
// clusters, hello.txt = 100 B, f000-... = 9000 B, 20 erases so the WL dummy
// has rotated exactly once — updaterate 16):
//   live 37     = 100 B -> 1 page; 9000 B -> 16 + 16 + 4 pages
//   meta 5      = boot record 2 (512 B) + 1 used FAT page x2 copies (FAT12
//                 uses ceil(58*1.5) = 87 B) + root dir 1 (4 entries: hello.txt
//                 SFN + f000's 2 LFN + 1 SFN, plus the end-of-dir marker)
//   slack 86    = boot pad 14 + FAT pad 15x2 + root pad 15 + EOF slack 15 + 12
//   WL 48       = 3 whole sectors x 16: ONLY what the FTL writes (cfg +
//                 state x2); the rotating dummy spare is NOT class 4
//                 (spec/ui.md — sectors handed to the FS layer are decorated
//                 by the FS layer alone)
//   obsolete 16 = the dummy, still holding the stale copy of the sector the
//                 FTL vacated when it rotated (dead bytes — honest garbage)
//   erased 832  = 52 never-touched free clusters x 16
const census = (m) => { const c = [0, 0, 0, 0, 0, 0]; for (const v of m) c[v]++; return c; };
const okCensus = JSON.stringify(census(lm)) === JSON.stringify([832, 5, 16, 37, 48, 86]);
// Sub-sector resolution really happened: sectors mix classes (the FAT sector:
// 1 metadata page + 15 slack; hello's cluster: 1 live + 15 slack).
const pps = SECTOR_SIZE / PAGE_SIZE;
const sectors = Array.from({ length: SECTOR_COUNT }, (_, s) => [...lm.slice(s * pps, (s + 1) * pps)]);
const okGranular = sectors.some((cls) => cls.includes(1) && cls.includes(5))
  && sectors.some((cls) => cls.includes(3) && cls.includes(5));
// Class 4 lands exactly on the FTL-WRITTEN sectors: state1/state2/cfg at the
// fixed top-of-device positions (61,62,63) — three whole sectors, no strays.
const wlSectors = sectors.flatMap((cls, s) => (cls.every((v) => v === 4) ? [s] : []));
const okWlClass = wlSectors.length === 3
  && [61, 62, 63].every((s) => wlSectors.includes(s))
  && census(lm)[4] === 48;
// Deleting a file frees its cluster in the FAT while the bytes stay
// programmed: those pages must flip live->obsolete ("free but not erased",
// distinct from true erased), and its EOF slack vanishes with the allocation.
runner.remove('hello.txt');
const lm2 = runner.liveMap();
const okObsolete = JSON.stringify(census(lm2)) === JSON.stringify([832, 5, 32, 36, 48, 71]);
// --- post-rotation placement guard ---
// Force the dummy through several more rotations (updaterate 16; each write
// erases FAT x2 + root + data sectors), then write a marker file with a
// distinctive fill and assert the map's classes land at the marker's REAL
// physical pages — the logical->physical composition must track WL's live
// state (dummy position, move count) at walk time, never a mount-time
// snapshot.
for (let i = 0; i < 10; i++) runner.write('rot.bin', new Uint8Array(8192).fill(0x5A));
runner.write('marker.bin', new Uint8Array(3000).fill(0xC3));
const lm3 = runner.liveMap();
const flash = runner.device.flash;
const fullC3 = []; // physical pages entirely 0xC3
for (let p = 0; p < npages; p++) {
  let all = true;
  for (let i = 0; i < PAGE_SIZE; i++) if (flash[p * PAGE_SIZE + i] !== 0xC3) { all = false; break; }
  if (all) fullC3.push(p);
}
// marker.bin = 3000 B = 11 full pages + 1 partial. Every full-0xC3 page is
// either the live copy (class 3) or a stale copy left where the dummy passed
// (class 2) — never metadata/WL/slack — and exactly 11 of them are live.
const okRotPlacement = fullC3.length >= 11
  && fullC3.every((p) => lm3[p] === 3 || lm3[p] === 2)
  && fullC3.filter((p) => lm3[p] === 3).length === 11;
// The map's boot sector (metadata in pages 0-1 but not 2) sits exactly where
// a real VBR lives on the die right now.
const bootSecs = sectors.map((_, s) => s).filter((s) =>
  lm3[s * pps] === 1 && lm3[s * pps + 1] === 1 && lm3[s * pps + 2] !== 1);
const okRotBoot = bootSecs.length === 1
  && flash[bootSecs[0] * SECTOR_SIZE] === 0xEB
  && flash[bootSecs[0] * SECTOR_SIZE + 510] === 0x55
  && flash[bootSecs[0] * SECTOR_SIZE + 511] === 0xAA;
const okContent = got === payload;
const okList = list.some((e) => e.name === 'hello.txt' && e.size === enc.encode(payload).length)
  && list.some((e) => e.name === lfnName && e.size === big.length);

const checks = { okAbi, okCaps, okGcNoop, okSectorClasses, okEmptyCensus, okEmptyNoLive, okLiveMap, okCensus, okGranular, okWlClass, okObsolete, okRotPlacement, okRotBoot, okContent, okList };
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
