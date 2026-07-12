/*
 * flashvis SPIFFS build configuration (replaces fs/spiffs/src/default/spiffs_config.h,
 * which pulls in the upstream Linux test harness via params_test.h). This one is
 * self-contained: stdint-backed integer types + the ESP32-S3 benchmark tuning that
 * flashvis is meant to visualize.
 *
 * Tuning provenance — the FASTFFS ESP32-S3 SPIFFS benchmark
 * (fs/fastffs/benchmarks/esp32s3_spiffs/sdkconfig.defaults + main/backend_spiffs.c):
 *   SPIFFS_OBJ_NAME_LEN  32   <- CONFIG_SPIFFS_OBJ_NAME_LEN=32
 *   SPIFFS_OBJ_META_LEN   4   <- CONFIG_SPIFFS_META_LENGTH=4 (IDF stores mtime here; see note)
 *   SPIFFS_USE_MAGIC      1   <- CONFIG_SPIFFS_USE_MAGIC=y
 *   SPIFFS_USE_MAGIC_LENGTH 1 <- CONFIG_SPIFFS_USE_MAGIC_LENGTH=y
 *   SPIFFS_CACHE          1   <- CONFIG_SPIFFS_CACHE=y
 *   SPIFFS_CACHE_WR       1   <- CONFIG_SPIFFS_CACHE_WR=y
 *   SPIFFS_PAGE_CHECK     1   <- CONFIG_SPIFFS_PAGE_CHECK=y
 *   SPIFFS_GC_MAX_RUNS  256   <- CONFIG_SPIFFS_GC_MAX_RUNS=256
 *   (log_page_size = 256      <- CONFIG_SPIFFS_PAGE_SIZE=256, set per-mount in shim.c)
 *
 * mtime note: CONFIG_SPIFFS_USE_MTIME is an ESP-IDF *VFS-layer* behavior — IDF writes
 * the mtime into the 4-byte object meta via SPIFFS_update_meta. pellepl SPIFFS has no
 * such macro; it only exposes a generic OBJ_META_LEN. We keep META_LEN=4 for on-disk
 * layout fidelity but do not write mtime (there is no meaningful wall clock in the WASM
 * sandbox, and the brief marks mtime replication optional).
 *
 * Deviations from IDF, both layout-neutral (cosmetic HAL/feature toggles, not tuning):
 *   - SPIFFS_HAL_CALLBACK_EXTRA 0: our HAL callbacks map 1:1 onto the flash imports and
 *     don't need the fs pointer (IDF passes it). Does not affect the on-disk format.
 *   - Stats/visualisation/ix-map compiled out to keep the WASM small; none change layout.
 */
#ifndef SPIFFS_CONFIG_H_
#define SPIFFS_CONFIG_H_

#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stddef.h>

typedef int32_t   s32_t;
typedef uint32_t  u32_t;
typedef int16_t   s16_t;
typedef uint16_t  u16_t;
typedef int8_t    s8_t;
typedef uint8_t   u8_t;

// ---- debug output: all silenced (flashvis reads state via the inspect hook) ----
#ifndef SPIFFS_DBG
#define SPIFFS_DBG(_f, ...)        do {} while (0)
#endif
#ifndef SPIFFS_GC_DBG
#define SPIFFS_GC_DBG(_f, ...)     do {} while (0)
#endif
#ifndef SPIFFS_CACHE_DBG
#define SPIFFS_CACHE_DBG(_f, ...)  do {} while (0)
#endif
#ifndef SPIFFS_CHECK_DBG
#define SPIFFS_CHECK_DBG(_f, ...)  do {} while (0)
#endif
#ifndef SPIFFS_API_DBG
#define SPIFFS_API_DBG(_f, ...)    do {} while (0)
#endif

// debug print formatters (referenced by the DBG format strings even when silenced)
#ifndef _SPIPRIi
#define _SPIPRIi   "%d"
#endif
#ifndef _SPIPRIad
#define _SPIPRIad  "%08x"
#endif
#ifndef _SPIPRIbl
#define _SPIPRIbl  "%04x"
#endif
#ifndef _SPIPRIpg
#define _SPIPRIpg  "%04x"
#endif
#ifndef _SPIPRIsp
#define _SPIPRIsp  "%04x"
#endif
#ifndef _SPIPRIfd
#define _SPIPRIfd  "%d"
#endif
#ifndef _SPIPRIid
#define _SPIPRIid  "%04x"
#endif
#ifndef _SPIPRIfl
#define _SPIPRIfl  "%02x"
#endif

// ---- feature toggles (benchmark tuning) ----
#define SPIFFS_BUFFER_HELP              0

#define SPIFFS_CACHE                    1   // CONFIG_SPIFFS_CACHE=y
#define SPIFFS_CACHE_WR                 1   // CONFIG_SPIFFS_CACHE_WR=y
#define SPIFFS_CACHE_STATS              0

#define SPIFFS_PAGE_CHECK               1   // CONFIG_SPIFFS_PAGE_CHECK=y
#define SPIFFS_GC_MAX_RUNS              256 // CONFIG_SPIFFS_GC_MAX_RUNS=256
#define SPIFFS_GC_STATS                 0

// GC scoring heuristics — upstream defaults (not tuned by the benchmark)
#define SPIFFS_GC_HEUR_W_DELET          (5)
#define SPIFFS_GC_HEUR_W_USED           (-1)
#define SPIFFS_GC_HEUR_W_ERASE_AGE      (50)

#define SPIFFS_OBJ_NAME_LEN             (32) // CONFIG_SPIFFS_OBJ_NAME_LEN=32
#define SPIFFS_OBJ_META_LEN             (4)  // CONFIG_SPIFFS_META_LENGTH=4
#define SPIFFS_COPY_BUFFER_STACK        (64)

#define SPIFFS_USE_MAGIC                (1)  // CONFIG_SPIFFS_USE_MAGIC=y
#define SPIFFS_USE_MAGIC_LENGTH         (1)  // CONFIG_SPIFFS_USE_MAGIC_LENGTH=y

// single-threaded WASM: no locking needed
#define SPIFFS_LOCK(fs)
#define SPIFFS_UNLOCK(fs)

#define SPIFFS_SINGLETON                0    // geometry supplied per-mount by the shim
#define SPIFFS_ALIGNED_OBJECT_INDEX_TABLES 0
#define SPIFFS_HAL_CALLBACK_EXTRA       0    // HAL callbacks take (addr,size,buf) — see header note
#define SPIFFS_FILEHDL_OFFSET           0
#define SPIFFS_READ_ONLY                0
#define SPIFFS_TEMPORAL_FD_CACHE        0    // off: keeps sizeof(spiffs_fd) minimal, layout-neutral
#define SPIFFS_TEMPORAL_CACHE_HIT_SCORE 4
#define SPIFFS_IX_MAP                   0    // not used by the shim
#define SPIFFS_NO_BLIND_WRITES          0    // NOR: blind (all-1s except reset bits) writes are fine
#define SPIFFS_TEST_VISUALISATION       0    // no SPIFFS_vis / printf dependency
#define SPIFFS_SECURE_ERASE             0

#ifndef SPIFFS_TYPES_OVERRIDE
typedef u16_t spiffs_block_ix;
typedef u16_t spiffs_page_ix;
typedef u16_t spiffs_obj_id;
typedef u16_t spiffs_span_ix;
#endif

#endif /* SPIFFS_CONFIG_H_ */
