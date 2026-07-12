/*
 * flashvis <-> FatFs/wear_levelling native liveness hook (ADR-0012).
 *
 * Exports ff_live_map: a per-page classification of the die, the shared
 * baseline every flashvis driver produces so the dies compare directly:
 *     0 erased · 1 metadata · 2 obsolete · 3 live-data
 *
 * FAT is a two-layer stack, so the hook composes the FAT *logical* view through
 * the wear_levelling *physical* mapping (the brief's core requirement):
 *
 *   1. Parse the FAT12 volume from logical sectors (boot/BPB, the FAT table,
 *      the fixed root directory) with SILENT WL reads (g_quiet — no device
 *      events), classifying each of the 60 logical sectors:
 *        - boot + reserved, both FATs, root-dir region   -> metadata
 *        - a cluster allocated in the FAT (FAT entry != 0) -> live
 *        - a sub-directory's own clusters                  -> metadata
 *        - a cluster free in the FAT                        -> (resolve below)
 *   2. Map every logical sector to its current PHYSICAL sector via WL's own
 *      logical->physical function (WL_Flash::calcAddr, reached through the
 *      WL_Flash_Inspect subclass — the WL core stays unmodified).
 *   3. WL's own cfg/state sectors (fixed physical addresses) -> metadata; the
 *      WL "dummy" spare sector and any physically-unmapped or FAT-free sector
 *      is split by a blank scan: all-0xFF -> erased, else -> obsolete (stale
 *      data the FTL has not yet reclaimed).
 *
 * Sub-directory reclassification is single-level (the console's mkdir is
 * single-level, ADR-0014); clusters of any deeper nesting would read as live —
 * a documented, cosmetic edge the shared workload never exercises.
 */
#include "wl_glue.h"
#include "wl_api.h"

#include <stdint.h>
#include <string.h>

extern "C" int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

enum { CLS_ERASED = 0, CLS_META = 1, CLS_OBSOLETE = 2, CLS_LIVE = 3, CLS_FREE = 0xFE };

/* Direct PHYSICAL sector read (bypasses WL remapping) for the blank scan of the
 * dummy/overhead sectors — those are addressed by absolute device position. */
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

/* Follow a FAT12 cluster chain from `start`, marking each cluster's logical
 * sector `cls` in logcls[]. Bounded by nclusters to defeat cyclic corruption. */
static void mark_chain(const uint8_t *fat, uint32_t fat_len, uint32_t start,
                       uint32_t data_start, uint32_t nclusters,
                       uint8_t *logcls, uint32_t nlog, uint8_t cls) {
    uint32_t c = start, guard = 0;
    while (c >= 2 && c < nclusters + 2 && guard++ <= nclusters) {
        uint32_t sec = data_start + (c - 2);   /* SecPerClus == 1 */
        if (sec < nlog) logcls[sec] = cls;
        uint32_t next = fat12_entry(fat, fat_len, c);
        if (next < 2 || next >= 0x0FF8) break;  /* free/EOC/bad */
        c = next;
    }
}

