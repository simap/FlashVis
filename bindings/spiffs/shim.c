/*
 * flashvis <-> SPIFFS binding shim.
 *
 * Implements the SPIFFS HAL (spiffs_config hal_read_f/hal_write_f/hal_erase_f
 * forwarding to three JS imports resolved by build/flash_hal.js -> web/src/device.js)
 * and exposes the uniform flat `ff_*` C API (ADR-0011) so the console/runner can
 * drive SPIFFS interchangeably with FASTFFS and LittleFS.
 *
 * Static allocation discipline (ADR-0013/0014): the SPIFFS work/fd/cache buffers and
 * the file/dir handle pools are all fixed, compile-time-sized, caller-owned buffers.
 * Their sizes mirror ESP-IDF's esp_spiffs.c derivations exactly (see cfg_init /
 * the buffer definitions below), so flashvis runs the same buffering the benchmark did.
 *
 * SPIFFS is flat (no directories): ff_mkdir is a no-op success, like the FASTFFS shim.
 *
 * g_quiet / g_fs / g_mounted / g_sector_* are non-static so the liveness hook in
 * spiffs_inspect.c (a separate TU, ADR-0012) can reach them via extern.
 */
#include "spiffs.h"
#include "spiffs_nucleus.h"   /* for sizeof(spiffs_fd/spiffs_cache/spiffs_cache_page) */

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

/* ---- imports: the emulated NOR chip lives in JS (device.js) ---- */
extern int js_flash_read(uint32_t off, void *buffer, uint32_t size);
extern int js_flash_prog(uint32_t off, const void *buffer, uint32_t size);
extern int js_flash_erase(uint32_t off, uint32_t size);
extern int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

/* when set, backend reads are silent (used by the inspect hook) */
int g_quiet = 0;

/* ---- geometry (set by ff_config, before format/mount) ---- */
uint32_t g_sector_size  = 4096;
uint32_t g_sector_count = 64;

/* Logical page size = the benchmark's CONFIG_SPIFFS_PAGE_SIZE (256), also the
 * device page size. Logical block size = physical NOR sector (IDF sets
 * log_block_size = flash erase sector size). */
#define SPIFFS_LOG_PAGE_SIZE 256

/* max_files = 8, from the benchmark's backend_spiffs.c (esp_vfs_spiffs_conf_t.max_files). */
#define FF_MAX_FILES 8
#define FF_MAX_DIRS  4

/* ---- HAL callbacks (SPIFFS core -> JS chip). SPIFFS_HAL_CALLBACK_EXTRA=0, so these
 * take (addr,size,buf) and forward straight to the imports. ---- */
static s32_t be_read(u32_t addr, u32_t size, u8_t *dst) {
    int rc = g_quiet ? js_flash_read_quiet(addr, dst, size)
                     : js_flash_read(addr, dst, size);
    return rc ? SPIFFS_ERR_INTERNAL : SPIFFS_OK;
}
static s32_t be_prog(u32_t addr, u32_t size, u8_t *src) {
    return js_flash_prog(addr, src, size) ? SPIFFS_ERR_INTERNAL : SPIFFS_OK;
}
static s32_t be_erase(u32_t addr, u32_t size) {
    return js_flash_erase(addr, size) ? SPIFFS_ERR_INTERNAL : SPIFFS_OK;
}

/* ---- caller-owned filesystem state (all static, ADR-0013) ---- */
spiffs                 g_fs;
static spiffs_config   g_cfg;
int                    g_mounted = 0;

/* IDF esp_spiffs.c buffer derivations (mirrored exactly):
 *   work  = log_page_size * 2
 *   fds   = max_files * sizeof(spiffs_fd)
 *   cache = sizeof(spiffs_cache) + max_files * (sizeof(spiffs_cache_page) + log_page_size)
 * SPIFFS_mount internally caps cache_size at log_page_size*32; our size is well under. */
static u8_t g_work[SPIFFS_LOG_PAGE_SIZE * 2];
static u8_t g_fd_space[FF_MAX_FILES * sizeof(spiffs_fd)];
static u8_t g_cache[sizeof(spiffs_cache)
                    + FF_MAX_FILES * (sizeof(spiffs_cache_page) + SPIFFS_LOG_PAGE_SIZE)];

/* Fixed per-handle pools for the console file/dir API (ADR-0014). Each ff file
 * handle stores the SPIFFS file number it wraps; SPIFFS file numbers are >0. */
static spiffs_file files[FF_MAX_FILES];
static uint8_t     file_used[FF_MAX_FILES];

static spiffs_DIR  dirs[FF_MAX_DIRS];
static uint8_t     dir_used[FF_MAX_DIRS];
static char        dir_prefix[FF_MAX_DIRS][SPIFFS_OBJ_NAME_LEN];

