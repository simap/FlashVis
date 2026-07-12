/*
 * flashvis <-> FatFs binding shim.
 *
 * Exposes the uniform ff_* C API (ADR-0011) over ChaN FatFs (fs/fatfs/) running
 * on top of ESP-IDF wear_levelling (fs/wear_levelling/) — the exact stack the
 * FASTFFS ESP32-S3 FAT benchmark ran (ChaN FatFs / f_* -> diskio -> WL FTL ->
 * NOR read/prog/erase). The three layers map to our HAL as:
 *
 *     ff_* (this file) -> f_* (FatFs) -> disk_* (diskio.c) -> wl_* (wl_hal.cpp)
 *                      -> Partition (HAL) -> js_flash_read/prog/erase (device.js)
 *
 * FAT is hierarchical, so ff_mkdir is real (single-level, idempotent success
 * like the littlefs shim). Static-allocation discipline (ADR-0013/0014): fixed
 * FIL/DIR handle pools, static mkfs work buffer, no per-op malloc here (FatFs's
 * per-file cache lives inside each pooled FIL because FF_FS_TINY == 0).
 *
 * FatFs FRESULT codes are non-negative (FR_OK == 0); the ABI/runner treats a
 * negative return as failure, so every status-returning op maps FR_OK -> 0 and
 * any error -> -(int)fr.
 */
#include "ff.h"
#include "wl_api.h"

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>

/* ---- fixed geometry/state ---- */
static FATFS  g_fs;
static int    g_mounted = 0;
static BYTE   g_work[FF_MAX_SS];   /* f_mkfs work buffer (== IDF workbuf 4096) */

#define FF_MAX_FILES 8             /* benchmark mount config max_files = 8 */
#define FF_MAX_DIRS  4

static FIL     files[FF_MAX_FILES];
static uint8_t file_used[FF_MAX_FILES];
/* FatFs FIL carries no name back, so stash the basename at open (like littlefs). */
static char    file_names[FF_MAX_FILES][FF_LFN_BUF + 1];

static FF_DIR     dirs[FF_MAX_DIRS];
static uint8_t dir_used[FF_MAX_DIRS];

#define DRV "0:"

/* FR_OK -> 0, else negative error (see file header). */
static int e(FRESULT fr) { return fr == FR_OK ? 0 : -(int)fr; }

static void store_basename(char *dst, size_t cap, const char *path) {
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    size_t n = strlen(base);
    if (cap && n >= cap) n = cap - 1;
    memcpy(dst, base, n);
    if (cap) dst[n] = 0;
}

/* wl_hal has no "is up" query; track it here. Ensure the WL layer is built
 * over the CURRENT device contents (rebuild only if not already up). */
static int g_wl_built = 0;
static int wl_ensure(void) {
    if (g_wl_built) return 0;
    if (wlfat_up() != 0) return -1;
    g_wl_built = 1;
    return 0;
}

/* ---- lifecycle ---- */

int ff_config(uint32_t sector_size, uint32_t sector_count, uint32_t program_granule) {
    (void)program_granule;   /* NOR is byte-programmable; FatFs/WL don't use it */
    wlfat_config(sector_size, sector_count);
    return 0;
}

int ff_format(void) {
    /* A format follows a device.reset() (flash wiped to 0xFF), so rebuild WL
     * from scratch: wlfat_up() auto-initializes WL's sections on blank flash. */
    if (wlfat_up() != 0) return -1;
    g_wl_built = 1;
    /* IDF esp_vfs_fat mkfs options for the rw_wl path (backend_fatfs.c):
     * FM_ANY|FM_SFD, n_fat = 2 (use_one_fat=false), align 0,
     * n_root = 128 (sec_num <= MIN_REQ_SEC 128 && WL_SECTOR_SIZE != 512),
     * au_size = allocation_unit_size = CONFIG_WL_SECTOR_SIZE = 4096. */
    MKFS_PARM opt = { (BYTE)(FM_ANY | FM_SFD), 2, 0, 128, 4096 };
    return e(f_mkfs(DRV, &opt, g_work, sizeof(g_work)));
}

int ff_mount(void) {
    if (wl_ensure() != 0) return -1;
    g_wl_built = 1;
    FRESULT fr = f_mount(&g_fs, DRV, 1);
    g_mounted = (fr == FR_OK);
    return e(fr);
}

void ff_unmount(void) {
    if (g_mounted) { f_mount(NULL, DRV, 0); g_mounted = 0; }
}

