/*
 * flashvis ↔ FASTFFS binding shim.
 *
 * Implements a `struct fffs_backend` whose read/program/erase forward to three
 * JS imports (resolved by build/flash_hal.js → web/src/device.js), and exposes a
 * small, flat C API to WASM for the playground. The filesystem core is entirely
 * caller-owned, so all of its RAM lives here as static buffers.
 */
#include "fastffs/fastffs.h"
#include "fastffs/fastffs_inspect.h"
#include "fffs_internal.h"   /* sector footer decode + lifecycle (build adds -I fs/fastffs/src) */

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

/* ---- imports: the emulated NOR chip lives in JS (device.js) ---- */
extern int js_flash_read(uint32_t off, void *buffer, uint32_t size);
extern int js_flash_prog(uint32_t off, const void *buffer, uint32_t size);
extern int js_flash_erase(uint32_t off, uint32_t size);
extern int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

static int g_quiet = 0; /* when set, backend reads are silent (used for inspection) */

/* ---- backend callbacks (FASTFFS core → JS chip) ---- */
static int be_read(void *ctx, size_t off, void *buf, size_t size) {
    (void)ctx;
    int rc = g_quiet ? js_flash_read_quiet((uint32_t)off, buf, (uint32_t)size)
                     : js_flash_read((uint32_t)off, buf, (uint32_t)size);
    return rc ? FFFS_ERR_IO : FFFS_OK;
}
static int be_program(void *ctx, size_t off, const void *buf, size_t size) {
    (void)ctx;
    return js_flash_prog((uint32_t)off, buf, (uint32_t)size) ? FFFS_ERR_IO : FFFS_OK;
}
static int be_erase(void *ctx, size_t off, size_t size) {
    (void)ctx;
    return js_flash_erase((uint32_t)off, (uint32_t)size) ? FFFS_ERR_IO : FFFS_OK;
}

/* ---- caller-owned filesystem state (sized per fffs_opts.h) ---- */
static struct fffs         g_fs;
static struct fffs_backend g_be;
static uint8_t  g_index_cache[FFFS_INDEX_CACHE_BYTES(FFFS_INDEX_HASH_TABLE_SIZE)];
static uint8_t  g_scratch[4096];
static uint32_t g_alloc_map[2048];
static int      g_mounted = 0;

static size_t g_sector_size    = 4096;
static size_t g_sector_count   = 64;
static size_t g_program_granule = 1;

static void be_init(void) {
    g_be.ctx = &g_fs;   /* opaque device handle; must be non-NULL, callbacks ignore it */
    g_be.size = g_sector_size * g_sector_count;
    g_be.read_granule = 1;                 /* NOR reads are byte-addressable */
    g_be.program_granule = g_program_granule;
    g_be.read = be_read;
    g_be.program = be_program;
    g_be.erase = be_erase;
}

/* ---- exported API ---- */

/* Configure geometry before format/mount. Must match the JS device geometry. */
int ff_config(uint32_t sector_size, uint32_t sector_count, uint32_t program_granule) {
    g_sector_size = sector_size;
    g_sector_count = sector_count;
    g_program_granule = program_granule ? program_granule : 1;
    be_init();
    return FFFS_OK;
}

int ff_format(void) {
    be_init();
    return fffs_format(&g_be, &(struct fffs_format_options){
        .index_sectors = FFFS_DEFAULT_INDEX_SECTORS,
        .sector_size = (enum fffs_sector_size)g_sector_size,
    });
}

int ff_mount(void) {
    be_init();
    int rc = fffs_mount(&g_fs, &g_be, &(struct fffs_mount_options){
        .index_cache = g_index_cache,
        .index_cache_size = sizeof(g_index_cache),
        .index_hash_table_size = FFFS_INDEX_HASH_TABLE_SIZE,
        .scratch = g_scratch,
        .scratch_size = sizeof(g_scratch),
        .alloc_map = g_alloc_map,
        .alloc_map_words = sizeof(g_alloc_map) / sizeof(g_alloc_map[0]),
    });
    g_mounted = (rc == FFFS_OK);
    return rc;
}

void ff_unmount(void) {
    if (g_mounted) { fffs_unmount(&g_fs); g_mounted = 0; }
}

/* Create-or-replace a whole file. */
int ff_write(const char *name, const uint8_t *data, uint32_t len) {
    struct fffs_file f;
    int rc = fffs_open(&g_fs, &f, name,
            FFFS_O_WRONLY | FFFS_O_CREATE | FFFS_O_TRUNC);
    if (rc != FFFS_OK) return rc;
    rc = fffs_write(&f, data, len);
    int rc_close = fffs_close(&f);
    return rc != FFFS_OK ? rc : rc_close;
}

/* Read a whole file into out[cap]. Returns bytes read (>=0) or negative error. */
int ff_read(const char *name, uint8_t *out, uint32_t cap) {
    struct fffs_file f;
    int rc = fffs_open(&g_fs, &f, name, FFFS_O_RDONLY);
    if (rc != FFFS_OK) return rc;
    size_t total = 0;
    while (total < cap) {
        size_t got = 0;
        rc = fffs_read(&f, out + total, cap - total, &got);
        if (rc != FFFS_OK) { fffs_close(&f); return rc; }
        if (got == 0) break;
        total += got;
    }
    fffs_close(&f);
    return (int)total;
}

