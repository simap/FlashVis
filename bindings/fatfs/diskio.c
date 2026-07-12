/*
 * FatFs diskio -> wear_levelling, mirroring ESP-IDF's diskio_wl.c.
 *
 * FatFs sees a single physical drive (pdrv 0): a linear array of 4096-byte
 * logical sectors. Each disk_read/disk_write is forwarded to the WL layer
 * (wl_api.h), which remaps the logical sector to a rotating physical sector for
 * wear levelling before hitting the emulated NOR chip. As in IDF, a write first
 * erase_range()s the target sectors (NOR must be erased before programmed) and
 * then writes — WL turns that into its move-aware erase+program sequence.
 */
#include "ff.h"
#include "diskio.h"
#include "wl_api.h"

DSTATUS disk_initialize(BYTE pdrv) {
    (void)pdrv;
    return 0;
}

DSTATUS disk_status(BYTE pdrv) {
    (void)pdrv;
    return 0;
}

DRESULT disk_read(BYTE pdrv, BYTE *buff, LBA_t sector, UINT count) {
    (void)pdrv;
    uint32_t ss = wlfat_sector_size();
    if (ss == 0) return RES_NOTRDY;
    if (wlfat_read((uint32_t)sector * ss, buff, count * ss) != 0) return RES_ERROR;
    return RES_OK;
}

DRESULT disk_write(BYTE pdrv, const BYTE *buff, LBA_t sector, UINT count) {
    (void)pdrv;
    uint32_t ss = wlfat_sector_size();
    if (ss == 0) return RES_NOTRDY;
    if (wlfat_erase_range((uint32_t)sector * ss, count * ss) != 0) return RES_ERROR;
    if (wlfat_write((uint32_t)sector * ss, buff, count * ss) != 0) return RES_ERROR;
    return RES_OK;
}

DRESULT disk_ioctl(BYTE pdrv, BYTE cmd, void *buff) {
    (void)pdrv;
    uint32_t ss = wlfat_sector_size();
    switch (cmd) {
    case CTRL_SYNC:
        return RES_OK;
    case GET_SECTOR_COUNT:
        if (ss == 0) return RES_NOTRDY;
        *((LBA_t *)buff) = wlfat_size() / ss;
        return RES_OK;
    case GET_SECTOR_SIZE:
        if (ss == 0) return RES_NOTRDY;
        *((WORD *)buff) = (WORD)ss;
        return RES_OK;
    case GET_BLOCK_SIZE:
        /* Erase-block size in units of sectors; WL erases one sector at a
         * time, so 1 (also keeps f_mkfs from over-aligning on our tiny vol). */
        *((DWORD *)buff) = 1;
        return RES_OK;
    }
    return RES_PARERR;
}

/* FatFs timestamp source (FF_FS_NORTC == 0, matching ESP-IDF). No RTC in the
 * WASM sandbox, so return a fixed valid DOS timestamp: 2022-01-01 00:00:00.
 * Timestamps do not affect device traffic, capacity, or liveness. */
DWORD get_fattime(void) {
    return ((DWORD)(2022 - 1980) << 25) | ((DWORD)1 << 21) | ((DWORD)1 << 16);
}