/* ---- whole-file ops ---- */

int ff_write(const char *name, const uint8_t *data, uint32_t len) {
    FIL f;
    FRESULT fr = f_open(&f, name, FA_WRITE | FA_CREATE_ALWAYS);
    if (fr != FR_OK) return e(fr);
    UINT bw = 0;
    fr = f_write(&f, data, len, &bw);
    FRESULT frc = f_close(&f);
    if (fr != FR_OK) return e(fr);
    if (bw != len) return -1;
    return e(frc);
}

int ff_read(const char *name, uint8_t *out, uint32_t cap) {
    FIL f;
    FRESULT fr = f_open(&f, name, FA_READ);
    if (fr != FR_OK) return e(fr);
    UINT total = 0;
    while (total < cap) {
        UINT br = 0;
        fr = f_read(&f, out + total, cap - total, &br);
        if (fr != FR_OK) { f_close(&f); return e(fr); }
        if (br == 0) break;
        total += br;
    }
    f_close(&f);
    return (int)total;
}

/* ---- pooled handle I/O (ADR-0014) ---- */

int ff_open(const char *name, int mode) {
    BYTE flags;
    if (mode == 0) flags = FA_READ;
    else if (mode == 1) flags = FA_WRITE | FA_CREATE_ALWAYS;
    else if (mode == 2) flags = FA_WRITE | FA_OPEN_APPEND;  /* FatFs native append */
    else return -1;

    int h = -1;
    for (int i = 0; i < FF_MAX_FILES; i++) if (!file_used[i]) { h = i; break; }
    if (h < 0) return -1;

    FRESULT fr = f_open(&files[h], name, flags);
    if (fr != FR_OK) return e(fr);
    store_basename(file_names[h], sizeof(file_names[h]), name);
    file_used[h] = 1;
    return h;
}

int ff_file_read(int h, uint8_t *out, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -1;
    UINT total = 0;
    while (total < n) {
        UINT br = 0;
        FRESULT fr = f_read(&files[h], out + total, n - total, &br);
        if (fr != FR_OK) return e(fr);
        if (br == 0) break;
        total += br;
    }
    return (int)total;
}

int ff_file_write(int h, const uint8_t *data, uint32_t n) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -1;
    UINT bw = 0;
    FRESULT fr = f_write(&files[h], data, n, &bw);
    if (fr != FR_OK) return e(fr);
    return (int)bw;
}

int ff_file_seek(int h, int32_t off, int whence) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -1;
    FSIZE_t base;
    if (whence == 0) base = 0;                      /* set */
    else if (whence == 1) base = f_tell(&files[h]); /* cur */
    else if (whence == 2) base = f_size(&files[h]); /* end */
    else return -1;
    FSIZE_t target = base + (FSIZE_t)(int64_t)off;
    FRESULT fr = f_lseek(&files[h], target);
    if (fr != FR_OK) return e(fr);
    return (int)f_tell(&files[h]);
}

int ff_file_stat(int h, char *name_out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -1;
    FSIZE_t size = f_size(&files[h]);
    size_t n = strlen(file_names[h]);
    if (cap && n >= cap) n = cap - 1;
    memcpy(name_out, file_names[h], n);
    if (cap) name_out[n] = 0;
    return (int)size;
}

int ff_file_close(int h) {
    if (h < 0 || h >= FF_MAX_FILES || !file_used[h]) return -1;
    FRESULT fr = f_close(&files[h]);
    file_used[h] = 0;
    return e(fr);
}

/* ---- namespace ops ---- */

int ff_delete(const char *name) { return e(f_unlink(name)); }

int ff_exists(const char *name) {
    FILINFO fno;
    FRESULT fr = f_stat(name, &fno);
    if (fr == FR_OK) return 1;
    if (fr == FR_NO_FILE || fr == FR_NO_PATH) return 0;
    return e(fr);
}

int ff_stat(const char *name, char *name_out, uint32_t cap) {
    FILINFO fno;
    FRESULT fr = f_stat(name, &fno);
    if (fr == FR_NO_FILE || fr == FR_NO_PATH) return -1;
    if (fr != FR_OK) return e(fr);
    size_t n = strlen(fno.fname);
    if (cap && n >= cap) n = cap - 1;
    memcpy(name_out, fno.fname, n);
    if (cap) name_out[n] = 0;
    return (int)fno.fsize;
}

