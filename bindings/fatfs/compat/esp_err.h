/*
 * Minimal esp_err.h stub for the flashvis fatfs driver.
 *
 * The vendored ESP-IDF wear_levelling core (fs/wear_levelling/) is compiled
 * outside ESP-IDF, so the handful of esp_err_t values it references are
 * provided here with the SAME numeric values as ESP-IDF's esp_err.h. The WL
 * core only compares against these symbols (never renders esp_err_to_name),
 * so exact values matter only for internal consistency, and these match IDF.
 */
#ifndef _FLASHVIS_COMPAT_ESP_ERR_H_
#define _FLASHVIS_COMPAT_ESP_ERR_H_

#include <stdint.h>
#include <stddef.h>

typedef int esp_err_t;

#define ESP_OK                 0
#define ESP_FAIL               (-1)
#define ESP_ERR_NO_MEM         0x101
#define ESP_ERR_INVALID_ARG    0x102
#define ESP_ERR_INVALID_STATE  0x103
#define ESP_ERR_INVALID_SIZE   0x104
#define ESP_ERR_NOT_FOUND      0x105

#endif /* _FLASHVIS_COMPAT_ESP_ERR_H_ */
