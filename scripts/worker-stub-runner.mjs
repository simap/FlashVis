/*
 * worker-stub-runner.mjs — test-only runner.js stand-in for session-worker.js
 * tests. dist/*.mjs (the real WASM filesystems) is gitignored and not present
 * in every worktree (see the lane brief) — device.js itself has NO WASM
 * dependency, so this stub wires a REAL createNorDevice (real timing, real
 * read/prog/erase events, so heat/wear/playback pacing are exercised
 * faithfully) behind a small in-memory file table, matching runner.js's API
 * surface (device, write/read/remove/stat/names/mkdir/gcStep/liveMap/format/
 * mount/unmount/fsinfo). Not a faithful FS simulation — just enough that
 * every op actually touches the device, like scripts/stub-backend.mjs does
 * for the UI layer.
 */
import { createNorDevice } from '../web/src/device.js';

export async function createStubRunner(geometry = {}) {
  const sectorSize = geometry.sectorSize ?? 4096;
  const sectorCount = geometry.sectorCount ?? 8;
  const pageSize = geometry.pageSize ?? 256;
  const device = createNorDevice({ sectorSize, sectorCount, pageSize });

  // Fake WASM heap the device's read/prog can copy to/from — device.js expects
  // `mod.HEAPU8`; give it a plain ArrayBuffer-backed view, big enough for one op.
  const HEAP = new Uint8Array(1 << 20);
  device.attach({ HEAPU8: HEAP });

  const files = new Map();     // name -> Uint8Array
  let nextOff = 0;
  const pageAlloc = (len) => {
    // Bump-allocate pages sequentially, wrapping — enough to generate real
    // prog/erase device traffic without a real block allocator.
    const off = nextOff % device.size;
    nextOff += Math.ceil(len / pageSize) * pageSize;
    return off;
  };

  const runner = {
    device,
    name: 'stub',
    caps: 0b111,
    geometry: { sectorSize, sectorCount, pageSize },
    get hostBytes() { return [...files.values()].reduce((a, b) => a + b.length, 0); },

    format() { device.reset(); files.clear(); nextOff = 0; return 0; },
    mount() { return 0; },
    unmount() {},

    write(name, data) {
      const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const off = pageAlloc(u8.length);
      HEAP.set(u8, 0);
      device.prog(off, 0, u8.length);
      files.set(name, u8.slice());
      return u8.length;
    },
    read(name) {
      const u8 = files.get(name);
      if (!u8) throw new Error(`read ${name}: not found`);
      const off = 0;
      device.read(off, 0, Math.min(u8.length, pageSize));   // representative device traffic
      return u8.slice();
    },
    remove(name) {
      if (!files.has(name)) throw new Error(`delete ${name}: not found`);
      files.delete(name);
      return 0;
    },
    exists(name) { return files.has(name); },
    names() { return [...files.keys()]; },
    stat(name) { const u8 = files.get(name); return u8 ? { name, size: u8.length } : null; },
    mkdir() { return true; },
    list() { return [...files.entries()].map(([name, u8]) => ({ name, size: u8.length })); },

    // One opportunistic GC step: erase the next sector in rotation — real
    // device traffic (wear bump), independent of file content.
    _gcSector: 0,
    gcStep() { const s = runner._gcSector; runner._gcSector = (s + 1) % sectorCount; device.erase(s * sectorSize, sectorSize); return 0; },

    sectorClasses() { return null; },
    liveMap() {
      const pages = (sectorSize * sectorCount) / pageSize;
      const map = new Uint8Array(pages);
      // Everything programmed reads as live (class 3); crude but exercises the wire.
      for (let p = 0; p < pages; p++) map[p] = 3;
      return map;
    },
    fsinfo() { return { files: files.size, bytes: runner.hostBytes }; },
  };
  return runner;
}
