/*
 * The emulated NOR flash chip — the single source of truth for flash bytes.
 *
 * A WASM filesystem imports the three HAL functions (build/flash_hal.js binds
 * them to read/prog/erase here). Every operation enforces NOR semantics, carries
 * a simulated flash-time cost, and emits an event the visualizer plays back.
 *
 * Timing is the ESP32-S3 measured preset from FASTFFS (verify_flash.c):
 *   read    64522 + 120·bytes ns   (~0.1 ms / 256 B)
 *   program 5937·bytes ns          (~1.5 ms / 256 B page)
 *   erase   21_269_000 ns / sector (~21 ms — the expensive op)
 */
const ESP32S3 = {
  readFixed: 64522, readPer: 120,
  progFixed: 0, progPer: 5937,
  eraseFixed: 21269000, erasePer: 0,
};

export function createNorDevice(opts = {}) {
  const sectorSize  = opts.sectorSize  ?? 4096;
  const sectorCount = opts.sectorCount ?? 64;
  const pageSize    = opts.pageSize    ?? 256;
  const T = opts.timing ?? ESP32S3;
  const size = sectorSize * sectorCount;

  const flash = new Uint8Array(size).fill(0xff); // erased NOR reads as 0xFF
  const wear  = new Uint32Array(sectorCount);    // erase cycles per sector
  const stats = { reads: 0, programs: 0, erases: 0, readBytes: 0, programBytes: 0, simNs: 0 };
  const listeners = [];
  let mod = null; // the emscripten Module, for access to its WASM heap

  const emit = (ev) => { for (const fn of listeners) fn(ev); };

  return {
    flash, wear, stats, size, sectorSize, sectorCount, pageSize, timing: T,

    attach(m) { mod = m; },
    onEvent(fn) {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },

    reset() {
      flash.fill(0xff);
      wear.fill(0);
      for (const k in stats) stats[k] = 0;
      emit({ op: 'reset' });
    },

    /** Copy flash[off .. off+len) into the WASM heap at `dst`. Reads don't wear NOR. */
    read(off, dst, len) {
      mod.HEAPU8.set(flash.subarray(off, off + len), dst);
      const ns = T.readFixed + T.readPer * len;
      stats.reads++; stats.readBytes += len; stats.simNs += ns;
      emit({ op: 'read', off, len, ns });
      return 0;
    },

    /** Like read(), but silent: no event, no stats, no time — for inspection walks. */
    readQuiet(off, dst, len) {
      mod.HEAPU8.set(flash.subarray(off, off + len), dst);
      return 0;
    },

    /**
     * Program `len` bytes from WASM heap `src`. Faithful NOR: a program can only
     * clear bits (1→0), so we AND — identical to the reference lfs_emubd, which
     * FASTFFS relies on for in-place monotonic bit-clearing (footers, commits).
     *
     * Because programming physically cannot set a bit to 1, there is no "NOR
     * violation" to detect here — an earlier metric that flagged it was wrong and
     * was removed. Don't re-add it, and don't emit a `violations` field.
     */
    prog(off, src, len) {
      const heap = mod.HEAPU8;
      for (let i = 0; i < len; i++) flash[off + i] &= heap[src + i];
      const ns = T.progFixed + T.progPer * len;
      stats.programs++; stats.programBytes += len; stats.simNs += ns;
      emit({ op: 'prog', off, len, ns });
      return 0;
    },

    /** Erase every sector intersecting [off, off+len) back to 0xFF; bump wear. */
    erase(off, len) {
      const first = Math.floor(off / sectorSize);
      const last  = Math.floor((off + len - 1) / sectorSize);
      for (let s = first; s <= last; s++) {
        flash.fill(0xff, s * sectorSize, (s + 1) * sectorSize);
        wear[s]++; stats.erases++;
        const ns = T.eraseFixed + T.erasePer * sectorSize;
        stats.simNs += ns;
        emit({ op: 'erase', sector: s, off: s * sectorSize, len: sectorSize, ns });
      }
      return 0;
    },
  };
}