/* Configure g_cfg to the current geometry + fixed tuning. Re-applied before every
 * format/mount in case ff_config changed geometry. */
static void cfg_init(void) {
    memset(&g_cfg, 0, sizeof(g_cfg));
    g_cfg.hal_read_f       = be_read;
    g_cfg.hal_write_f      = be_prog;
    g_cfg.hal_erase_f      = be_erase;
    g_cfg.phys_size        = g_sector_size * g_sector_count; /* device capacity */
    g_cfg.phys_addr        = 0;
    g_cfg.phys_erase_block = g_sector_size;                  /* NOR sector */
    g_cfg.log_block_size   = g_sector_size;                  /* IDF: = erase sector size */
    g_cfg.log_page_size    = SPIFFS_LOG_PAGE_SIZE;           /* CONFIG_SPIFFS_PAGE_SIZE */
}

static int do_mount(void) {
    return SPIFFS_mount(&g_fs, &g_cfg, g_work,
                        g_fd_space, sizeof(g_fd_space),
                        g_cache, sizeof(g_cache), 0);
}

/* ---- exported API ---- */

int ff_config(uint32_t sector_size, uint32_t sector_count, uint32_t program_granule) {
    (void)program_granule; /* NOR byte programming; SPIFFS writes arbitrary sizes */
    g_sector_size = sector_size;
    g_sector_count = sector_count;
    cfg_init();
    return SPIFFS_OK;
}

/* SPIFFS's format protocol is awkward (spiffs.h): SPIFFS_mount MUST run first to
 * configure the fs. If it succeeds, unmount before formatting; if it fails
 * (NOT_A_FS on a blank/dirty device) the config is still set, so format directly.
 * This mirrors esp_spiffs.c's esp_spiffs_format. */
int ff_format(void) {
    cfg_init();
    int rc = do_mount();
    if (rc == SPIFFS_OK) SPIFFS_unmount(&g_fs);
    g_mounted = 0;
    return SPIFFS_format(&g_fs);
}

int ff_mount(void) {
    cfg_init();
    int rc = do_mount();
    g_mounted = (rc == SPIFFS_OK);
    return rc;
}

void ff_unmount(void) {
    if (g_mounted) { SPIFFS_unmount(&g_fs); g_mounted = 0; }
}

/* Create-or-replace a whole file. */
int ff_write(const char *name, const uint8_t *data, uint32_t len) {
    spiffs_file fh = SPIFFS_open(&g_fs, name,
            SPIFFS_O_WRONLY | SPIFFS_O_CREAT | SPIFFS_O_TRUNC, 0);
    if (fh < 0) return (int)fh;
    s32_t wrc = (len > 0) ? SPIFFS_write(&g_fs, fh, (void *)data, (s32_t)len) : 0;
    s32_t crc = SPIFFS_close(&g_fs, fh);
    if (wrc < 0) return (int)wrc;
    return crc < 0 ? (int)crc : SPIFFS_OK;
}

/* Read a whole file into out[cap]. Returns bytes read (>=0) or negative error. */
int ff_read(const char *name, uint8_t *out, uint32_t cap) {
    spiffs_file fh = SPIFFS_open(&g_fs, name, SPIFFS_O_RDONLY, 0);
    if (fh < 0) return (int)fh;
    spiffs_stat st;
    s32_t src = SPIFFS_fstat(&g_fs, fh, &st);
    if (src < 0) { SPIFFS_close(&g_fs, fh); return (int)src; }
    uint32_t n = st.size;
    if (n > cap) n = cap;
    s32_t got = 0;
    if (n > 0) {
        got = SPIFFS_read(&g_fs, fh, out, (s32_t)n);
        if (got < 0) { SPIFFS_close(&g_fs, fh); return (int)got; }
    }
    SPIFFS_close(&g_fs, fh);
    return (int)got;
}

/* Open a pooled handle: mode 0='r' (RDONLY), 1='w' (WRONLY|CREAT|TRUNC),
 * 2='a' (WRONLY|CREAT|APPEND). Returns handle >=0 or negative error. */
int ff_open(const char *name, int mode) {
    spiffs_flags flags;
    if (mode == 0) flags = SPIFFS_O_RDONLY;
    else if (mode == 1) flags = SPIFFS_O_WRONLY | SPIFFS_O_CREAT | SPIFFS_O_TRUNC;
    else if (mode == 2) flags = SPIFFS_O_WRONLY | SPIFFS_O_CREAT | SPIFFS_O_APPEND;
    else return SPIFFS_ERR_NOT_WRITABLE;

    int h = -1;
    for (int i = 0; i < FF_MAX_FILES; i++) if (!file_used[i]) { h = i; break; }
    if (h < 0) return SPIFFS_ERR_OUT_OF_FILE_DESCS;

    spiffs_file fh = SPIFFS_open(&g_fs, name, flags, 0);
    if (fh < 0) return (int)fh;
    files[h] = fh;
    file_used[h] = 1;
    return h;
}

