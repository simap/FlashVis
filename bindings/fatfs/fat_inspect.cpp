/*
 * flashvis <-> FatFs/wear_levelling native liveness hook (ADR-0012).
 *
 * Exports ff_live_map: a per-PAGE classification of the die — the shared
 * baseline every flashvis driver produces (0-3), plus two FAT+WL-specific
 * classes (the ADR-0011/0012 per-FS taxonomy; 0-3 semantics unchanged):
 *
 *   0 erased    physically blank page (all 0xFF)
 *   1 metadata  FAT structure bytes in actual use: the boot record, the used
 *               portion of each FAT table, directory entries up to the
 *               end-of-directory marker
 *   2 obsolete  page of a FAT-free cluster that is physically programmed —
 *               deleted/replaced file remnants the FS will overwrite blindly
 *   3 live      pages covering real file content (offset < filesize)
 *   4 WL        the wear_levelling FTL's own sectors (cfg + 2 state copies +
 *               rotating dummy spare), whole-sector by nature
 *   5 slack     allocated but carrying no data: a live cluster's tail past
 *               EOF, and the unused padding of metadata regions (FAT table
 *               tail, root-dir tail, boot-sector remainder) — makes the cost
 *               of 4096-byte allocation units visible per page
 *
 * Resolution: classification is per page *within* each 4096-B logical sector,
 * by parsing real FAT12 structure (BPB, FAT table, directory entries, file
 * sizes + cluster chains) — not by physical programming state, which is
 * always whole-sector here (diskio erases+programs full sectors, so "what's
 * programmed" carries no sub-sector information; "what the FAT means" does).
 *
 * The map is composed through the WL logical->physical mapping: each logical
 * sector's page classes land at its *current* physical sector (calcAddr via
 * the WL_Flash_Inspect subclass — the WL core stays byte-for-byte upstream).
 * Page offset within a sector survives the remap (WL moves whole sectors).
 *
 * All reads are silent (g_quiet — no device events, no stats, no sim time).
 *
 * Known single-level limitation (matches the console's single-level mkdir,
 * ADR-0014): files inside first-level subdirectories are resolved per page;
 * a dir nested deeper keeps its clusters as whole-cluster live (FAT truth,
 * never mislabeled free) — a documented cosmetic edge the workload never hits.
 */
#include "wl_glue.h"
#include "wl_api.h"

#include <stdint.h>
#include <string.h>

extern "C" int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

enum { CLS_ERASED = 0, CLS_META = 1, CLS_OBSOLETE = 2, CLS_LIVE = 3,
       CLS_WL = 4,     /* FAT+WL-specific: the FTL's own cfg/state/dummy sectors */
       CLS_SLACK = 5,  /* FAT+WL-specific: allocated-but-unused (EOF slack, padding) */
       /* internal sentinels, never emitted */
       PG_ALLOC = 0xFD,   /* cluster allocated in FAT, not yet claimed by a walk */
       PG_FREE  = 0xFE }; /* cluster free in FAT -> per-page blank scan */

/* Direct PHYSICAL sector read (bypasses WL remapping), for the safety-net
 * blank scan of any physical sector no logical sector maps onto. */
static int read_phys(uint32_t phys_sector, uint32_t ss, uint8_t *buf) {
    return js_flash_read_quiet(phys_sector * ss, buf, ss) ? -1 : 0;
}

/* Little-endian field reads out of a raw sector buffer. */
static inline uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static inline uint32_t rd32(const uint8_t *p) {
    return (uint32_t)(p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24));
}

/* One silent logical-sector read through the WL mapping. */
static int read_logical(uint32_t sector, uint32_t ss, uint8_t *buf) {
    return g_wl_inspect->read((size_t)sector * ss, buf, ss) == ESP_OK ? 0 : -1;
}

/* FAT12 entry for cluster c, from an in-memory copy of the (first) FAT. */
static uint32_t fat12_entry(const uint8_t *fat, uint32_t fat_len, uint32_t c) {
    uint32_t ofs = c + (c / 2);   /* c * 1.5 */
    if (ofs + 1 >= fat_len) return 0;
    uint32_t v = fat[ofs] | (fat[ofs + 1] << 8);
    return (c & 1) ? (v >> 4) : (v & 0x0FFF);
}