/* Real directory (single-level, idempotent success). */
int ff_mkdir(const char *name) {
    FRESULT fr = f_mkdir(name);
    return (fr == FR_EXIST) ? 0 : e(fr);
}

/* "name\tsize\n" for regular files in the root dir. */
int ff_list(char *out, uint32_t cap) {
    FF_DIR d;
    FILINFO fno;
    FRESULT fr = f_opendir(&d, DRV "/");
    if (fr != FR_OK) return e(fr);
    uint32_t n = 0;
    for (;;) {
        fr = f_readdir(&d, &fno);
        if (fr != FR_OK || fno.fname[0] == 0) break;
        if (fno.fattrib & AM_DIR) continue;
        int w = snprintf(out + n, cap - n, "%s\t%u\n", fno.fname, (unsigned)fno.fsize);
        if (w < 0 || (uint32_t)w >= cap - n) break;
        n += (uint32_t)w;
    }
    f_closedir(&d);
    return (int)n;
}

/* ---- streaming directory iterator ---- */

int ff_dir_open(const char *prefix) {
    int h = -1;
    for (int i = 0; i < FF_MAX_DIRS; i++) if (!dir_used[i]) { h = i; break; }
    if (h < 0) return -1;
    const char *path = (prefix && prefix[0]) ? prefix : DRV "/";
    FRESULT fr = f_opendir(&dirs[h], path);
    if (fr != FR_OK) return e(fr);
    dir_used[h] = 1;
    return h;
}

int ff_dir_read(int h, char *out, uint32_t cap) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return -2;
    FILINFO fno;
    for (;;) {
        FRESULT fr = f_readdir(&dirs[h], &fno);
        if (fr != FR_OK) return -2;
        if (fno.fname[0] == 0) return -1;      /* end */
        if (fno.fattrib & AM_DIR) continue;    /* regular files only */
        size_t n = strlen(fno.fname);
        if (cap && n >= cap) n = cap - 1;
        memcpy(out, fno.fname, n);
        if (cap) out[n] = 0;
        return (int)fno.fsize;
    }
}

void ff_dir_close(int h) {
    if (h < 0 || h >= FF_MAX_DIRS || !dir_used[h]) return;
    f_closedir(&dirs[h]);
    dir_used[h] = 0;
}

/* ---- committed totals (silent recursive walk) ---- */

static void walk(const char *path, uint32_t *nfiles, uint32_t *nbytes) {
    FF_DIR d;
    FILINFO fno;
    if (f_opendir(&d, path) != FR_OK) return;
    for (;;) {
        if (f_readdir(&d, &fno) != FR_OK || fno.fname[0] == 0) break;
        if (fno.fattrib & AM_DIR) {
            char child[FF_LFN_BUF + 8];
            snprintf(child, sizeof(child), "%s/%s", path, fno.fname);
            walk(child, nfiles, nbytes);
        } else {
            (*nfiles)++;
            *nbytes += (uint32_t)fno.fsize;
        }
    }
    f_closedir(&d);
}

static void committed(uint32_t *nfiles, uint32_t *nbytes) {
    *nfiles = 0; *nbytes = 0;
    if (!g_mounted) return;
    g_quiet = 1;
    walk(DRV "/", nfiles, nbytes);
    g_quiet = 0;
}

uint32_t ff_committed_files(void) { uint32_t f, b; committed(&f, &b); return f; }
uint32_t ff_committed_bytes(void) { uint32_t f, b; committed(&f, &b); return b; }

/* ---- ADR-0011 identity/capabilities ---- */
#define FF_CAP_GC              (1u << 0)
#define FF_CAP_SECTOR_CLASSES  (1u << 1)
#define FF_CAP_LIVE_MAP        (1u << 2)
#define FF_CAP_APPEND          (1u << 3)

uint32_t ff_abi_version(void) { return 1; }

/* APPEND (FatFs FA_OPEN_APPEND) | LIVE_MAP (native hook, fat_inspect.cpp).
 * No FF_CAP_GC (ADR-0021): neither FatFs nor wear_levelling has an incremental,
 * churn-safe GC primitive. WL does move a "dummy" sector for wear levelling,
 * but that happens INSIDE erase_range on the write path (every wl_update_rate
 * erases), not as a separately callable bounded step; there is no reclamation
 * pass to advance. ff_gc_step is a no-op symbol kept for ABI uniformity. */
uint32_t ff_caps(void) { return FF_CAP_APPEND | FF_CAP_LIVE_MAP; }

int ff_gc_step(void) { return 0; }