/* Read up to n bytes from the current position. Returns bytes read (0 = EOF) or
 * negative error; SPIFFS signals EOF as SPIFFS_ERR_END_OF_OBJECT, mapped to 0. */
int ff_file_read(int h, uint8_t *out, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return SPIFFS_ERR_BAD_DESCRIPTOR;
    if (n == 0) return 0;
    s32_t got = SPIFFS_read(&g_fs, files[h], out, (s32_t)n);
    if (got == SPIFFS_ERR_END_OF_OBJECT) return 0;
    return (int)got;
}

int ff_file_write(int h, const uint8_t *data, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return SPIFFS_ERR_BAD_DESCRIPTOR;
    return (int)SPIFFS_write(&g_fs, files[h], (void *)data, (s32_t)n);
}

/* Seek; whence 0=set, 1=cur, 2=end (SPIFFS_SEEK_* map 1:1). Returns new absolute
 * position (>=0) or negative error. */
int ff_file_seek(int h, int32_t off, int whence) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return SPIFFS_ERR_BAD_DESCRIPTOR;
    return (int)SPIFFS_lseek(&g_fs, files[h], (s32_t)off, whence);
}

/* Stat the open handle; writes a NUL-terminated name into name_out[cap]. Returns
 * size (>=0) or negative error. */
int ff_file_stat(int h, char *name_out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return SPIFFS_ERR_BAD_DESCRIPTOR;
    spiffs_stat st;
    s32_t rc = SPIFFS_fstat(&g_fs, files[h], &st);
    if (rc < 0) return (int)rc;
    size_t len = strlen((const char *)st.name);
    if (cap && len >= cap) len = cap - 1;
    memcpy(name_out, st.name, len);
    if (cap) name_out[len] = 0;
    return (int)st.size;
}

int ff_file_close(int h) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return SPIFFS_ERR_BAD_DESCRIPTOR;
    s32_t rc = SPIFFS_close(&g_fs, files[h]);
    file_used[h] = 0;
    return (int)rc;
}

int ff_delete(const char *name) { return (int)SPIFFS_remove(&g_fs, name); }

int ff_exists(const char *name) {
    spiffs_stat st;
    s32_t rc = SPIFFS_stat(&g_fs, name, &st);
    if (rc == SPIFFS_ERR_NOT_FOUND) return 0;
    if (rc < 0) return (int)rc;
    return 1;
}

/* Stat by name; writes a NUL-terminated name into name_out[cap]. Returns size (>=0),
 * -1 if not found (so JS can return null), or another negative error. */
int ff_stat(const char *name, char *name_out, uint32_t cap) {
    spiffs_stat st;
    s32_t rc = SPIFFS_stat(&g_fs, name, &st);
    if (rc == SPIFFS_ERR_NOT_FOUND) return -1;
    if (rc < 0) return (int)rc;
    size_t len = strlen((const char *)st.name);
    if (cap && len >= cap) len = cap - 1;
    memcpy(name_out, st.name, len);
    if (cap) name_out[len] = 0;
    return (int)st.size;
}

/* SPIFFS is flat: no directories to create, so this always succeeds (like FASTFFS). */
int ff_mkdir(const char *name) { (void)name; return SPIFFS_OK; }

/* Emit "name\tsize\n" lines for every file into out[cap]. Returns bytes written or
 * neg error. */
int ff_list(char *out, uint32_t cap) {
    spiffs_DIR d;
    if (SPIFFS_opendir(&g_fs, "/", &d) == 0) return SPIFFS_errno(&g_fs);
    struct spiffs_dirent e, *pe;
    uint32_t n = 0;
    while (n < cap && (pe = SPIFFS_readdir(&d, &e))) {
        if (pe->type != SPIFFS_TYPE_FILE) continue;
        int w = snprintf(out + n, cap - n, "%s\t%u\n", pe->name, (unsigned)pe->size);
        if (w < 0 || (uint32_t)w >= cap - n) break;
        n += (uint32_t)w;
    }
    SPIFFS_closedir(&d);
    return (int)n;
}

/* Streaming directory iterator. SPIFFS is flat, so `prefix` (when non-empty) is a
 * name-prefix filter, mirroring FASTFFS's flat dir_open. Pool-based (FF_MAX_DIRS). */
