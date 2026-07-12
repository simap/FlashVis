/*
 * flashvis HAL-backed Partition — the wear_levelling backend replacement.
 *
 * ESP-IDF's WL_Flash core (fs/wear_levelling/) drives its physical flash
 * through a Partition object (a Flash_Access implementation that, on a real
 * chip, wraps an esp_partition_t over SPI-NOR). ADR/brief: keep the WL core
 * byte-for-byte upstream and replace ONLY this backend. So WL_Flash.h still
 * `#include "Partition.h"`, but this Partition forwards read/prog/erase to the
 * three JS HAL imports (build/flash_hal.js -> web/src/device.js), the same
 * emulated NOR chip every other flashvis driver runs on.
 *
 * Implementation + the g_quiet-aware read live in bindings/fatfs/wl_hal.cpp.
 */
#ifndef _FLASHVIS_PARTITION_H_
#define _FLASHVIS_PARTITION_H_

#include "esp_err.h"
#include "Flash_Access.h"

class Partition : public Flash_Access {
public:
    // start_addr/size/sector_size describe the region on the emulated chip;
    // for flashvis the WL partition IS the whole device (start 0).
    Partition(size_t start_addr, size_t size, size_t sector_size);
    ~Partition() override;

    size_t get_flash_size() override;
    size_t get_sector_size() override;

    esp_err_t erase_sector(size_t sector) override;
    esp_err_t erase_range(size_t start_address, size_t size) override;

    esp_err_t write(size_t dest_addr, const void *src, size_t size) override;
    esp_err_t read(size_t src_addr, void *dest, size_t size) override;

    esp_err_t flush() override;

protected:
    size_t start_addr;
    size_t part_size;
    size_t sector_size;
};

#endif /* _FLASHVIS_PARTITION_H_ */
