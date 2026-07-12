/*
 * flashvis ↔ LittleFS binding shim.
 *
 * Implements the `struct lfs_config` HAL whose read/prog/erase forward to
 * three JS imports (resolved by build/flash_hal.js → web/src/device.js), and
 * exposes the same flat `ff_*` C API as bindings/fastffs/shim.c so the
 * console/runner can drive either filesystem interchangeably (ADR-0011).
 *
 * Built with -DLFS_NO_MALLOC (ADR-0013 fixed-heap discipline): littlefs never
 * calls malloc, so every open file, the read/prog/lookahead caches, and the
 * handle pools below are static, caller-owned buffers sized at compile time.
 * That means lfs_file_open() is compiled out — this shim always uses
 * lfs_file_opencfg() with a per-file static buffer.
 */
#include "lfs.h"

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

/* ---- imports: the emulated NOR chip lives in JS (device.js) ---- */
extern int js_flash_read(uint32_t off, void *buffer, uint32_t size);
extern int js_flash_prog(uint32_t off, const void *buffer, uint32_t size);
extern int js_flash_erase(uint32_t off, uint32_t size);
extern int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

/* g_quiet / g_lfs / g_mounted / g_sector_* are non-static: the liveness hook in
 * lfs_inspect.c (compiled as a separate TU, ADR-0012) reaches them via extern. */
int g_quiet = 0; /* when set, backend reads are silent (used for inspection) */

/* ---- geometry (set by ff_config, before format/mount) ---- */
uint32_t g_sector_size     = 4096;
uint32_t g_sector_count    = 64;
static uint32_t g_program_granule = 1;

/* Benchmark-parity sizes. The FASTFFS ESP32-S3 LittleFS benchmark ran the
 * joltwallet/esp_littlefs IDF component (benchmarks/esp32s3_littlefs/main/
 * idf_component.yml, "joltwallet/littlefs") with zero CONFIG_LITTLEFS_*
 * overrides in sdkconfig.defaults, so its effective lfs_config was the
 * component's Kconfig defaults, which esp_littlefs.c copies verbatim:
 *   LITTLEFS_READ_SIZE=128  LITTLEFS_WRITE_SIZE=128  LITTLEFS_CACHE_SIZE=512
 *   LITTLEFS_LOOKAHEAD_SIZE=128  LITTLEFS_BLOCK_CYCLES=512
 * (corroborated by fs/fastffs/existing_flash_filesystems_research.md, which
 * lists the same values plus the 1,152 B read/prog/lookahead buffer total =
 * 512+512+128). Mirrored here so flashvis shows the traffic that was
 * benchmarked: 128 B read/program granularity, 512 B caches. cache_size=512
 * is a factor of the 4096 block size and a multiple of prog/read size (128);
 * lookahead 128 B maps 1024 blocks, comfortably covering any geometry here. */
#define LFS_READ_SIZE       128
#define LFS_PROG_SIZE       128
#define LFS_CACHE_SIZE      512
#define LFS_LOOKAHEAD_SIZE  128
#define LFS_BLOCK_CYCLES    512

/* ---- backend callbacks (littlefs core → JS chip): block+off → absolute byte offset ---- */
static int be_read(const struct lfs_config *c, lfs_block_t block,
        lfs_off_t off, void *buffer, lfs_size_t size) {
    (void)c;
    uint32_t abs = block * g_sector_size + off;
    int rc = g_quiet ? js_flash_read_quiet(abs, buffer, size)
                     : js_flash_read(abs, buffer, size);
    return rc ? LFS_ERR_IO : LFS_ERR_OK;
}
static int be_prog(const struct lfs_config *c, lfs_block_t block,
        lfs_off_t off, const void *buffer, lfs_size_t size) {
    (void)c;
    uint32_t abs = block * g_sector_size + off;
    return js_flash_prog(abs, buffer, size) ? LFS_ERR_IO : LFS_ERR_OK;
}
static int be_erase(const struct lfs_config *c, lfs_block_t block) {
    (void)c;
    return js_flash_erase(block * g_sector_size, g_sector_size) ? LFS_ERR_IO : LFS_ERR_OK;
}
static int be_sync(const struct lfs_config *c) {
    (void)c;
    return LFS_ERR_OK; /* the JS chip has no write buffering to flush */
}