/* ---- walk context (static per ADR-0013; ff_live_map is not reentrant) ---- */
static uint8_t s_sec[4096];       /* directory / blank-scan sector buffer      */
static uint8_t s_fat[4096];       /* first FAT copy (ours is one sector)       */
static uint8_t s_logpg[4096];     /* per-logical-page class, nlog*ppp used     */

static uint32_t s_ss, s_pgsz, s_nlog;
static uint32_t s_fat_len, s_data_start, s_nclusters;

/* Set the page classes of logical byte range [b0, b1) to cls. */
static void mark_bytes(uint32_t b0, uint32_t b1, uint8_t cls) {
    if (b1 > s_nlog * s_ss) b1 = s_nlog * s_ss;
    for (uint32_t p = b0 / s_pgsz; p * s_pgsz < b1; p++) s_logpg[p] = cls;
}

/* A region [start, start+len) whose first `used` bytes are real structure:
 * pages covering the used prefix -> META, the rest -> SLACK (padding). A page
 * holding any in-use structure bytes reads metadata (round up). */
static void mark_region(uint32_t start, uint32_t used, uint32_t len) {
    if (used > len) used = len;
    mark_bytes(start, start + used, CLS_META);
    uint32_t aligned = start + ((used + s_pgsz - 1) / s_pgsz) * s_pgsz;
    if (aligned < start + len) mark_bytes(aligned, start + len, CLS_SLACK);
}

/* Mark a regular file's cluster chain: per cluster, pages covering file bytes
 * -> LIVE, the tail past EOF -> SLACK. Bounded to defeat cyclic corruption. */
static void mark_file(uint32_t start_clus, uint32_t size) {
    uint32_t c = start_clus, i = 0;
    while (c >= 2 && c < s_nclusters + 2 && i <= s_nclusters) {
        uint32_t base = (s_data_start + (c - 2)) * s_ss;   /* SecPerClus == 1 */
        uint32_t covered = (size > i * s_ss) ? (size - i * s_ss) : 0;
        if (covered > s_ss) covered = s_ss;
        uint32_t live_pages = (covered + s_pgsz - 1) / s_pgsz;
        mark_bytes(base, base + live_pages * s_pgsz, CLS_LIVE);
        mark_bytes(base + live_pages * s_pgsz, base + s_ss, CLS_SLACK);
        uint32_t next = fat12_entry(s_fat, s_fat_len, c);
        if (next < 2 || next >= 0x0FF8) break;  /* free/EOC/bad */
        c = next;
        i++;
    }
}

/* Scan one directory sector's 32-B entries (already in s_sec):
 *  - marks regular files' chains (LIVE + SLACK per page),
 *  - collects subdirectory start clusters into subs[] (subs_cap 0 = ignore),
 *  - reports the in-use extent: bytes up to the end-of-dir marker (0x00 first
 *    name byte), or ss when the marker isn't in this sector.
 * Returns 1 when the end marker was found (the directory ends here), else 0. */
static int scan_dir_sector(uint32_t *extent, uint32_t *subs, uint32_t subs_cap,
                           uint32_t *nsubs) {
    for (uint32_t off = 0; off + 32 <= s_ss; off += 32) {
        const uint8_t *ent = s_sec + off;
        if (ent[0] == 0x00) { *extent = off; return 1; }   /* end of directory */
        if (ent[0] == 0xE5) continue;                      /* deleted entry */
        uint8_t attr = ent[11];
        if (attr == 0x0F) continue;                        /* LFN part */
        if (attr & 0x08) continue;                         /* volume label */
        uint32_t clus = (uint32_t)rd16(ent + 26) | ((uint32_t)rd16(ent + 20) << 16);
        if (attr & 0x10) {                                 /* directory */
            if (ent[0] == '.') continue;                   /* '.' / '..' */
            if (clus >= 2 && *nsubs < subs_cap) subs[(*nsubs)++] = clus;
        } else {
            uint32_t size = rd32(ent + 28);
            if (clus >= 2 && size > 0) mark_file(clus, size);
        }
    }
    *extent = s_ss;
    return 0;
}

