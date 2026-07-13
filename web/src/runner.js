/*
 * Loads a filesystem WASM module, binds it to an emulated NOR device, and
 * exposes a small, friendly FS API. All the WASM pointer marshalling lives here
 * so the playground and console can speak in strings and Uint8Arrays.
 *
 * FS-agnostic per ADR-0011: the module is picked by `fsId` (dist/<fsId>.mjs)
 * rather than hard-bound to FASTFFS, and the optional introspection methods
 * (gcStep/sectorClasses/liveMap) are gated on the loaded module's advertised
 * `ff_caps()` bitmask plus symbol presence, so a driver that omits or disclaims
 * one degrades to null/no-op instead of throwing on a missing `_ff_*` export.
 */
import { createNorDevice } from './device.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ff_caps() bits (ADR-0011) — must match every ff_* shim (bindings/*/shim.c).
// Exported so the UI (playground.js) can gate controls on the *same* bits the
// runner gates its optional methods on, instead of re-declaring the mask.
export const FF_CAP_GC             = 1 << 0;
export const FF_CAP_SECTOR_CLASSES = 1 << 1;
export const FF_CAP_LIVE_MAP       = 1 << 2;
// FF_CAP_APPEND (1 << 3): ff_open mode 2 ('a') is implemented — not runner-gated
// yet (open() just forwards the mode and lets ff_open reject it), listed here
// for the bit layout to stay visibly complete against the ADR-0011 contract.

const FF_ABI_VERSION = 1;

export async function createRunner(geometry = {}, fsId = 'fastffs') {
  const sectorSize  = geometry.sectorSize  ?? 4096;
  const sectorCount = geometry.sectorCount ?? 64;
  const pageSize    = geometry.pageSize    ?? 256;
  let   granule     = geometry.granule     ?? 1;

  const device = createNorDevice({ sectorSize, sectorCount, pageSize });
  const { default: createModule } = await import(`../../dist/${fsId}.mjs`);
  const M = await createModule();
  device.attach(M);
  M.flashDevice = device;

  const abiVersion = M._ff_abi_version();
  if (abiVersion !== FF_ABI_VERSION) {
    throw new Error(`createRunner: ${fsId} reports ff_abi_version ${abiVersion}, runner expects ${FF_ABI_VERSION}`);
  }
  const caps = M._ff_caps() >>> 0;
  // Gate an optional method on BOTH symbol presence and its cap bit: a shim may
  // omit the export outright, or export it while disclaiming full support.
  const hasCap = (name, bit) => typeof M['_ff_' + name] === 'function' && (caps & bit) !== 0;
  const canGc             = hasCap('gc_step', FF_CAP_GC);
  const canSectorClasses  = hasCap('sector_classes', FF_CAP_SECTOR_CLASSES);
  const canLiveMap        = hasCap('live_map', FF_CAP_LIVE_MAP);

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
    name: fsId,
    caps,
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

    /** One opportunistic GC step; returns the fffs_gc_action code, or null (no-op)
     *  when the driver doesn't advertise FF_CAP_GC / export ff_gc_step. */
    gcStep() { return canGc ? check(M._ff_gc_step(), 'gc') : null; },

    fsinfo() {
      return { files: M._ff_committed_files() >>> 0, bytes: M._ff_committed_bytes() >>> 0 };
    },

    /** Per-sector role: 0 erased, 1 live, 2 obsolete, 3 index, 4 other. Silent (no
     *  device traffic). Null when the driver doesn't advertise FF_CAP_SECTOR_CLASSES
     *  / export ff_sector_classes. */
    sectorClasses() {
      if (!canSectorClasses) return null;
      const p = M._malloc(sectorCount);
      try {
        if (M._ff_sector_classes(p) < 0) return null;
        return M.HEAPU8.slice(p, p + sectorCount);
      } finally { M._free(p); }
    },

    /** Per-page liveness (reachability walk): 0 erased, 1 metadata, 2 obsolete,
     *  3 live-data; drivers may emit higher classes (FAT+WL: 4 = metadata the
     *  WL FTL itself writes, 5 = slack — allocated but carrying no data,
     *  rendered blank per spec/ui.md). Values pass through unclamped — the viz
     *  layer degrades unknown classes to metadata rather than throwing.
     *  Silent. Null when the driver doesn't advertise FF_CAP_LIVE_MAP /
     *  export ff_live_map. */
    liveMap() {
      if (!canLiveMap) return null;
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
