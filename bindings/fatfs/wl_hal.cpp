/*
 * flashvis <-> ESP-IDF wear_levelling glue.
 *
 * Everything ESP-IDF-specific that the vendored WL core needs, implemented over
 * the flashvis emulated NOR device (the three JS HAL imports). The WL core in
 * fs/wear_levelling/ is compiled UNMODIFIED; this file supplies:
 *
 *   - Partition           the Flash_Access backend WL drives, forwarding
 *                         read/prog/erase to js_flash_* (device.js).
 *   - esp_random()        deterministic LCG (seeds WL's device id).
 *   - esp_rom_crc32_le()  standard reflected CRC-32 (WL state/config checksums).
 *   - WL lifecycle + a small C API (wl_api.h) the FatFs diskio calls.
 *
 * Built with em++ (C++), same fixed-heap emcc flags as the other drivers
 * (ADR-0013). WL's own temp buffer is a small malloc inside the core; the WL
 * instance and Partition use placement new into static storage, mirroring
 * ESP-IDF's wear_levelling.cpp and honoring the static-allocation discipline.
 */
#include "wl_api.h"
#include "wl_glue.h"
#include "Partition.h"
#include "WL_Config.h"

#include <new>
#include <string.h>
#include <stdint.h>

/* ---- emulated NOR chip lives in JS (device.js), bound by flash_hal.js ---- */
extern "C" {
int js_flash_read(uint32_t off, void *buffer, uint32_t size);
int js_flash_prog(uint32_t off, const void *buffer, uint32_t size);
int js_flash_erase(uint32_t off, uint32_t size);
int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);
}

/* Silent-read flag, shared with shim.c / diskio.c / fat_inspect.cpp (wl_api.h). */
extern "C" int g_quiet = 0;

/* ------------------------------------------------------------------ *
 * Partition: the HAL-backed WL backend (replaces IDF Partition/SPI_Flash).
 * ------------------------------------------------------------------ */
Partition::Partition(size_t start, size_t size, size_t ss)
    : start_addr(start), part_size(size), sector_size(ss) {}
Partition::~Partition() {}

size_t Partition::get_flash_size()  { return this->part_size; }
size_t Partition::get_sector_size() { return this->sector_size; }

esp_err_t Partition::read(size_t src_addr, void *dest, size_t size) {
    uint32_t abs = (uint32_t)(this->start_addr + src_addr);
    int rc = g_quiet ? js_flash_read_quiet(abs, dest, (uint32_t)size)
                     : js_flash_read(abs, dest, (uint32_t)size);
    return rc ? ESP_FAIL : ESP_OK;
}

esp_err_t Partition::write(size_t dest_addr, const void *src, size_t size) {
    uint32_t abs = (uint32_t)(this->start_addr + dest_addr);
    return js_flash_prog(abs, src, (uint32_t)size) ? ESP_FAIL : ESP_OK;
}

esp_err_t Partition::erase_sector(size_t sector) {
    uint32_t abs = (uint32_t)(this->start_addr + sector * this->sector_size);
    return js_flash_erase(abs, (uint32_t)this->sector_size) ? ESP_FAIL : ESP_OK;
}

esp_err_t Partition::erase_range(size_t start_address, size_t size) {
    uint32_t abs = (uint32_t)(this->start_addr + start_address);
    return js_flash_erase(abs, (uint32_t)size) ? ESP_FAIL : ESP_OK;
}

esp_err_t Partition::flush() { return ESP_OK; }

/* ------------------------------------------------------------------ *
 * esp_random / esp_rom_crc32_le
 * ------------------------------------------------------------------ */
extern "C" uint32_t esp_random(void) {
    /* Deterministic LCG (Numerical Recipes constants). WL only needs a value
     * that is stable within a run; determinism keeps a formatted image
     * reproducible across test runs. */
    static uint32_t s = 0x1234567u;
    s = s * 1664525u + 1013904223u;
    return s;
}