/* ---- caller-owned filesystem state (LFS_NO_MALLOC: every buffer is static) ---- */
lfs_t                     g_lfs;
static struct lfs_config  g_cfg;
int                       g_mounted = 0;

static uint8_t g_read_buffer[LFS_CACHE_SIZE];
static uint8_t g_prog_buffer[LFS_CACHE_SIZE];
static uint8_t g_lookahead_buffer[LFS_LOOKAHEAD_SIZE];

/* Fixed per-handle pools for the console's file/dir API (ADR-0014): no
 * malloc, a used-bitmap per pool, indices returned to JS as small integer
 * handles. Pool reuse must close a slot before freeing it. Each pooled file
 * gets its own static lfs_file_config cache buffer (required by
 * lfs_file_opencfg under LFS_NO_MALLOC). */
#define FF_MAX_FILES 8
#define FF_MAX_DIRS  4

static lfs_file_t              files[FF_MAX_FILES];
static struct lfs_file_config  file_cfgs[FF_MAX_FILES];
static uint8_t                 file_bufs[FF_MAX_FILES][LFS_CACHE_SIZE];
static uint8_t                 file_used[FF_MAX_FILES];
/* littlefs file handles don't carry their own path/name back (unlike
 * fastffs's fffs_file), so ff_file_stat needs a name to report: stash the
 * basename at open time. */
static char file_names[FF_MAX_FILES][LFS_NAME_MAX + 1];

static lfs_dir_t dirs[FF_MAX_DIRS];
static uint8_t   dir_used[FF_MAX_DIRS];

/* Reset g_cfg to the current geometry. The struct must be zeroed for
 * defaults (per lfs.h) and re-applied before every format/mount in case
 * ff_config changed geometry since the last call. */
static void cfg_init(void) {
    memset(&g_cfg, 0, sizeof(g_cfg));
    g_cfg.context = NULL;
    g_cfg.read  = be_read;
    g_cfg.prog  = be_prog;
    g_cfg.erase = be_erase;
    g_cfg.sync  = be_sync;

    /* Benchmark parity (see LFS_* above): reads and programs happen in 128 B
     * units even though the NOR device is byte-addressable — that is what the
     * benchmarked joltwallet build did, and littlefs pads commits to prog_size,
     * so this affects the on-disk layout, not just traffic shape. The ABI's
     * program_granule is still honored when it demands MORE than 128 (a device
     * whose program unit is coarser than the benchmark's must win over parity);
     * granules <= 128, including the default 1, get the benchmark's 128. */
    g_cfg.read_size  = LFS_READ_SIZE;
    g_cfg.prog_size  = g_program_granule > LFS_PROG_SIZE ? g_program_granule
                                                         : LFS_PROG_SIZE;
    g_cfg.block_size = g_sector_size;
    g_cfg.block_count = g_sector_count;
    g_cfg.block_cycles = LFS_BLOCK_CYCLES;

    g_cfg.cache_size = LFS_CACHE_SIZE;
    g_cfg.lookahead_size = LFS_LOOKAHEAD_SIZE;
    g_cfg.read_buffer = g_read_buffer;
    g_cfg.prog_buffer = g_prog_buffer;
    g_cfg.lookahead_buffer = g_lookahead_buffer;
}

/* Copy the basename (text after the last '/', or the whole string) of `path`
 * into dst[dstcap], NUL-terminated and truncate-safe. */
static void store_basename(char *dst, size_t dstcap, const char *path) {
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    size_t n = strlen(base);
    if (dstcap && n >= dstcap) n = dstcap - 1;
    memcpy(dst, base, n);
    if (dstcap) dst[n] = 0;
}

/* ---- exported API ---- */

/* Configure geometry before format/mount. Must match the JS device geometry. */
int ff_config(uint32_t sector_size, uint32_t sector_count, uint32_t program_granule) {
    g_sector_size = sector_size;
    g_sector_count = sector_count;
    g_program_granule = program_granule ? program_granule : 1;
    cfg_init();
    return LFS_ERR_OK;
}

int ff_format(void) {
    cfg_init();
    return lfs_format(&g_lfs, &g_cfg);
}

int ff_mount(void) {
    cfg_init();
    int rc = lfs_mount(&g_lfs, &g_cfg);
    g_mounted = (rc == LFS_ERR_OK);
    return rc;
}

void ff_unmount(void) {
    if (g_mounted) { lfs_unmount(&g_lfs); g_mounted = 0; }
}