int ff_dir_open(const char *prefix) {
    int h = -1;
    for (int i = 0; i < FF_MAX_DIRS; i++) if (!dir_used[i]) { h = i; break; }
    if (h < 0) return SPIFFS_ERR_OUT_OF_FILE_DESCS;

    if (SPIFFS_opendir(&g_fs, "/", &dirs[h]) == 0) return SPIFFS_errno(&g_fs);
    if (prefix && prefix[0]) {
        size_t n = strlen(prefix);
        if (n >= sizeof(dir_prefix[h])) n = sizeof(dir_prefix[h]) - 1;
        memcpy(dir_prefix[h], prefix, n);
        dir_prefix[h][n] = 0;
    } else {
        dir_prefix[h][0] = 0;
    }
    dir_used[h] = 1;
    return h;
}

/* One entry: name -> out[cap]; returns size (>=0), -1 at end, -2 error/closed. */
int ff_dir_read(int h, char *out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return -2;
    struct spiffs_dirent e, *pe;
    while ((pe = SPIFFS_readdir(&dirs[h], &e))) {
        if (pe->type != SPIFFS_TYPE_FILE) continue;
        if (dir_prefix[h][0] &&
            strncmp((const char *)pe->name, dir_prefix[h], strlen(dir_prefix[h])) != 0)
            continue;
        size_t n = strlen((const char *)pe->name);
        if (cap && n >= cap) n = cap - 1;
        memcpy(out, pe->name, n);
        if (cap) out[n] = 0;
        return (int)pe->size;
    }
    return SPIFFS_errno(&g_fs) == SPIFFS_OK ? -1 : -2;
}

void ff_dir_close(int h) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return;
    SPIFFS_closedir(&dirs[h]);
    dir_used[h] = 0;
}

/* One bounded, churn-safe GC step (ADR-0021). SPIFFS_gc_quick(fs, 0) erases at most
 * one block whose data pages are ALL deleted; it never moves pages, so it is a small,
 * bounded unit of reclamation safe to call at churn frequency — exactly the background
 * "tidy while idle" primitive the churn model assumes (unlike SPIFFS_gc(size), which
 * moves pages and does unbounded work, and is deliberately not wired here). Returns
 * 1 when a block was reclaimed, 0 when there was nothing to do (NO_DELETED_BLOCKS,
 * the common idle case — not an error), or a negative error otherwise. */
int ff_gc_step(void) {
    s32_t rc = SPIFFS_gc_quick(&g_fs, 0);
    if (rc == SPIFFS_OK) return 1;
    if (rc == SPIFFS_ERR_NO_DELETED_BLOCKS) return 0;
    return (int)rc;
}

/* Silent flat walk counting files and summing sizes; g_quiet keeps it off the
 * device-traffic log. Shared by ff_committed_files/ff_committed_bytes. */
static void committed_walk(uint32_t *files_out, uint32_t *bytes_out) {
    *files_out = 0; *bytes_out = 0;
    if (!g_mounted) return;
    g_quiet = 1;
    spiffs_DIR d;
    if (SPIFFS_opendir(&g_fs, "/", &d)) {
        struct spiffs_dirent e, *pe;
        while ((pe = SPIFFS_readdir(&d, &e))) {
            if (pe->type != SPIFFS_TYPE_FILE) continue;
            (*files_out)++;
            *bytes_out += pe->size;
        }
        SPIFFS_closedir(&d);
    }
    g_quiet = 0;
}

uint32_t ff_committed_files(void) { uint32_t f, b; committed_walk(&f, &b); return f; }
uint32_t ff_committed_bytes(void) { uint32_t f, b; committed_walk(&f, &b); return b; }

/* ---- ADR-0011: uniform FS-driver ABI — version + capability advertisement ---- */
#define FF_ABI_VERSION 1

#define FF_CAP_GC              (1u << 0)
#define FF_CAP_SECTOR_CLASSES  (1u << 1)
#define FF_CAP_LIVE_MAP        (1u << 2)
#define FF_CAP_APPEND          (1u << 3)

uint32_t ff_abi_version(void) { return FF_ABI_VERSION; }
/* GC|LIVE_MAP|APPEND (0xd). GC is ON: SPIFFS is log-structured with real reclaimable
 * garbage, and SPIFFS_gc_quick(0) is the bounded, churn-safe incremental primitive
 * ADR-0021 requires (see ff_gc_step). LIVE_MAP is the native inspect hook in
 * spiffs_inspect.c (ADR-0012). SECTOR_CLASSES stays off — the per-page live map is the
 * driver's coloring, and SPIFFS's native granule already IS the 256 B page. */
uint32_t ff_caps(void) { return FF_CAP_GC | FF_CAP_LIVE_MAP | FF_CAP_APPEND; }
