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
  // Decode a NUL-terminated C string out of a heap buffer via a slice() copy, never
  // a subarray/view (ADR-0013): we build fixed-memory so HEAPU8.buffer is a plain
  // ArrayBuffer today and a view would work — but copying stays safe if
  // ALLOW_MEMORY_GROWTH ever returns, since a resizable buffer makes browser
  // TextDecoder (incl. the one in emscripten's UTF8ToString) reject views onto it.
  const decodeCStr = (p, cap) => {
    let end = p; while (end < p + cap && M.HEAPU8[end] !== 0) end++;
    return dec.decode(M.HEAPU8.slice(p, end));
  };
  // One fffs_dir_read via a pooled dir handle; size<0 (end/error) → null.
  const readDirEntry = (handle) => {
    const cap = 64, p = M._malloc(cap);
    try {
      const size = M._ff_dir_read(handle, p, cap);
      if (size < 0) return null;
      return { name: decodeCStr(p, cap), size };
    } finally { M._free(p); }
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

    // Streaming directory iterator (ADR-0014): dirOpen/dirRead/dirClose are thin
    // wrappers over a pooled dir handle now — dirOpen returns the handle, dirRead/
    // dirClose take it, so more than one can be open at once. NOTE for the
    // integrator: playground.js's lsStream currently calls these with no args
    // (runner.dirOpen()/dirRead()/dirClose()); it must be updated to thread the
    // handle returned by dirOpen through dirRead/dirClose (or switch to openDir()).
    dirOpen(prefix = '') { return check(withCStr(prefix, (np) => M._ff_dir_open(np)), `dirOpen ${prefix}`); },
    dirRead(handle) { return readDirEntry(handle); },
    dirClose(handle) { M._ff_dir_close(handle); },

    /** Stat a file by name; null when it doesn't exist. */
    stat(name) {
      const cap = 128, buf = M._malloc(cap);
      try {
        const size = withCStr(name, (np) => M._ff_stat(np, buf, cap));
        if (size < 0) return null;
        return { name: decodeCStr(buf, cap), size };
      } finally { M._free(buf); }
    },

    /** Create a directory entry; a no-op success on flat FSs (already-exists is OK too). */
    mkdir(name) {
      check(withCStr(name, (np) => M._ff_mkdir(np)), `mkdir ${name}`);
      return true;
    },

    /** Open a handle for partial/positioned I/O. mode: 'r'|'w'|('a' if driver-supported). */
    open(name, mode = 'r') {
      const MODES = { r: 0, w: 1, a: 2 };
      const m = MODES[mode];
      if (m === undefined) throw new Error(`open ${name}: bad mode '${mode}'`);
      const handle = check(withCStr(name, (np) => M._ff_open(np, m)), `open ${name}`);
      let closed = false;
      return {
        /** Read up to n bytes from the current position; length = bytes actually read. */
        read(n) {
          const p = M._malloc(n || 1);
          try {
            const got = check(M._ff_file_read(handle, p, n), `read handle ${handle}`);
            return M.HEAPU8.slice(p, p + got);
          } finally { M._free(p); }
        },
        /** Write `data` (string|Uint8Array) at the current position; returns bytes written.
         *  Raw handle I/O — does NOT update hostBytes/tracked (those are the whole-file
         *  write() churn-model denominator only). */
        write(data) {
          const u8 = typeof data === 'string' ? enc.encode(data) : data;
          return check(withBytes(u8, (dp) => M._ff_file_write(handle, dp, u8.length)), `write handle ${handle}`);
        },
        /** Move the current position; whence 'set'|'cur'|'end'. Returns the new absolute position. */
        seek(off, whence = 'set') {
          const WHENCE = { set: 0, cur: 1, end: 2 };
          const w = WHENCE[whence];
          if (w === undefined) throw new Error(`seek: bad whence '${whence}'`);
          return check(M._ff_file_seek(handle, off, w), `seek handle ${handle}`);
        },
        /** Stat the open file. */
        stat() {
          const cap = 128, p = M._malloc(cap);
          try {
            const size = check(M._ff_file_stat(handle, p, cap), `stat handle ${handle}`);
            return { name: decodeCStr(p, cap), size };
          } finally { M._free(p); }
        },
        /** Close the handle, freeing its pool slot. Safe to call more than once. */
        close() {
          if (closed) return;
          closed = true;
          check(M._ff_file_close(handle), `close handle ${handle}`);
        },
      };
    },

    /** Open a directory-scoped streaming iterator over a pooled dir handle. */
    openDir(prefix = '') {
      const handle = check(withCStr(prefix, (np) => M._ff_dir_open(np)), `openDir ${prefix}`);
      let closed = false;
      return {
        /** One fffs_dir_read; regular files only. Null at end (or on error). */
        read: () => readDirEntry(handle),
        /** Close the dir handle, freeing its pool slot. Safe to call more than once. */
        close: () => {
          if (closed) return;
          closed = true;
          M._ff_dir_close(handle);
        },
      };
    },

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