extern "C" uint32_t esp_rom_crc32_le(uint32_t crc, uint8_t const *buf, uint32_t len) {
    /* Standard reflected CRC-32 (poly 0xEDB88320) with pre/post inversion —
     * matches ESP-ROM's esp_rom_crc32_le semantics. */
    crc = ~crc;
    while (len--) {
        crc ^= *buf++;
        for (int k = 0; k < 8; k++)
            crc = (crc & 1) ? (crc >> 1) ^ 0xEDB88320u : (crc >> 1);
    }
    return ~crc;
}

/* ------------------------------------------------------------------ *
 * WL instance lifecycle + C API
 * ------------------------------------------------------------------ */
WL_Flash_Inspect *g_wl_inspect = nullptr;

/* WL default config constants (ESP-IDF wear_levelling.cpp), for the 4096-byte
 * sector configuration our device uses — see the fatfs report for provenance. */
#define WLFAT_UPDATE_RATE      16   /* WL_DEFAULT_UPDATERATE  */
#define WLFAT_POS_REC_SIZE     16   /* WL_DEFAULT_WRITE_SIZE  */
#define WLFAT_VERSION          2    /* WL_CURRENT_VERSION     */
#define WLFAT_TEMP_BUFF_SIZE   32   /* WL_DEFAULT_TEMP_BUFF_SIZE */

alignas(16) static uint8_t s_part_storage[sizeof(Partition)];
alignas(16) static uint8_t s_wl_storage[sizeof(WL_Flash_Inspect)];
static Partition *s_part = nullptr;

static uint32_t s_dev_ss = 4096;
static uint32_t s_dev_sc = 64;

extern "C" void wlfat_config(uint32_t sector_size, uint32_t sector_count) {
    s_dev_ss = sector_size;
    s_dev_sc = sector_count;
}

extern "C" void wlfat_down(void) {
    if (g_wl_inspect) { g_wl_inspect->~WL_Flash_Inspect(); g_wl_inspect = nullptr; }
    if (s_part)       { s_part->~Partition();              s_part = nullptr; }
}

extern "C" int wlfat_up(void) {
    wlfat_down();
    s_part = new (s_part_storage) Partition(0, (size_t)s_dev_ss * s_dev_sc, s_dev_ss);
    g_wl_inspect = new (s_wl_storage) WL_Flash_Inspect();

    wl_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.wl_partition_start_addr   = 0;
    cfg.wl_partition_size         = (uint32_t)s_dev_ss * s_dev_sc;
    cfg.wl_page_size              = s_dev_ss;   /* SPI_FLASH_SEC_SIZE */
    cfg.flash_sector_size         = s_dev_ss;   /* SPI_FLASH_SEC_SIZE */
    cfg.wl_update_rate            = WLFAT_UPDATE_RATE;
    cfg.wl_pos_update_record_size = WLFAT_POS_REC_SIZE;
    cfg.version                   = WLFAT_VERSION;
    cfg.wl_temp_buff_size         = WLFAT_TEMP_BUFF_SIZE;

    if (g_wl_inspect->config(&cfg, s_part) != ESP_OK) { wlfat_down(); return -1; }
    if (g_wl_inspect->init() != ESP_OK)               { wlfat_down(); return -2; }
    return 0;
}

extern "C" int wlfat_read(uint32_t addr, void *dst, uint32_t size) {
    if (!g_wl_inspect) return -1;
    return g_wl_inspect->read(addr, dst, size) == ESP_OK ? 0 : -1;
}
extern "C" int wlfat_write(uint32_t addr, const void *src, uint32_t size) {
    if (!g_wl_inspect) return -1;
    return g_wl_inspect->write(addr, src, size) == ESP_OK ? 0 : -1;
}
extern "C" int wlfat_erase_range(uint32_t addr, uint32_t size) {
    if (!g_wl_inspect) return -1;
    return g_wl_inspect->erase_range(addr, size) == ESP_OK ? 0 : -1;
}
extern "C" uint32_t wlfat_size(void) {
    return g_wl_inspect ? (uint32_t)g_wl_inspect->get_flash_size() : 0;
}
extern "C" uint32_t wlfat_sector_size(void) {
    return g_wl_inspect ? (uint32_t)g_wl_inspect->get_sector_size() : 0;
}