extern "C" int ff_live_map(uint8_t *out, uint32_t page_size) {
    if (!g_wl_inspect) return -1;
    uint32_t ss = (uint32_t)g_wl_inspect->get_sector_size();
    if (ss == 0 || page_size == 0 || ss % page_size != 0 || ss > 4096) return -1;

    uint32_t nlog = (uint32_t)g_wl_inspect->get_flash_size() / ss;   /* 60 */
    uint32_t ndev = nlog + 1 /*dummy*/ + 3 /*state1,state2,cfg*/;    /* == 64 */
    uint32_t ppp  = ss / page_size;
    if (nlog > 256 || ndev > 256 || nlog * ppp > sizeof(s_logpg)) return -1;

    s_ss = ss; s_pgsz = page_size; s_nlog = nlog;

    g_quiet = 1;

    /* --- 1. boot sector / BPB --- */
    if (read_logical(0, ss, s_sec) != 0) { g_quiet = 0; return -1; }
    if (s_sec[510] != 0x55 || s_sec[511] != 0xAA) { g_quiet = 0; return -1; } /* no FS */
    uint16_t byts_per_sec = rd16(s_sec + 11);
    uint8_t  sec_per_clus = s_sec[13];
    uint16_t rsvd         = rd16(s_sec + 14);
    uint8_t  num_fats     = s_sec[16];
    uint16_t root_ent     = rd16(s_sec + 17);
    uint16_t tot16        = rd16(s_sec + 19);
    uint16_t fatsz16      = rd16(s_sec + 22);
    uint32_t tot_sec      = tot16 ? tot16 : rd32(s_sec + 32);
    if (byts_per_sec != ss || sec_per_clus != 1 /* IDF mkfs: au == WL sector */
            || num_fats == 0 || fatsz16 == 0) {
        g_quiet = 0; return -1;
    }

    uint32_t fat_start  = rsvd;
    uint32_t root_start = rsvd + (uint32_t)num_fats * fatsz16;
    uint32_t root_secs  = ((uint32_t)root_ent * 32 + ss - 1) / ss;
    s_data_start        = root_start + root_secs;
    s_nclusters         = (tot_sec > s_data_start) ? (tot_sec - s_data_start) : 0;

    /* --- 2. first FAT copy in memory; provisional cluster classes --- */
    s_fat_len = (uint32_t)fatsz16 * ss;
    if (s_fat_len > sizeof(s_fat)) s_fat_len = sizeof(s_fat);  /* ours: 1 sector */
    if (read_logical(fat_start, ss, s_fat) != 0) { g_quiet = 0; return -1; }

    memset(s_logpg, PG_FREE, sizeof(s_logpg));
    for (uint32_t c = 2; c < s_nclusters + 2; c++) {
        uint32_t base = (s_data_start + (c - 2)) * ss;
        if (fat12_entry(s_fat, s_fat_len, c) != 0)
            mark_bytes(base, base + ss, PG_ALLOC);
    }

    /* --- 3. fixed metadata regions, used-prefix vs padding per page ---
     * Boot record: 512 B of BPB + signature; the sector remainder (and any
     * further reserved sectors) is padding. FAT copies: FAT12 uses
     * ceil((nclusters+2)*1.5) bytes per copy (entries 0/1 reserved); the rest
     * of each copy can never hold an entry. Root dir extent comes from the
     * entry scan below. */
    mark_region(0, 512, rsvd * ss);
    uint32_t fat_used = ((s_nclusters + 2) * 3 + 1) / 2;
    for (uint32_t f = 0; f < num_fats; f++)
        mark_region((fat_start + (uint32_t)f * fatsz16) * ss, fat_used, (uint32_t)fatsz16 * ss);

    /* --- 4. directory walk: root region, then first-level subdirs --- */
    uint32_t subs[32];
    uint32_t nsubs = 0;
    for (uint32_t rs = 0; rs < root_secs; rs++) {
        uint32_t base = (root_start + rs) * ss;
        if (read_logical(root_start + rs, ss, s_sec) != 0) break;
        uint32_t extent = 0;
        int ended = scan_dir_sector(&extent, subs, 32, &nsubs);
        mark_region(base, extent, ss);
        if (ended) {   /* remaining root sectors are all past the end marker */
            for (uint32_t t = rs + 1; t < root_secs; t++)
                mark_region((root_start + t) * ss, 0, ss);
            break;
        }
    }
    for (uint32_t d = 0; d < nsubs; d++) {
        uint32_t c = subs[d], guard = 0;
        while (c >= 2 && c < s_nclusters + 2 && guard++ <= s_nclusters) {
            uint32_t sec_no = s_data_start + (c - 2);
            if (read_logical(sec_no, ss, s_sec) != 0) break;
            uint32_t extent = 0;
            int ended = scan_dir_sector(&extent, subs, 0, &nsubs); /* no nesting */
            mark_region(sec_no * ss, extent, ss);
            uint32_t next = fat12_entry(s_fat, s_fat_len, c);
            if (ended || next < 2 || next >= 0x0FF8) break;
            c = next;
        }
    }

    /* --- 5. resolve sentinels ---
     * PG_ALLOC: allocated in the FAT but claimed by no directory walk (an
     * orphan/lost chain, or a deeper-nested dir) -> whole cluster LIVE: the
     * FAT says occupied, and mislabeling it free would be a lie.
     * PG_FREE: free in the FAT -> page-granular blank scan: all-0xFF pages
     * ERASED, programmed pages OBSOLETE (stale remnants — "free but not
     * erased" reads as the baseline's reclaimable garbage, distinct from
     * true erased). */
    for (uint32_t L = 0; L < nlog; L++) {
        int has_free = 0;
        for (uint32_t k = 0; k < ppp; k++) {
            uint8_t v = s_logpg[L * ppp + k];
            if (v == PG_ALLOC) s_logpg[L * ppp + k] = CLS_LIVE;
            else if (v == PG_FREE) has_free = 1;
        }
        if (!has_free) continue;
        if (read_logical(L, ss, s_sec) != 0) {
            for (uint32_t k = 0; k < ppp; k++)
                if (s_logpg[L * ppp + k] == PG_FREE) s_logpg[L * ppp + k] = CLS_OBSOLETE;
            continue;
        }
        for (uint32_t k = 0; k < ppp; k++) {
            if (s_logpg[L * ppp + k] != PG_FREE) continue;
            int blank = 1;
            for (uint32_t i = 0; i < page_size; i++)
                if (s_sec[k * page_size + i] != 0xFF) { blank = 0; break; }
            s_logpg[L * ppp + k] = blank ? CLS_ERASED : CLS_OBSOLETE;
        }
    }

    /* --- 6. physical placement through the WL mapping --- */
    memset(out, PG_FREE, ndev * ppp);
    uint32_t s1 = (uint32_t)(g_wl_inspect->inspect_addr_state1() / ss);
    uint32_t s2 = (uint32_t)(g_wl_inspect->inspect_addr_state2() / ss);
    uint32_t cf = (uint32_t)(g_wl_inspect->inspect_addr_cfg() / ss);
    uint32_t du = g_wl_inspect->inspect_dummy_sec_pos();
    if (s1 < ndev) memset(out + s1 * ppp, CLS_WL, ppp);
    if (s2 < ndev) memset(out + s2 * ppp, CLS_WL, ppp);
    if (cf < ndev) memset(out + cf * ppp, CLS_WL, ppp);
    if (du < ndev) memset(out + du * ppp, CLS_WL, ppp);

    for (uint32_t L = 0; L < nlog; L++) {
        uint32_t ps = (uint32_t)(g_wl_inspect->phys_addr_of((size_t)L * ss) / ss);
        if (ps >= ndev || out[ps * ppp] == CLS_WL) continue;
        /* page offset within the sector survives the whole-sector remap */
        memcpy(out + ps * ppp, s_logpg + L * ppp, ppp);
    }

    /* safety net: any physical sector nothing claimed (unexpected) -> blank scan */
    for (uint32_t p = 0; p < ndev; p++) {
        if (out[p * ppp] != PG_FREE) continue;
        if (read_phys(p, ss, s_sec) != 0) { memset(out + p * ppp, CLS_OBSOLETE, ppp); continue; }
        for (uint32_t k = 0; k < ppp; k++) {
            int blank = 1;
            for (uint32_t i = 0; i < page_size; i++)
                if (s_sec[k * page_size + i] != 0xFF) { blank = 0; break; }
            out[p * ppp + k] = blank ? CLS_ERASED : CLS_OBSOLETE;
        }
    }

    g_quiet = 0;
    return 0;
}
