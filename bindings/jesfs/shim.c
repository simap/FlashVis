/*
 * flashvis <-> JesFS binding shim.
 *
 * Exposes the same flat `ff_*` C API as bindings/fastffs/shim.c and
 * bindings/littlefs/shim.c (ADR-0011) so the console/runner can drive JesFS
 * interchangeably. JesFS speaks to the NOR chip at the SPI-opcode level; the
 * ported fake-SPI lower layer (jesfs_ll.c) decodes those opcodes into the three
 * JS HAL imports, so this shim only has to translate the uniform ABI onto
 * JesFS's fs_* high-level calls.
 *
 * JesFS is FLAT (no directories) and single-cursor per open descriptor:
 *   - ff_mkdir is a no-op success (ADR-0011).
 *   - ff_seek is EMULATED (rewind + forward re-read) exactly as ADR-0011
 *     sanctions and as the FASTFFS benchmark's JesFS adapter does; the extra
 *     re-read traffic is honest and gets visualized.
 *
 * Static allocation discipline (ADR-0013/0014): JesFS itself never mallocs
 * (its RAM is the single static `sflash_info`); the handle pools, per-file
 * descriptors and whole-file scratch here are all fixed static buffers.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "jesfs.h"
#include "jesfs_int.h"

/* g_quiet / g_density / g_sector_* / g_mounted are non-static: the fake-SPI
 * lower layer (jesfs_ll.c) and the liveness hook (jesfs_inspect.c) reach them
 * via extern. */
int g_quiet = 0;         /* when set, backend reads are silent (inspection) */
uint8_t g_density = 0x12;/* JEDEC density byte (log2 total bytes); 0x12 = 256 KiB */

/* ---- geometry (set by ff_config, before format/mount) ---- */
uint32_t g_sector_size  = 4096;
uint32_t g_sector_count = 64;
int      g_mounted      = 0;

/* JesFS return codes are negative on error, 0 on success (fs_read returns a
 * byte count >= 0). We surface them straight through the ABI, whose callers
 * (runner.js) treat any negative as failure. */
#define JESFS_OK 0

/* ---- fixed per-handle pools for the console file API (ADR-0014) ---- */
#define FF_MAX_FILES 8
#define FF_MAX_DIRS  4

static FS_DESC files[FF_MAX_FILES];
static uint8_t file_used[FF_MAX_FILES];
static uint8_t file_write[FF_MAX_FILES]; /* 1 if opened for write (seek unsupported) */
/* JesFS FS_DESC does not carry the filename back, so stash it at open time for
 * ff_file_stat (same approach the LittleFS shim uses). */
static char    file_names[FF_MAX_FILES][FNAMELEN + 1];

/* Streaming dir iterators over the flat namespace: each holds a cursor into the
 * JesFS file index (fs_info by number). */
static uint8_t  dir_used[FF_MAX_DIRS];
static uint16_t dir_cursor[FF_MAX_DIRS];

/* Copy the basename (text after the last '/', or the whole string) of `path`
 * into dst[dstcap], NUL-terminated and truncate-safe. JesFS is flat, but the
 * console may still hand us a slash-bearing name. */
static void store_name(char *dst, size_t dstcap, const char *path) {
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    size_t n = strlen(base);
    if (dstcap && n >= dstcap) n = dstcap - 1;
    memcpy(dst, base, n);
    if (dstcap) dst[n] = 0;
}

/* ---- exported API ---- */

/* Configure geometry before format/mount. Must match the JS device geometry.
 * JesFS derives total_flash_size solely from the RDID density byte, so we also
 * translate the geometry into that density (log2 of the total size) and keep it
 * consistent with what ff_config was handed. */
int ff_config(uint32_t sector_size, uint32_t sector_count, uint32_t program_granule) {
    (void)program_granule; /* JesFS programs in <=256 B page chunks; granule is a NOR-model detail */
    g_sector_size = sector_size;
    g_sector_count = sector_count;

    uint32_t total = sector_size * sector_count;
    uint8_t d = 0;
    while ((1u << d) < total && d < 31) d++;
    /* Clamp into JesFS's supported density window (jesfs_int.h). For the fixed
     * 256 KiB device this is exactly 0x12; the clamp only guards a future
     * geometry change and never silently rewrites the contracted 256 KiB. */
    if (d < MIN_DENSITY) d = MIN_DENSITY;
    if (d > MAX_DENSITY) d = MAX_DENSITY;
    g_density = d;
    return JESFS_OK;
}

