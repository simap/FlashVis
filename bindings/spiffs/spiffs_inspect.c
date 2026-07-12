/*
 * flashvis <-> SPIFFS native liveness hook (ADR-0012).
 *
 * Exports `ff_live_map`: a per-page classification of the die —
 *   0 erased * 1 metadata * 2 obsolete * 3 live-data
 * the same shared baseline the FASTFFS and LittleFS hooks produce, so the dies are
 * directly comparable (the whole point of the multi-FS UI).
 *
 * SPIFFS's authoritative per-page metadata IS the object lookup table at the start of
 * each block: one spiffs_obj_id entry per data-area page in the block, telling us what
 * that page holds. We read those lookup pages directly (no JS-side heuristics) and
 * classify every page from them — reaching exactly the SPIFFS internals the project
 * exists to visualize:
 *   - object lookup pages (block header)         -> metadata (blank block -> erased)
 *   - lookup entry == FREE  (0xFFFF)             -> erased   (page never allocated)
 *   - lookup entry == DELETED (0x0000)           -> obsolete (page tombstoned, AND-written)
 *   - lookup entry has the index flag set        -> metadata (object index page)
 *   - lookup entry is a plain object id          -> live-data (object content page)
 *
 * SPIFFS's native granule is the 256 B logical page == our device page, so this is a
 * true per-page map with no block-granule expansion (unlike the LittleFS hook).
 *
 * DELETED (0x0000) is a programmed value (0xFFFF AND-masked to 0), so obsolete pages
 * are read straight from the lookup table — no blank-scan-for-obsolete needed. The only
 * blank scan is on the lookup pages themselves, to split a never-touched block (all
 * 0xFF) as erased from a formatted block (magic written) as metadata.
 *
 * Reads go through js_flash_read_quiet under the shim's g_quiet flag, so inspection
 * emits no device traffic (it must not perturb the wear/op counters it visualizes).
 */
#include "spiffs.h"
#include "spiffs_nucleus.h"

#include <stdint.h>
#include <string.h>

/* Bridge to the shim's mounted instance and quiet flag (bindings/spiffs/shim.c
 * declares these non-static for exactly this). */
extern spiffs   g_fs;
extern int      g_mounted;
extern int      g_quiet;
extern int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

/* class codes, shared with the viz */
enum { CLS_ERASED = 0, CLS_META = 1, CLS_OBSOLETE = 2, CLS_LIVE = 3 };

int ff_live_map(uint8_t *out, uint32_t page_size) {
    if (!g_mounted) return SPIFFS_ERR_NOT_MOUNTED;
    /* The runner passes the device page size; SPIFFS's native page must match it for
     * the 1:1 page map to hold. */
    if (page_size == 0 || page_size != SPIFFS_CFG_LOG_PAGE_SZ(&g_fs))
        return SPIFFS_ERR_INTERNAL;

    uint32_t ppb         = SPIFFS_PAGES_PER_BLOCK(&g_fs);
    uint32_t lu_pages    = SPIFFS_OBJ_LOOKUP_PAGES(&g_fs);
    uint32_t max_entries = SPIFFS_OBJ_LOOKUP_MAX_ENTRIES(&g_fs);
    uint32_t lu_bytes    = lu_pages * page_size;

    /* One block's object-lookup region; 4096 covers the whole (largest) block. */
    static uint8_t lu[4096];
    if (lu_bytes > sizeof(lu)) return SPIFFS_ERR_INTERNAL;

    g_quiet = 1;
    for (uint32_t block = 0; block < g_fs.block_count; block++) {
        uint32_t base = SPIFFS_BLOCK_TO_PADDR(&g_fs, block);
        js_flash_read_quiet(base, lu, lu_bytes);
        const spiffs_obj_id *tbl = (const spiffs_obj_id *)(const void *)lu;

        /* The lookup pages themselves: metadata, unless the block is blank (erased). */
        for (uint32_t lp = 0; lp < lu_pages; lp++) {
            int blank = 1;
            for (uint32_t i = 0; i < page_size; i++)
                if (lu[lp * page_size + i] != 0xff) { blank = 0; break; }
            out[block * ppb + lp] = blank ? CLS_ERASED : CLS_META;
        }

        /* The data-area pages: classify each from its lookup entry. */
        for (uint32_t e = 0; e < max_entries; e++) {
            spiffs_obj_id id = tbl[e];
            uint8_t cls;
            if (id == SPIFFS_OBJ_ID_FREE)          cls = CLS_ERASED;
            else if (id == SPIFFS_OBJ_ID_DELETED)  cls = CLS_OBSOLETE;
            else if (id & SPIFFS_OBJ_ID_IX_FLAG)   cls = CLS_META;
            else                                   cls = CLS_LIVE;
            out[block * ppb + lu_pages + e] = cls;
        }
    }
    g_quiet = 0;
    return 0;
}
