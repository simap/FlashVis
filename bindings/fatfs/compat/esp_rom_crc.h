/*
 * Minimal esp_rom_crc.h stub for the flashvis fatfs driver.
 *
 * The vendored wear_levelling crc32.cpp forwards to esp_rom_crc32_le (an
 * ESP-ROM routine). We provide a byte-for-byte compatible standard reflected
 * CRC-32 (poly 0xEDB88320, pre/post inversion) in bindings/fatfs/wl_hal.cpp.
 * The WL state/config checksums only need to be self-consistent across a
 * format/mount cycle on our emulated device — we never exchange flash images
 * with a real ESP — so the exact ROM table is not load-bearing; a correct
 * CRC-32 is.
 */
#ifndef _FLASHVIS_COMPAT_ESP_ROM_CRC_H_
#define _FLASHVIS_COMPAT_ESP_ROM_CRC_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t esp_rom_crc32_le(uint32_t crc, uint8_t const *buf, uint32_t len);

#ifdef __cplusplus
}
#endif

#endif /* _FLASHVIS_COMPAT_ESP_ROM_CRC_H_ */