/* Create-or-replace a whole file. Uses its own static cache buffer (distinct
 * from the pooled handles') since whole-file ops don't hold a pool slot. */
int ff_write(const char *name, const uint8_t *data, uint32_t len) {
    static uint8_t buf[LFS_CACHE_SIZE];
    struct lfs_file_config fc;
    memset(&fc, 0, sizeof(fc));
    fc.buffer = buf;

    lfs_file_t f;
    int rc = lfs_file_opencfg(&g_lfs, &f, name,
            LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC, &fc);
    if (rc != LFS_ERR_OK) return rc;
    lfs_ssize_t wrc = lfs_file_write(&g_lfs, &f, data, len);
    int rc_close = lfs_file_close(&g_lfs, &f);
    if (wrc < 0) return (int)wrc;
    return rc_close != LFS_ERR_OK ? rc_close : LFS_ERR_OK;
}

/* Read a whole file into out[cap]. Returns bytes read (>=0) or negative error. */
int ff_read(const char *name, uint8_t *out, uint32_t cap) {
    static uint8_t buf[LFS_CACHE_SIZE];
    struct lfs_file_config fc;
    memset(&fc, 0, sizeof(fc));
    fc.buffer = buf;

    lfs_file_t f;
    int rc = lfs_file_opencfg(&g_lfs, &f, name, LFS_O_RDONLY, &fc);
    if (rc != LFS_ERR_OK) return rc;
    size_t total = 0;
    while (total < cap) {
        lfs_ssize_t got = lfs_file_read(&g_lfs, &f, out + total, cap - total);
        if (got < 0) { lfs_file_close(&g_lfs, &f); return (int)got; }
        if (got == 0) break;
        total += (size_t)got;
    }
    lfs_file_close(&g_lfs, &f);
    return (int)total;
}

/* Open a pooled handle: mode 0='r' (RDONLY), 1='w' (WRONLY|CREAT|TRUNC),
 * 2='a' (WRONLY|CREAT|APPEND — littlefs supports append, unlike FASTFFS).
 * Returns handle >=0, or negative on bad mode / pool exhaustion / open error. */
int ff_open(const char *name, int mode) {
    int flags;
    if (mode == 0) flags = LFS_O_RDONLY;
    else if (mode == 1) flags = LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC;
    else if (mode == 2) flags = LFS_O_WRONLY | LFS_O_CREAT | LFS_O_APPEND;
    else return LFS_ERR_INVAL;

    int h = -1;
    for (int i = 0; i < FF_MAX_FILES; i++) if (!file_used[i]) { h = i; break; }
    if (h < 0) return LFS_ERR_NOMEM;

    memset(&file_cfgs[h], 0, sizeof(file_cfgs[h]));
    file_cfgs[h].buffer = file_bufs[h];
    int rc = lfs_file_opencfg(&g_lfs, &files[h], name, flags, &file_cfgs[h]);
    if (rc != LFS_ERR_OK) return rc;
    store_basename(file_names[h], sizeof(file_names[h]), name);
    file_used[h] = 1;
    return h;
}

/* Fill out[0..n) from the handle's current position, looping lfs_file_read to
 * ride out short reads (mirrors ff_read's fill loop, but positioned).
 * Returns bytes read (>=0, 0=EOF) or negative error. */
int ff_file_read(int h, uint8_t *out, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return LFS_ERR_INVAL;
    size_t total = 0;
    while (total < n) {
        lfs_ssize_t got = lfs_file_read(&g_lfs, &files[h], out + total, n - total);
        if (got < 0) return (int)got;
        if (got == 0) break;
        total += (size_t)got;
    }
    return (int)total;
}

/* Write n bytes at the handle's current position. Returns bytes written or
 * negative error. */
int ff_file_write(int h, const uint8_t *data, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return LFS_ERR_INVAL;
    lfs_ssize_t wrc = lfs_file_write(&g_lfs, &files[h], data, n);
    return (int)wrc;
}

/* Seek the handle; whence 0=set, 1=cur, 2=end (littlefs's LFS_SEEK_* map
 * 1:1). Returns the new absolute position (>=0) or negative error. */
int ff_file_seek(int h, int32_t off, int whence) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return LFS_ERR_INVAL;
    lfs_soff_t pos = lfs_file_seek(&g_lfs, &files[h], off, whence);
    return (int)pos;
}