int ff_delete(const char *name) { return fffs_delete_file(&g_fs, name); }

int ff_exists(const char *name) {
    bool e = false;
    int rc = fffs_exists(&g_fs, name, &e);
    return rc != FFFS_OK ? rc : (e ? 1 : 0);
}

/* Emit "name\tsize\n" lines into out[cap]. Returns bytes written or neg error. */
int ff_list(char *out, uint32_t cap) {
    struct fffs_dir d;
    int rc = fffs_dir_open(&g_fs, &d, "");
    if (rc != FFFS_OK) return rc;
    struct fffs_stat st;
    uint32_t n = 0;
    while (n < cap && fffs_dir_read(&d, &st)) {
        int w = snprintf(out + n, cap - n, "%s\t%u\n", st.name, (unsigned)st.size);
        if (w < 0 || (uint32_t)w >= cap - n) break;
        n += (uint32_t)w;
    }
    int status = fffs_dir_status(&d);
    fffs_dir_close(&d);
    if (status != FFFS_OK) return status;
    return (int)n;
}

/* Streaming directory iterator: each ff_dir_read is one fffs_dir_read, so the
 * caller can pace/animate the listing entry by entry. */
static struct fffs_dir g_dir;
static int g_dir_active = 0;

int ff_dir_open(void) {
    if (g_dir_active) { fffs_dir_close(&g_dir); g_dir_active = 0; }
    int rc = fffs_dir_open(&g_fs, &g_dir, "");
    if (rc == FFFS_OK) g_dir_active = 1;
    return rc;
}

/* One entry: name → out[cap]; returns size (>=0), -1 at end, -2 error/closed. */
int ff_dir_read(char *out, uint32_t cap) {
    if (!g_dir_active) return -2;
    struct fffs_stat st;
    if (!fffs_dir_read(&g_dir, &st)) {
        return fffs_dir_status(&g_dir) == FFFS_OK ? -1 : -2;
    }
    size_t n = strlen(st.name);
    if (cap && n >= cap) n = cap - 1;
    memcpy(out, st.name, n);
    if (cap) out[n] = 0;
    return (int)st.size;
}

void ff_dir_close(void) {
    if (g_dir_active) { fffs_dir_close(&g_dir); g_dir_active = 0; }
}

/* Run one opportunistic GC step; returns the fffs_gc_action or negative error. */
int ff_gc_step(void) {
    enum fffs_gc_action action = FFFS_GC_IDLE;
    int rc = fffs_gc_step(&g_fs, &action);
    return rc != FFFS_OK ? rc : (int)action;
}

uint32_t ff_committed_files(void) {
    struct fffs_fsinfo info;
    if (fffs_fsinfo(&g_fs, &info, FFFS_FSINFO_REFRESH_IF_NEEDED) != FFFS_OK) return 0;
    return info.committed_file_count;
}
uint32_t ff_committed_bytes(void) {
    struct fffs_fsinfo info;
    if (fffs_fsinfo(&g_fs, &info, FFFS_FSINFO_REFRESH_IF_NEEDED) != FFFS_OK) return 0;
    return info.committed_data_bytes;
}

/*
 * Classify every sector for the visualizer by reading its footer:
 *   0 erased/blank, 1 live (owned), 2 obsolete (tombstoned), 3 index, 4 other.
 * Uses silent reads so inspection doesn't show up as device traffic.
 */
int ff_sector_classes(uint8_t *out) {
    if (!g_mounted) return FFFS_ERR_INVALID;
    for (size_t s = 0; s < g_sector_count; s++) {
        if (s < g_fs.index_sectors) { out[s] = 3; continue; }
        uint8_t footer[FFFS_SECTOR_FOOTER_SIZE];
        uint32_t foff = (uint32_t)(s * g_sector_size + g_sector_size - FFFS_SECTOR_FOOTER_SIZE);
        js_flash_read_quiet(foff, footer, FFFS_SECTOR_FOOTER_SIZE);
        int blank = 1;
        for (int i = 0; i < FFFS_SECTOR_FOOTER_SIZE; i++) if (footer[i] != 0xff) { blank = 0; break; }
        if (blank) { out[s] = 0; continue; }
        struct fffs_sector_footer v;
        fffs_decode_sector_footer(footer, &v);
        if (!v.magic_valid || v.type != FFFS_SECTOR_TYPE_FILE) { out[s] = 4; continue; }
        if (fffs_lifecycle_is_live(v.valid_bits, v.tombstone_bits)) { out[s] = 1; continue; }
        int tomb = (v.valid_bits != FFFS_BITMIRROR_MIXED) &&
                   (v.tombstone_bits == FFFS_BITMIRROR_CLEARED);
        out[s] = tomb ? 2 : 4;
    }
    return FFFS_OK;
}

/*
 * Per-page liveness map for the visualizer: 0 erased, 1 metadata, 2 obsolete,
 * 3 live-data. Uses FASTFFS's reachability walk (silent reads).
 */
int ff_live_map(uint8_t *out, uint32_t page_size) {
    if (!g_mounted) return FFFS_ERR_INVALID;
    size_t pages = (g_sector_size * g_sector_count) / page_size;
    g_quiet = 1;
    int rc = fffs_inspect_live_map(&g_be, out, pages, page_size);
    g_quiet = 0;
    return rc;
}
