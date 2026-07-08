/*
 * Pipeline proof: drive REAL FASTFFS (compiled to WASM) against the JS-emulated
 * NOR device, entirely in Node. Format → mount → write → read-back → list, and
 * report the device traffic the driver actually issued.
 */
import createModule from '../dist/fastffs.mjs';
import { createNorDevice } from '../web/src/device.js';

const SECTOR_SIZE = 4096, SECTOR_COUNT = 64, GRANULE = 1;

const dev = createNorDevice({ sectorSize: SECTOR_SIZE, sectorCount: SECTOR_COUNT });
const ops = { read: 0, prog: 0, erase: 0, progBytes: 0 };
dev.onEvent((e) => {
  ops[e.op]++;
  if (e.op === 'prog') ops.progBytes += e.len;
});

const M = await createModule();
dev.attach(M);
M.flashDevice = dev;

const enc = new TextEncoder(), dec = new TextDecoder();
const cstr = (s) => { const b = enc.encode(s); const p = M._malloc(b.length + 1); M.HEAPU8.set(b, p); M.HEAPU8[p + b.length] = 0; return p; };
const bytes = (u8) => { const p = M._malloc(u8.length); M.HEAPU8.set(u8, p); return p; };

M._ff_config(SECTOR_SIZE, SECTOR_COUNT, GRANULE);
console.log('ff_format ->', M._ff_format());
console.log('ff_mount  ->', M._ff_mount());

const payload = enc.encode('Hello from real FASTFFS, running as WASM over a JS-emulated NOR chip.');
console.log('ff_write  ->', M._ff_write(cstr('hello.txt'), bytes(payload), payload.length));

// a second, larger file to force multi-sector data + index activity
const big = new Uint8Array(9000).map((_, i) => (i * 37) & 0xff);
console.log('ff_write2 ->', M._ff_write(cstr('firmware.bin'), bytes(big), big.length));

const cap = 16384, out = M._malloc(cap);
const n = M._ff_read(cstr('hello.txt'), out, cap);
const got = dec.decode(M.HEAPU8.subarray(out, out + Math.max(0, n)));
console.log('ff_read   ->', n, 'bytes:', JSON.stringify(got));

const lp = M._malloc(4096);
const ln = M._ff_list(lp, 4096);
console.log('ff_list   ->\n' + dec.decode(M.HEAPU8.subarray(lp, lp + Math.max(0, ln))).replace(/^/gm, '  ').trimEnd());

console.log('fsinfo    -> files:', M._ff_committed_files(), 'bytes:', M._ff_committed_bytes());
console.log('device    ->', ops);

const okContent = got === dec.decode(payload);
if (!okContent) {
  console.error('\nFAIL', { okContent });
  process.exit(1);
}
console.log('\nPASS — FASTFFS formatted, mounted, wrote two files and read one back,');
console.log('       issuing', ops.read, 'reads /', ops.prog, 'programs /', ops.erase,
            'erases against the emulated NOR device.');
