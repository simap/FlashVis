/*
 * Loads a filesystem WASM module, binds it to an emulated NOR device, and
 * exposes a small, friendly FS API. All the WASM pointer marshalling lives here
 * so the playground and console can speak in strings and Uint8Arrays.
 */
import createModule from '../../dist/fastffs.mjs';
import { createNorDevice } from './device.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function createRunner(geometry = {}) {
  const sectorSize  = geometry.sectorSize  ?? 4096;
  const sectorCount = geometry.sectorCount ?? 64;
  const pageSize    = geometry.pageSize    ?? 256;
  let   granule     = geometry.granule     ?? 1;

  const device = createNorDevice({ sectorSize, sectorCount, pageSize });
  const M = await createModule();
  device.attach(M);
  M.flashDevice = device;

  let hostBytes = 0;        // bytes the "host" asked to write — the WA denominator
  const tracked = new Set(); // names we've written (a churn-model view of what exists)

  // --- heap helpers ---
  const withCStr = (s, fn) => {
    const b = enc.encode(s);
    const p = M._malloc(b.length + 1);
    M.HEAPU8.set(b, p); M.HEAPU8[p + b.length] = 0;
    try { return fn(p); } finally { M._free(p); }
  };
  const withBytes = (u8, fn) => {
    const p = M._malloc(u8.length || 1);
    M.HEAPU8.set(u8, p);
    try { return fn(p); } finally { M._free(p); }
  };
  const check = (rc, what) => {
    if (rc < 0) throw new Error(`${what} failed: ${rc}`);
    return rc;
  };

  M._ff_config(sectorSize, sectorCount, granule);

  const api = {
    device,
    geometry: { sectorSize, sectorCount, pageSize, get granule() { return granule; } },
    get hostBytes() { return hostBytes; },

    /** Re-init geometry/granule; requires a fresh format afterwards. */
    config(next = {}) {
      if (next.granule) granule = next.granule;
      M._ff_config(sectorSize, sectorCount, granule);
    },

    format() { device.reset(); hostBytes = 0; tracked.clear(); return check(M._ff_format(), 'format'); },
    mount()  { return check(M._ff_mount(), 'mount'); },
    unmount() { M._ff_unmount(); },

    /** Create-or-replace a whole file. `data` may be a string or Uint8Array. */
    write(name, data) {
      const u8 = typeof data === 'string' ? enc.encode(data) : data;
      const rc = withCStr(name, (np) => withBytes(u8, (dp) => M._ff_write(np, dp, u8.length)));
      check(rc, `write ${name}`);
      hostBytes += u8.length;
      tracked.add(name);
      return u8.length;
    },

    /** Read a whole file, returns a Uint8Array. */
    read(name) {
      const cap = sectorSize * sectorCount;
      const out = M._malloc(cap);
      try {
        const n = withCStr(name, (np) => M._ff_read(np, out, cap));
        check(n, `read ${name}`);
        return M.HEAPU8.slice(out, out + n);
      } finally { M._free(out); }
    },

    /** Read a whole file as text. */
    cat(name) { return dec.decode(this.read(name)); },

    remove(name) { const rc = check(withCStr(name, (np) => M._ff_delete(np)), `delete ${name}`); tracked.delete(name); return rc; },
    exists(name) { return withCStr(name, (np) => M._ff_exists(np)) === 1; },

    /** Names we've written and not deleted — the churn-model view of what exists. */
    names() { return [...tracked]; },

    // Streaming directory iterator: each dirRead is one fffs_dir_read.
    dirOpen() { return M._ff_dir_open(); },
    dirRead() {
      const cap = 64, p = M._malloc(cap);
      try {
        const size = M._ff_dir_read(p, cap);
        if (size < 0) return null;
        // Decode from a slice() copy, never a HEAP view: ALLOW_MEMORY_GROWTH makes
        // HEAPU8.buffer a *resizable* ArrayBuffer, and TextDecoder.decode() (incl. the
        // one inside emscripten's UTF8ToString) refuses a view backed by one.
        let end = p; while (end < p + cap && M.HEAPU8[end] !== 0) end++;
        return { name: dec.decode(M.HEAPU8.slice(p, end)), size };
      } finally { M._free(p); }
    },
    dirClose() { M._ff_dir_close(); },

    /** List files as [{ name, size }]. */
    list() {
      const cap = 1 << 16, out = M._malloc(cap);
      try {
        const n = check(M._ff_list(out, cap), 'list');
        // slice(), not subarray(): see dirRead — decoding a resizable-backed view throws.
        return dec.decode(M.HEAPU8.slice(out, out + n)).split('\n').filter(Boolean)
          .map((line) => { const [name, size] = line.split('\t'); return { name, size: +size }; });
      } finally { M._free(out); }
    },

    /** One opportunistic GC step; returns the fffs_gc_action code. */
    gcStep() { return check(M._ff_gc_step(), 'gc'); },

    fsinfo() {
      return { files: M._ff_committed_files() >>> 0, bytes: M._ff_committed_bytes() >>> 0 };
    },

    /** Per-sector role: 0 erased, 1 live, 2 obsolete, 3 index, 4 other. Silent (no device traffic). */
    sectorClasses() {
      const p = M._malloc(sectorCount);
      try {
        if (M._ff_sector_classes(p) < 0) return null;
        return M.HEAPU8.slice(p, p + sectorCount);
      } finally { M._free(p); }
    },

    /** Per-page liveness (reachability walk): 0 erased, 1 metadata, 2 obsolete, 3 live-data. Silent. */
    liveMap() {
      const pages = (sectorSize * sectorCount) / pageSize;
      const p = M._malloc(pages);
      try {
        if (M._ff_live_map(p, pageSize) < 0) return null;
        return M.HEAPU8.slice(p, p + pages);
      } finally { M._free(p); }
    },
  };

  return api;
}