/* Stat the open handle; writes a NUL-terminated name into name_out[cap]
 * (truncated safely, same convention as ff_dir_read). The name is the
 * basename captured at ff_open time (littlefs file handles don't carry it).
 * Returns size (>=0) or negative error. */
int ff_file_stat(int h, char *name_out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return LFS_ERR_INVAL;
    lfs_soff_t size = lfs_file_size(&g_lfs, &files[h]);
    if (size < 0) return (int)size;
    size_t n = strlen(file_names[h]);
    if (cap && n >= cap) n = cap - 1;
    memcpy(name_out, file_names[h], n);
    if (cap) name_out[n] = 0;
    return (int)size;
}

/* Close and free the slot. Uncommitted writes live in the handle until close,
 * so close happens before the slot is freed. Double-close is a bounds-checked
 * error, not UB. */
int ff_file_close(int h) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return LFS_ERR_INVAL;
    int rc = lfs_file_close(&g_lfs, &files[h]);
    file_used[h] = 0;
    return rc;
}

int ff_delete(const char *name) { return lfs_remove(&g_lfs, name); }

int ff_exists(const char *name) {
    struct lfs_info info;
    int rc = lfs_stat(&g_lfs, name, &info);
    if (rc == LFS_ERR_NOENT) return 0;
    if (rc != LFS_ERR_OK) return rc;
    return 1;
}

/* Stat a file by name; writes a NUL-terminated name into name_out[cap]
 * (truncated safely). Returns size (>=0), -1 if not found (so JS can return
 * null), or another negative error. */
int ff_stat(const char *name, char *name_out, uint32_t cap) {
    struct lfs_info info;
    int rc = lfs_stat(&g_lfs, name, &info);
    if (rc == LFS_ERR_NOENT) return -1;
    if (rc != LFS_ERR_OK) return rc;
    size_t n = strlen(info.name);
    if (cap && n >= cap) n = cap - 1;
    memcpy(name_out, info.name, n);
    if (cap) name_out[n] = 0;
    return (int)info.size;
}

/* Real directory here (unlike FASTFFS's flat namespace): create it, treating
 * "already exists" as success so repeated calls are idempotent. */
int ff_mkdir(const char *name) {
    int rc = lfs_mkdir(&g_lfs, name);
    return rc == LFS_ERR_EXIST ? LFS_ERR_OK : rc;
}

/* Emit "name\tsize\n" lines for REG entries of the root dir "/" into
 * out[cap]. Returns bytes written or neg error. */
int ff_list(char *out, uint32_t cap) {
    lfs_dir_t d;
    int rc = lfs_dir_open(&g_lfs, &d, "/");
    if (rc != LFS_ERR_OK) return rc;
    struct lfs_info info;
    uint32_t n = 0;
    int drc = 0;
    while (n < cap && (drc = lfs_dir_read(&g_lfs, &d, &info)) > 0) {
        if (info.type != LFS_TYPE_REG) continue; /* skip subdirs, "." and ".." */
        int w = snprintf(out + n, cap - n, "%s\t%u\n", info.name, (unsigned)info.size);
        if (w < 0 || (uint32_t)w >= cap - n) break;
        n += (uint32_t)w;
    }
    lfs_dir_close(&g_lfs, &d);
    if (drc < 0) return drc;
    return (int)n;
}

/* Streaming directory iterator: each ff_dir_read is one lfs_dir_read, so the
 * caller can pace/animate the listing entry by entry. Pool-based (FF_MAX_DIRS)
 * so more than one prefix scan can be open at once. `prefix` is treated as a
 * directory path; empty/NULL means the root. */
int ff_dir_open(const char *prefix) {
    int h = -1;
    for (int i = 0; i < FF_MAX_DIRS; i++) if (!dir_used[i]) { h = i; break; }
    if (h < 0) return LFS_ERR_NOMEM;

    const char *path = (prefix && prefix[0]) ? prefix : "/";
    int rc = lfs_dir_open(&g_lfs, &dirs[h], path);
    if (rc != LFS_ERR_OK) return rc;
    dir_used[h] = 1;
    return h;
}

/* One entry: name → out[cap]; returns size (>=0), -1 at end, -2 error/closed.
 * REG files only — subdirectories and "."/".." are silently skipped (ADR-0014
 * accepted single-level divergence from a real recursive listing). */