extern "C" int ff_live_map(uint8_t *out, uint32_t page_size) {
    if (!g_wl_inspect) return -1;
    uint32_t ss = (uint32_t)g_wl_inspect->get_sector_size();
    if (ss == 0 || page_size == 0 || ss % page_size != 0) return -1;

    uint32_t nlog = (uint32_t)g_wl_inspect->get_flash_size() / ss;   /* 60 */
    uint32_t nphys = (uint32_t)((size_t)g_wl_inspect->get_flash_size()) / ss; /* data region pages */
    uint32_t ndev  = nphys + 1 /*dummy*/ + 3 /*state1,state2,cfg*/;  /* == 64 */
    if (nlog > 256 || ndev > 256 || ss > 4096) return -1;

    static uint8_t sec[4096];
    static uint8_t fat[4096];
    uint8_t logcls[256];
    uint8_t phys[256];
    memset(logcls, CLS_FREE, sizeof(logcls));
    memset(phys, CLS_FREE, sizeof(phys));

    g_quiet = 1;

    /* --- 1. boot sector / BPB --- */
    if (read_logical(0, ss, sec) != 0) { g_quiet = 0; return -1; }
    if (sec[510] != 0x55 || sec[511] != 0xAA) { g_quiet = 0; return -1; } /* no FS */
    uint16_t byts_per_sec = rd16(sec + 11);
    uint8_t  sec_per_clus = sec[13];
    uint16_t rsvd         = rd16(sec + 14);
    uint8_t  num_fats     = sec[16];
    uint16_t root_ent     = rd16(sec + 17);
    uint16_t tot16        = rd16(sec + 19);
    uint16_t fatsz16      = rd16(sec + 22);
    uint32_t tot_sec      = tot16 ? tot16 : rd32(sec + 32);
    if (byts_per_sec != ss || sec_per_clus == 0 || num_fats == 0 || fatsz16 == 0) {
        g_quiet = 0; return -1;
    }

    uint32_t fat_start  = rsvd;
    uint32_t root_start = rsvd + (uint32_t)num_fats * fatsz16;
    uint32_t root_secs  = ((uint32_t)root_ent * 32 + ss - 1) / ss;
    uint32_t data_start = root_start + root_secs;
    uint32_t nclusters  = (tot_sec > data_start)
                        ? (tot_sec - data_start) / sec_per_clus : 0;

    /* fixed metadata regions */
    for (uint32_t s = 0; s < data_start && s < nlog; s++) logcls[s] = CLS_META;

    /* --- 2. FAT table (first copy) -> allocated clusters are live --- */
    uint32_t fat_len = fatsz16 * ss;
    if (fat_len > sizeof(fat)) fat_len = sizeof(fat);        /* our FAT is 1 sector */
    if (read_logical(fat_start, ss, fat) != 0) { g_quiet = 0; return -1; }
    for (uint32_t c = 2; c < nclusters + 2; c++) {
        uint32_t sec_no = data_start + (c - 2);
        if (sec_no >= nlog) break;
        logcls[sec_no] = fat12_entry(fat, fat_len, c) != 0 ? CLS_LIVE : CLS_FREE;
    }

    /* --- 3. sub-directory clusters (single level) -> metadata --- */
    for (uint32_t rs = 0; rs < root_secs; rs++) {
        if (read_logical(root_start + rs, ss, sec) != 0) break;
        for (uint32_t off = 0; off + 32 <= ss; off += 32) {
            uint8_t *ent = sec + off;
            if (ent[0] == 0x00) { off = ss; break; }   /* end of dir */
            if (ent[0] == 0xE5) continue;              /* deleted */
            uint8_t attr = ent[11];
            if (attr == 0x0F) continue;                /* LFN part */
            if (attr & 0x08) continue;                 /* volume label */
            if (!(attr & 0x10)) continue;              /* not a directory */
            if (ent[0] == '.') continue;               /* '.' / '..' */
            uint32_t clus = (uint32_t)rd16(ent + 26) | ((uint32_t)rd16(ent + 20) << 16);
            if (clus >= 2)
                mark_chain(fat, fat_len, clus, data_start, nclusters, logcls, nlog, CLS_META);
        }
    }

    /* --- 4. WL overhead sectors (fixed physical addresses) -> metadata --- */
    uint32_t s1 = (uint32_t)(g_wl_inspect->inspect_addr_state1() / ss);
    uint32_t s2 = (uint32_t)(g_wl_inspect->inspect_addr_state2() / ss);
    uint32_t cf = (uint32_t)(g_wl_inspect->inspect_addr_cfg() / ss);
    if (s1 < ndev) phys[s1] = CLS_META;
    if (s2 < ndev) phys[s2] = CLS_META;
    if (cf < ndev) phys[cf] = CLS_META;

    /* --- 5. map each logical sector to its physical sector --- */
    for (uint32_t L = 0; L < nlog; L++) {
        uint32_t pa = (uint32_t)g_wl_inspect->phys_addr_of((size_t)L * ss);
        uint32_t ps = pa / ss;
        if (ps < ndev) phys[ps] = logcls[L];
    }

    /* --- 6. resolve free / dummy / unmapped physical sectors by blank scan --- */
    for (uint32_t p = 0; p < ndev; p++) {
        if (phys[p] != CLS_FREE) continue;
        if (read_phys(p, ss, sec) != 0) { phys[p] = CLS_OBSOLETE; continue; }
        int blank = 1;
        for (uint32_t i = 0; i < ss; i++) if (sec[i] != 0xFF) { blank = 0; break; }
        phys[p] = blank ? CLS_ERASED : CLS_OBSOLETE;
    }

    g_quiet = 0;

    /* --- 7. expand physical sectors to pages --- */
    uint32_t ppp = ss / page_size;
    uint32_t total = ndev * ppp;
    for (uint32_t i = 0; i < total; i++) out[i] = phys[i / ppp];
    return 0;
}