/* FS_FORMAT_SOFT + FS_START_NORMAL mirror the FASTFFS benchmark's JesFS adapter
 * (JESFS_FORMAT_MODE / JESFS_START_MODE in benchmarks/esp32s3_jesfs/main/main.c).
 * SOFT erases only non-empty 4K sectors then writes the master header; on a
 * freshly reset (all-0xFF) device that means header-only, plus the honest
 * sector scan traffic. fs_format ends by re-running fs_start, so the FS is
 * mounted on return. */
int ff_format(void) {
    /* fs_format works against sflash_info.total_flash_size, which is only
     * populated once fs_start has read the flash's RDID density. On a blank
     * (unformatted) device fs_start returns -108 but still sets the size via
     * sflash_interpret_id, so prime it here and ignore that expected result —
     * JesFS's normal usage always tries fs_start before formatting. */
    (void)fs_start(FS_START_NORMAL);
    int rc = fs_format(FS_FORMAT_SOFT);
    g_mounted = (rc == JESFS_OK);
    return rc;
}

int ff_mount(void) {
    int rc = fs_start(FS_START_NORMAL);
    g_mounted = (rc == JESFS_OK);
    return rc;
}

void ff_unmount(void) {
    if (g_mounted) { (void)fs_deepsleep(); g_mounted = 0; }
}

/* Create-or-replace a whole file. SF_OPEN_CREATE deletes any existing version
 * and starts a fresh chain (JesFS's create semantics); fs_close writes the
 * length/CRC footer into the head sector. */
int ff_write(const char *name, const uint8_t *data, uint32_t len) {
    FS_DESC f;
    int rc = fs_open(&f, (char *)name, SF_OPEN_CREATE | SF_OPEN_WRITE);
    if (rc != JESFS_OK) return rc;
    rc = fs_write(&f, (uint8_t *)data, len);
    int rc_close = fs_close(&f);
    if (rc != JESFS_OK) return rc;
    return rc_close;
}

/* Read a whole file into out[cap]. Returns bytes read (>=0) or negative error. */
int ff_read(const char *name, uint8_t *out, uint32_t cap) {
    FS_DESC f;
    int rc = fs_open(&f, (char *)name, SF_OPEN_READ);
    if (rc != JESFS_OK) return rc;
    int32_t total = 0;
    while ((uint32_t)total < cap) {
        int32_t got = fs_read(&f, out + total, cap - (uint32_t)total);
        if (got < 0) { (void)fs_close(&f); return (int)got; }
        if (got == 0) break;
        total += got;
    }
    (void)fs_close(&f);
    return (int)total;
}

/* Open a pooled handle: mode 0='r' (READ), 1='w' (CREATE|WRITE, truncates).
 * Mode 2='a' (append) is unsupported on JesFS (no append flag; open-for-write
 * always starts a new chain) -> negative, like the FASTFFS shim. */
int ff_open(const char *name, int mode) {
    uint8_t flags;
    if (mode == 0) flags = SF_OPEN_READ;
    else if (mode == 1) flags = SF_OPEN_CREATE | SF_OPEN_WRITE;
    else return -125; /* illegal file flags */

    int h = -1;
    for (int i = 0; i < FF_MAX_FILES; i++) if (!file_used[i]) { h = i; break; }
    if (h < 0) return -117; /* no free descriptor */

    int rc = fs_open(&files[h], (char *)name, flags);
    if (rc != JESFS_OK) return rc;
    store_name(file_names[h], sizeof(file_names[h]), name);
    file_write[h] = (mode == 1);
    file_used[h] = 1;
    return h;
}

/* Fill out[0..n) from the handle's current position. fs_read already loops
 * across sector boundaries and caps at end-of-file (returns 0 at EOF). */
int ff_file_read(int h, uint8_t *out, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -117;
    int32_t got = fs_read(&files[h], out, n);
    return (int)got;
}

/* Write n bytes at the handle's current position (append-at-end; JesFS write is
 * strictly forward-appending within the open chain). Returns bytes written. */
int ff_file_write(int h, const uint8_t *data, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -117;
    int rc = fs_write(&files[h], (uint8_t *)data, n);
    return rc != JESFS_OK ? rc : (int)n;
}

