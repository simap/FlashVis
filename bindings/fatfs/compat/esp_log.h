/*
 * Minimal esp_log.h stub for the flashvis fatfs driver.
 *
 * The vendored wear_levelling core is riddled with ESP_LOGx() calls for
 * debugging on a real chip. In the visualizer they would be noise (and pull in
 * ESP-IDF's logging subsystem), so every level is compiled to a no-op that
 * still type-checks its varargs.
 */
#ifndef _FLASHVIS_COMPAT_ESP_LOG_H_
#define _FLASHVIS_COMPAT_ESP_LOG_H_

#define ESP_LOGE(tag, ...) do { (void)(tag); } while (0)
#define ESP_LOGW(tag, ...) do { (void)(tag); } while (0)
#define ESP_LOGI(tag, ...) do { (void)(tag); } while (0)
#define ESP_LOGD(tag, ...) do { (void)(tag); } while (0)
#define ESP_LOGV(tag, ...) do { (void)(tag); } while (0)

#endif /* _FLASHVIS_COMPAT_ESP_LOG_H_ */
