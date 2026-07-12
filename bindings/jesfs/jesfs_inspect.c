/*
 * flashvis <-> JesFS native liveness hook (ADR-0012).
 *
 * Exports `ff_live_map`: a per-page classification of the die --
 *   0 erased  1 metadata  2 obsolete  3 live-data
 * the same shared baseline the FASTFFS and LittleFS hooks produce, so the dies
 * are directly comparable (the point of the multi-FS UI).
 *
 * JesFS makes this almost free, and crucially NOT a JS-side heuristic: its
 * sector state IS its liveness model. Every 4K sector begins with a 4-byte
 * magic that JesFS's own mount scan (fs_start in jesfs_hl.c) reads to classify
 * it, and deletion is explicit -- fs_delete rewrites a live file's head magic to
 * HEAD_DELETED and each data sector's magic to TODELETE (see flash_set2delete).
 * So walking every sector's header magic here reproduces exactly the on-flash
 * bookkeeping JesFS itself keeps; it reads real device state, nothing inferred:
 *
 *   sector 0                         -> metadata  (master header 'JesF' + the
 *                                       file index: an array of head pointers)
 *   HEAD_ACTIVE / DATA               -> live      (reachable file chains; a data
 *                                       sector's owner is an active file by
 *                                       construction, since deleting a file
 *                                       flips its data sectors to TODELETE)
 *   HEAD_DELETED / TODELETE          -> obsolete  (deleted/superseded, awaiting
 *                                       just-in-time erase on next allocation)
 *   0xFFFFFFFF                       -> erased
 *
 * Fidelity note: a JesFS file HEAD sector co-locates the per-file FINFO
 * (name/len/crc/ctime -- directory-entry metadata) with the first ~4048 bytes
 * of file data. At sector granularity that head is classified LIVE (its dominant
 * content and its role as the reachable start of the file chain); sector 0 is
 * the one pure-metadata sector. Splitting the FINFO out as its own sub-sector
 * metadata span is exactly the finer granularity ADR-0012 leaves open.
 *
 * Reads go through the silent HAL import so inspection emits no device traffic.
 */
#include <stdint.h>
#include <string.h>

#include "jesfs.h"
#include "jesfs_int.h"

extern int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

extern uint32_t g_sector_size;
extern uint32_t g_sector_count;
extern int      g_mounted;

/* class codes, shared with the viz (ADR-0012 baseline) */
enum { CLS_ERASED = 0, CLS_META = 1, CLS_OBSOLETE = 2, CLS_LIVE = 3 };

static uint8_t classify_sector(uint32_t sadr) {
    uint32_t magic = 0xFFFFFFFFu;
    js_flash_read_quiet(sadr, (uint8_t *)&magic, 4);
    switch (magic) {
    case 0xFFFFFFFFu:              return CLS_ERASED;
    case SECTOR_MAGIC_HEAD_ACTIVE: return CLS_LIVE;
    case SECTOR_MAGIC_DATA:        return CLS_LIVE;
    case SECTOR_MAGIC_HEAD_DELETED: return CLS_OBSOLETE;
    case SECTOR_MAGIC_TODELETE:    return CLS_OBSOLETE;
    default:                       return CLS_OBSOLETE; /* occupied but not a live chain */
    }
}

/*
 * Per-page liveness map. JesFS's granule is the 4K sector, so every page within
 * a sector inherits the sector's class -- coarser than FASTFFS's per-record map
 * but the same four classes (ADR-0012), matching the LittleFS shim's expansion.
 */
int ff_live_map(uint8_t *out, uint32_t page_size) {
    if (!g_mounted) return -1;
    uint32_t nsect = g_sector_count;
    /* page_size must divide the sector evenly: the caller sizes out[] as
     * (sector_size*sector_count)/page_size, and we fill nsect*(sector_size/
     * page_size); a non-dividing page_size makes those disagree and leaves the
     * tail of out[] uninitialized. */
    if (nsect > 256 || g_sector_size > 4096 || page_size == 0
            || g_sector_size % page_size != 0) return -1;

    uint8_t sc[256];
    sc[0] = CLS_META; /* sector 0 = master header + file index */
    for (uint32_t s = 1; s < nsect; s++) sc[s] = classify_sector(s * g_sector_size);

    uint32_t pages_per_sector = g_sector_size / page_size;
    uint32_t total_pages = nsect * pages_per_sector;
    for (uint32_t p = 0; p < total_pages; p++) out[p] = sc[p / pages_per_sector];
    return 0;
}