/* Seek the handle; whence 0=set, 1=cur, 2=end. JesFS has no native seek, so we
 * EMULATE it exactly as ADR-0011 sanctions and as the FASTFFS benchmark's JesFS
 * adapter does: clamp the target into [0, file_len], rewind to the start when
 * seeking backward, then skip forward by re-reading (fs_read with a NULL sink).
 * The re-read is real device traffic and is meant to be visualized. Only valid
 * on read handles (fs_rewind refuses a write-open descriptor). Returns the new
 * absolute position. */
int ff_file_seek(int h, int32_t off, int whence) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -117;
    FS_DESC *f = &files[h];

    int64_t base;
    if (whence == 0) base = 0;
    else if (whence == 1) base = f->file_pos;
    else if (whence == 2) base = f->file_len;
    else return -139;

    int64_t target = base + off;
    if (target < 0 || target > (int64_t)f->file_len) return -105; /* out of range */

    if (target < (int64_t)f->file_pos) {
        int rc = fs_rewind(f);
        if (rc != JESFS_OK) return rc;
    }
    uint32_t delta = (uint32_t)target - f->file_pos;
    if (delta) {
        int32_t rc = fs_read(f, NULL, delta); /* NULL sink: advance without copying */
        if (rc < 0) return (int)rc;
        if ((uint32_t)rc != delta) return -105;
    }
    return (int)f->file_pos;
}

/* Stat the open handle; writes a NUL-terminated name into name_out[cap]. The
 * name is the one captured at ff_open (JesFS descriptors don't carry it back).
 * Returns size (>=0) or negative error. */
int ff_file_stat(int h, char *name_out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -117;
    uint32_t size = files[h].file_len;
    if (size == 0xFFFFFFFFu) size = files[h].file_pos; /* unclosed: use bytes so far */
    size_t n = strlen(file_names[h]);
    if (cap && n >= cap) n = cap - 1;
    memcpy(name_out, file_names[h], n);
    if (cap) name_out[n] = 0;
    return (int)size;
}

/* Close and free the slot. For write handles fs_close writes the file footer;
 * for read handles it just invalidates the descriptor. */
int ff_file_close(int h) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -117;
    int rc = fs_close(&files[h]);
    file_used[h] = 0;
    return rc;
}

/* Delete by name: JesFS deletes through an open (read) descriptor, marking the
 * head + data sectors deleted/todelete (mirrors the benchmark adapter). */
int ff_delete(const char *name) {
    FS_DESC f;
    int rc = fs_open(&f, (char *)name, SF_OPEN_READ);
    if (rc != JESFS_OK) return rc;
    return fs_delete(&f);
}

/* Exists: fs_notexists opens the file read-only (no device writes) and returns
 * 0 when present. Map to 1/0; a genuine error (not "-124 not found") passes
 * through negative. */
int ff_exists(const char *name) {
    int rc = fs_notexists((char *)name);
    if (rc == JESFS_OK) return 1;
    if (rc == -124) return 0; /* file not found */
    return rc;
}

/* Stat a file by name; NUL-terminated name into name_out[cap]. Returns size
 * (>=0), -1 if not found (so JS returns null), or another negative error. */
int ff_stat(const char *name, char *name_out, uint32_t cap) {
    FS_DESC f;
    int rc = fs_open(&f, (char *)name, SF_OPEN_READ);
    if (rc == -124) return -1; /* not found */
    if (rc != JESFS_OK) return rc;
    uint32_t size = f.file_len;
    (void)fs_close(&f);
    store_name(name_out, cap, name);
    return (int)size;
}

/* Flat namespace: no directories to create, always succeeds (ADR-0011). */
int ff_mkdir(const char *name) {
    (void)name;
    return JESFS_OK;
}

/* Walk the JesFS file index (fs_info by number) and emit "name\tsize\n" for
 * every ACTIVE file into out[cap]. Shared shape with ff_dir_read below. */
