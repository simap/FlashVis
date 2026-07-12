/*
 * Minimal esp_random.h stub for the flashvis fatfs driver.
 *
 * WL_Flash::initSections() seeds wl_device_id with esp_random(). On a real
 * chip this is a hardware RNG; here it just needs to be a value that stays
 * consistent within a run (the id is written to the WL state and validated on
 * remount). The implementation (bindings/fatfs/wl_hal.cpp) is a deterministic
 * LCG so a formatted image is reproducible.
 */
#ifndef _FLASHVIS_COMPAT_ESP_RANDOM_H_
#define _FLASHVIS_COMPAT_ESP_RANDOM_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t esp_random(void);

#ifdef __cplusplus
}
#endif

#endif /* _FLASHVIS_COMPAT_ESP_RANDOM_H_ */
