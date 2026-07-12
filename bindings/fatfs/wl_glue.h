/*
 * C++-only view onto the live WL_Flash instance for the liveness hook.
 *
 * The brief calls for the inspect hook to compose the FAT logical view through
 * the WL logical->physical mapping by reaching WL's mapping directly, WITHOUT
 * modifying the vendored WL core. WL_Flash keeps calcAddr() and the overhead
 * sector addresses protected, so we expose exactly what fat_inspect.cpp needs
 * via a thin subclass (protected members are reachable from a derived class) —
 * the WL core in fs/wear_levelling/ stays byte-for-byte upstream.
 */
#ifndef _FLASHVIS_WL_GLUE_H_
#define _FLASHVIS_WL_GLUE_H_

#include "WL_Flash.h"

class WL_Flash_Inspect : public WL_Flash {
public:
    // WL logical byte address -> absolute physical byte address on the device,
    // applying the current dummy-sector rotation (WL_Flash::calcAddr).
    size_t phys_addr_of(size_t logical_addr) {
        return this->cfg.wl_partition_start_addr + this->calcAddr(logical_addr);
    }
    // Physical addresses of WL's own metadata sectors (fixed, not remapped).
    size_t inspect_addr_cfg()    { return this->addr_cfg; }
    size_t inspect_addr_state1() { return this->addr_state1; }
    size_t inspect_addr_state2() { return this->addr_state2; }
    size_t inspect_state_size()  { return this->state_size; }
    size_t inspect_cfg_size()    { return this->cfg_size; }
    // Usable logical size and page (== flash sector) size.
    size_t inspect_flash_size()  { return this->flash_size; }
    uint32_t inspect_page_size() { return this->cfg.wl_page_size; }
};

/* The single mounted instance, owned by wl_hal.cpp; NULL when down. */
extern WL_Flash_Inspect *g_wl_inspect;

#endif /* _FLASHVIS_WL_GLUE_H_ */