int ff_list(char *out, uint32_t cap) {
    FS_STAT st;
    uint32_t n = 0;
    uint16_t limit = (uint16_t)(sflash_info.files_used + 1u);
    for (uint16_t i = 0; i < limit && n < cap; i++) {
        int rc = fs_info(&st, i);
        if (rc == FS_STAT_INDEX) break;
        if (rc < 0) return rc;
        if (!(rc & FS_STAT_ACTIVE)) continue;
        uint32_t size = (st.file_len == 0xFFFFFFFFu) ? 0 : st.file_len;
        int w = snprintf(out + n, cap - n, "%s\t%u\n", st.fname, (unsigned)size);
        if (w < 0 || (uint32_t)w >= cap - n) break;
        n += (uint32_t)w;
    }
    return (int)n;
}

/* Streaming directory iterator over the flat namespace. `prefix` is ignored
 * (JesFS has no directories); each handle carries a cursor into the file index. */
int ff_dir_open(const char *prefix) {
    (void)prefix;
    int h = -1;
    for (int i = 0; i < FF_MAX_DIRS; i++) if (!dir_used[i]) { h = i; break; }
    if (h < 0) return -117;
    dir_cursor[h] = 0;
    dir_used[h] = 1;
    return h;
}

/* One entry: name -> out[cap]; returns size (>=0), -1 at end, -2 error/closed.
 * Advances the cursor past deleted/unused index slots to the next ACTIVE file. */
int ff_dir_read(int h, char *out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return -2;
    FS_STAT st;
    uint16_t limit = (uint16_t)(sflash_info.files_used + 1u);
    while (dir_cursor[h] < limit) {
        uint16_t i = dir_cursor[h]++;
        int rc = fs_info(&st, i);
        if (rc == FS_STAT_INDEX) break;
        if (rc < 0) return -2;
        if (!(rc & FS_STAT_ACTIVE)) continue;
        size_t n = strlen(st.fname);
        if (cap && n >= cap) n = cap - 1;
        memcpy(out, st.fname, n);
        if (cap) out[n] = 0;
        return (int)((st.file_len == 0xFFFFFFFFu) ? 0 : st.file_len);
    }
    return -1;
}

void ff_dir_close(int h) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return;
    dir_used[h] = 0;
}

/* No-op: JesFS advertises NO FF_CAP_GC (see ff_caps), so this is never called.
 * JesFS has no incremental, churn-safe GC primitive: reclamation is inline in
 * the allocator (sflash_get_free_sector erases a 'todelete' sector just-in-time
 * when it needs a fresh one during fs_open/fs_write), never a standalone bounded
 * step. Per ADR-0021 a filesystem without such a primitive must not advertise
 * FF_CAP_GC; the symbol stays for ABI uniformity but does nothing. */
int ff_gc_step(void) {
    return 0;
}

/* Silent walk of the file index summing ACTIVE files and their bytes, so
 * ff_committed_files/bytes report a consistent snapshot without device traffic
 * (g_quiet, mirroring the LittleFS shim). */
struct commit_acc { uint32_t files; uint32_t bytes; };

static struct commit_acc committed_walk(void) {
    struct commit_acc acc = { 0, 0 };
    if (!g_mounted) return acc;
    g_quiet = 1;
    FS_STAT st;
    uint16_t limit = (uint16_t)(sflash_info.files_used + 1u);
    for (uint16_t i = 0; i < limit; i++) {
        int rc = fs_info(&st, i);
        if (rc == FS_STAT_INDEX || rc < 0) break;
        if (!(rc & FS_STAT_ACTIVE)) continue;
        acc.files++;
        if (st.file_len != 0xFFFFFFFFu) acc.bytes += st.file_len;
    }
    g_quiet = 0;
    return acc;
}

uint32_t ff_committed_files(void) { return committed_walk().files; }
uint32_t ff_committed_bytes(void) { return committed_walk().bytes; }

/* ---- ADR-0011: uniform FS-driver ABI — version + capability advertisement ---- */
#define FF_CAP_GC              (1u << 0)
#define FF_CAP_SECTOR_CLASSES  (1u << 1)
#define FF_CAP_LIVE_MAP        (1u << 2)
#define FF_CAP_APPEND          (1u << 3)

uint32_t ff_abi_version(void) { return 1; }

/* LIVE_MAP only. GC is OFF (no incremental churn-safe primitive; ADR-0021 — see
 * ff_gc_step). APPEND is OFF (JesFS open-for-write always truncates; no append
 * flag). SECTOR_CLASSES is OFF; the per-page live map (jesfs_inspect.c) is the
 * driver's coloring, same as LittleFS. */
uint32_t ff_caps(void) { return FF_CAP_LIVE_MAP; }
