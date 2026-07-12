/*
 * C-callable seam between the FatFs layer (shim.c / diskio.c, plain C) and the
 * C++ wear_levelling glue (wl_hal.cpp). Mirrors the subset of ESP-IDF's
 * wear_levelling.h C API that the FatFs diskio needs (read / write /
 * erase_range / size / sector_size), plus lifecycle helpers that build and
 * tear down the WL_Flash instance over the emulated device.
 */
#ifndef _FLASHVIS_WL_API_H_
#define _FLASHVIS_WL_API_H_

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* When nonzero, WL/Partition reads go through the SILENT HAL import
 * (js_flash_read_quiet): no device event, no stats, no simulated time. The
 * liveness hook and the committed-file walk set it so inspection never
 * perturbs the traffic it visualizes. Shared with the C++ side. */
extern int g_quiet;

/* Record device geometry (before any format/mount). */
void wlfat_config(uint32_t sector_size, uint32_t sector_count);

/* (Re)construct the WL_Flash instance and run WL config()+init() against the
 * CURRENT contents of the emulated device. Idempotent: safe to call before
 * every f_mkfs / f_mount so a device.reset() (which wipes flash to 0xFF) is
 * picked up as a fresh WL volume. Returns 0 on success, negative esp_err on
 * failure. */
int wlfat_up(void);

/* Destroy the WL_Flash instance (frees its temp buffer). */
void wlfat_down(void);

/* WL logical-space I/O used by the FatFs diskio glue. Addresses/sizes are in
 * the WL logical address space (0 .. wlfat_size()); WL remaps to physical. */
int      wlfat_read(uint32_t addr, void *dst, uint32_t size);
int      wlfat_write(uint32_t addr, const void *src, uint32_t size);
int      wlfat_erase_range(uint32_t addr, uint32_t size);
uint32_t wlfat_size(void);         /* usable logical bytes (FatFs volume size) */
uint32_t wlfat_sector_size(void);  /* WL logical sector size (== FatFs sector) */

#ifdef __cplusplus
}
#endif

#endif /* _FLASHVIS_WL_API_H_ */