int ff_dir_read(int h, char *out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return -2;
    struct lfs_info info;
    int rc;
    while ((rc = lfs_dir_read(&g_lfs, &dirs[h], &info)) > 0) {
        if (info.type != LFS_TYPE_REG) continue;
        size_t n = strlen(info.name);
        if (cap && n >= cap) n = cap - 1;
        memcpy(out, info.name, n);
        if (cap) out[n] = 0;
        return (int)info.size;
    }
    return rc == LFS_ERR_OK ? -1 : -2;
}

void ff_dir_close(int h) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return;
    lfs_dir_close(&g_lfs, &dirs[h]);
    dir_used[h] = 0;
}

/* No-op: littlefs does NOT model a GC step (GC capability is off; see ff_caps).
 * Its native lfs_fs_gc() is, per upstream, an idle-loop hint ("Calling lfs_fs_gc
 * in your idle loop should move high latency tasks there as much as is currently
 * possible"), and crucially it is NOT incremental: with no progress guard, every
 * call redoes the whole mkconsistent + metadata-compact + allocator scan, burning
 * hundreds of ms and thousands of reads each time, doing the same work over and
 * over. FASTFFS's gc, by contrast, is a state machine that makes the smallest
 * unit of progress per call, which is why churning it at ~gcRatio speeds FASTFFS
 * up; doing the same to lfs_fs_gc just repeats one expensive scan. littlefs is
 * copy-on-write and reclaims space inline during writes anyway, so there is no GC
 * pass to model. The ABI symbol stays for uniformity but does nothing, and the
 * runner also gates on FF_CAP_GC so it is never called. */
int ff_gc_step(void) {
    return 0;
}

/* Recursive silent walk from "/", counting REG files and summing their sizes.
 * Shared by ff_committed_files/ff_committed_bytes so both report a
 * consistent snapshot; g_quiet keeps the walk off the device-traffic log. */
struct walk_acc { uint32_t files; uint32_t bytes; };

static int walk_dir(const char *path, struct walk_acc *acc) {
    lfs_dir_t d;
    int rc = lfs_dir_open(&g_lfs, &d, path);
    if (rc != LFS_ERR_OK) return rc;

    struct lfs_info info;
    while ((rc = lfs_dir_read(&g_lfs, &d, &info)) > 0) {
        if (info.type == LFS_TYPE_REG) {
            acc->files++;
            acc->bytes += info.size;
        } else if (info.type == LFS_TYPE_DIR) {
            if (strcmp(info.name, ".") == 0 || strcmp(info.name, "..") == 0) continue;
            char child[512];
            size_t plen = strlen(path);
            int is_root = (plen == 1 && path[0] == '/');
            snprintf(child, sizeof(child), "%s%s%s", path, is_root ? "" : "/", info.name);
            int crc = walk_dir(child, acc);
            if (crc != LFS_ERR_OK) { lfs_dir_close(&g_lfs, &d); return crc; }
        }
    }
    lfs_dir_close(&g_lfs, &d);
    return rc < 0 ? rc : LFS_ERR_OK;
}

static struct walk_acc committed_walk(void) {
    struct walk_acc acc = { 0, 0 };
    if (!g_mounted) return acc;
    g_quiet = 1;
    walk_dir("/", &acc);
    g_quiet = 0;
    return acc;
}

uint32_t ff_committed_files(void) { return committed_walk().files; }
uint32_t ff_committed_bytes(void) { return committed_walk().bytes; }

/* ADR-0011: shim identity/capability discovery. */
#define FF_CAP_GC              (1u << 0)
#define FF_CAP_SECTOR_CLASSES  (1u << 1)
#define FF_CAP_LIVE_MAP        (1u << 2)
#define FF_CAP_APPEND          (1u << 3)

uint32_t ff_abi_version(void) { return 1; }
/* APPEND|LIVE_MAP. GC is deliberately OFF: littlefs is copy-on-write with no
 * log-structured GC pass to model as a churn step, and its lfs_fs_gc() is a
 * non-incremental idle-loop hint (see ff_gc_step) that repeats a full expensive
 * scan on every call, so advertising GC here made the churn model burn hundreds
 * of ms and thousands of reads every gc step. LIVE_MAP is on via the native hook
 * in lfs_inspect.c (ADR-0012); SECTOR_CLASSES stays off, since the per-page live
 * map is the driver's coloring. */
uint32_t ff_caps(void) { return FF_CAP_APPEND | FF_CAP_LIVE_MAP; }
