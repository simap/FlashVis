/*
 * flashvis ↔ LittleFS native liveness hook (ADR-0012).
 *
 * Exports `ff_live_map`: a per-page classification of the die —
 *   0 erased · 1 metadata · 2 obsolete · 3 live-data
 * the same shared baseline the FASTFFS hook produces, so the two dies are
 * directly comparable (the whole point of the multi-FS UI).
 *
 * LittleFS has no public "what's reachable" query at block granularity that
 * distinguishes metadata from data, so we reproduce lfs_fs_traverse_() (see
 * lfs.c) with per-phase tagging: metadata-pair blocks are class 1, CTZ data
 * blocks (reached via lfs_ctz_traverse) are class 3. That needs lfs.c's static
 * helpers (lfs_dir_fetch / lfs_dir_get / lfs_ctz_traverse / lfs_pair_* / the tag
 * macros), so this TU #includes lfs.c directly — and the build compiles THIS in
 * place of lfs.c (one copy of the core, no duplicate symbols).
 *
 * Blocks the traverse never visits are split by a blank scan: all-0xFF ⇒ erased,
 * otherwise obsolete. That's valid on LittleFS because it erases just-in-time at
 * write (never on garbage-creation), so a superseded block keeps its stale, non-
 * 0xFF content until it's reallocated — exactly the heuristic ADR-0012 calls for.
 *
 * The walk runs under the shim's g_quiet flag so inspection emits no device
 * traffic (it must not perturb the wear/op counters it is visualizing).
 */
#include "lfs.c"   /* pulls in lfs.h + every static helper; compiled once, here */

#include <stdint.h>
#include <string.h>

/* Bridge to the shim's mounted instance, geometry, and quiet flag (bindings/
 * littlefs/shim.c declares these non-static for exactly this). */
extern lfs_t    g_lfs;
extern int      g_mounted;
extern uint32_t g_sector_size;
extern uint32_t g_sector_count;
extern int      g_quiet;
extern int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

/* class codes, shared with the viz */
enum { CLS_ERASED = 0, CLS_META = 1, CLS_OBSOLETE = 2, CLS_LIVE = 3 };

/* CTZ-traversal callback: every block backing live file data is live-data. */
static int mark_live_cb(void *data, lfs_block_t block) {
    uint8_t *bc = (uint8_t *)data;
    if (block < g_sector_count) bc[block] = CLS_LIVE;
    return 0;
}

/* Reproduce lfs_fs_traverse_ with per-phase tagging into bc[block]:
 * metadata pairs → CLS_META, CTZ file data → CLS_LIVE. Returns 0 or neg. */
static int classify_live(lfs_t *lfs, uint8_t *bc) {
    lfs_mdir_t dir = {.tail = {0, 1}};
    lfs_block_t tortoise[2] = {LFS_BLOCK_NULL, LFS_BLOCK_NULL};
    lfs_size_t tortoise_i = 1, tortoise_period = 1;

    while (!lfs_pair_isnull(dir.tail)) {
        if (lfs_pair_issync(dir.tail, tortoise)) return LFS_ERR_CORRUPT;
        if (tortoise_i == tortoise_period) {
            tortoise[0] = dir.tail[0]; tortoise[1] = dir.tail[1];
            tortoise_i = 0; tortoise_period *= 2;
        }
        tortoise_i += 1;

        for (int i = 0; i < 2; i++)
            if (dir.tail[i] < g_sector_count) bc[dir.tail[i]] = CLS_META;

        int err = lfs_dir_fetch(lfs, &dir, dir.tail);
        if (err) return err;

        for (uint16_t id = 0; id < dir.count; id++) {
            struct lfs_ctz ctz;
            lfs_stag_t tag = lfs_dir_get(lfs, &dir, LFS_MKTAG(0x700, 0x3ff, 0),
                    LFS_MKTAG(LFS_TYPE_STRUCT, id, sizeof(ctz)), &ctz);
            if (tag < 0) {
                if (tag == LFS_ERR_NOENT) continue;
                return tag;
            }
            lfs_ctz_fromle32(&ctz);

            if (lfs_tag_type3(tag) == LFS_TYPE_CTZSTRUCT) {
                err = lfs_ctz_traverse(lfs, NULL, &lfs->rcache,
                        ctz.head, ctz.size, mark_live_cb, bc);
                if (err) return err;
            } else if (lfs_tag_type3(tag) == LFS_TYPE_DIRSTRUCT) {
                // Directory metadata pair. We always include these (the reference
                // gates this on an `includeorphans` flag; we mirror its allocator
                // caller, includeorphans=true): an orphaned pair still occupies its
                // blocks until cleanup, so coloring it metadata — not letting the
                // blank scan call it obsolete — is right for "what's occupied".
                for (int i = 0; i < 2; i++) {
                    lfs_block_t b = (&ctz.head)[i];
                    if (b < g_sector_count) bc[b] = CLS_META;
                }
            }
        }
    }

    /* Open files with unflushed data still hold live CTZ blocks. */
    for (lfs_file_t *f = (lfs_file_t *)lfs->mlist; f; f = f->next) {
        if (f->type != LFS_TYPE_REG) continue;
        if ((f->flags & LFS_F_DIRTY) && !(f->flags & LFS_F_INLINE)) {
            int err = lfs_ctz_traverse(lfs, &f->cache, &lfs->rcache,
                    f->ctz.head, f->ctz.size, mark_live_cb, bc);
            if (err) return err;
        }
        if ((f->flags & LFS_F_WRITING) && !(f->flags & LFS_F_INLINE)) {
            int err = lfs_ctz_traverse(lfs, &f->cache, &lfs->rcache,
                    f->block, f->pos, mark_live_cb, bc);
            if (err) return err;
        }
    }
    return 0;
}

/*
 * Per-page liveness map for the visualizer. LittleFS's granule is the block
 * (== our sector), so every page within a block gets the block's class — coarser
 * than FASTFFS's per-record map, but the same four classes (ADR-0012). Silent.
 */
int ff_live_map(uint8_t *out, uint32_t page_size) {
    if (!g_mounted) return LFS_ERR_INVAL;
    uint32_t nblocks = g_sector_count;
    // page_size must divide the block/sector evenly: the caller sizes out[] as
    // (sector_size*sector_count)/page_size, but our expansion below fills
    // nblocks*(sector_size/page_size). A non-dividing page_size makes those two
    // counts disagree and leaves the tail of out[] as uninitialized heap.
    if (nblocks > 256 || g_sector_size > 4096 || page_size == 0
            || g_sector_size % page_size != 0) return LFS_ERR_INVAL;

    uint8_t bc[256];
    memset(bc, CLS_ERASED, nblocks);   /* provisional; the blank scan corrects non-live */

    g_quiet = 1;
    int err = classify_live(&g_lfs, bc);
    if (!err) {
        static uint8_t block[4096];
        for (uint32_t b = 0; b < nblocks; b++) {
            if (bc[b] != CLS_ERASED) continue;          /* already live/meta */
            js_flash_read_quiet(b * g_sector_size, block, g_sector_size);
            int blank = 1;
            for (uint32_t i = 0; i < g_sector_size; i++)
                if (block[i] != 0xff) { blank = 0; break; }
            bc[b] = blank ? CLS_ERASED : CLS_OBSOLETE;
        }
    }
    g_quiet = 0;
    if (err) return err;

    uint32_t pages_per_block = g_sector_size / page_size;
    uint32_t total_pages = nblocks * pages_per_block;
    for (uint32_t p = 0; p < total_pages; p++) out[p] = bc[p / pages_per_block];
    return 0;
}
