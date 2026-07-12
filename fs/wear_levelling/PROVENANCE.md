# ESP-IDF wear_levelling vendoring provenance

**What:** ESP-IDF `wear_levelling` component — the FTL that remaps FatFs's
4096-byte logical sectors across the NOR partition for wear levelling. No
standalone upstream exists; it is extracted from ESP-IDF.

**Vendored from:** ESP-IDF **v5.3.2** — annotated tag object
`6920def9f050fe55df29954a2e8a41350b76b1d2`, dereferencing to commit
**`9d7f2d69f50d1288526d4f1027108e314e8c879f`**, path
`components/wear_levelling/`, retrieved **2026-07-12** via
`raw.githubusercontent.com/espressif/esp-idf/v5.3.2/...`. Files carry their
original `SPDX-License-Identifier: Apache-2.0` headers.

## Files vendored (UNMODIFIED — the WL core)

| file                             | role                                              |
|----------------------------------|---------------------------------------------------|
| `src/WL_Flash.cpp`               | WL algorithm: config/init, dummy-sector rotation, logical↔physical remap (`calcAddr`), state/CRC |
| `src/crc32.cpp`                  | CRC-32 wrapper (forwards to `esp_rom_crc32_le`)   |
| `private_include/WL_Flash.h`     | `WL_Flash` class                                  |
| `private_include/WL_Config.h`    | `wl_config_t` on-flash config struct              |
| `private_include/WL_State.h`     | `wl_state_t` on-flash state struct                |
| `private_include/Flash_Access.h` | backend interface `WL_Flash` drives               |
| `private_include/crc32.h`        | `crc32` class                                     |
| `include/wear_levelling.h`       | public C API (reference; not compiled)            |

**Zero modifications to the WL core.** The maximum-fidelity requirement is met:
`WL_Flash.cpp` and the structs above are byte-for-byte upstream (same
algorithms, on-flash layout, CRC polynomial/semantics). Only the **backend** and
the ESP glue are replaced, in `bindings/fatfs/`:

- **`Partition`** (backend) — `compat/Partition.h` + `wl_hal.cpp`: a
  `Flash_Access` over the three JS HAL imports instead of `esp_partition`.
  `WL_Flash.h` still `#include "Partition.h"`; the core is unaware.
- **ESP stubs** — `compat/esp_err.h` (IDF-matching error codes), `esp_log.h`
  (no-op logs), `esp_random.h` (deterministic LCG seed for `wl_device_id`),
  `esp_rom_crc.h` + `wl_hal.cpp` (`esp_rom_crc32_le` = standard reflected
  CRC-32, same semantics; self-consistent across format/mount on our device).
- **Not vendored:** `wear_levelling.cpp` (C API), `Partition.cpp`,
  `SPI_Flash.cpp`, `WL_Ext_Perf/Safe.*`. The `WL_Ext_*` extensions are only used
  for 512-byte sectors; at `CONFIG_WL_SECTOR_SIZE = 4096` (IDF default)
  `wear_levelling.cpp` instantiates plain `WL_Flash`, which is what
  `bindings/fatfs/wl_hal.cpp` builds directly. The liveness hook reaches WL's
  protected `calcAddr`/state through a `WL_Flash_Inspect` subclass
  (`wl_glue.h`), so the core still needs no edit.

## WL default config (IDF `wear_levelling.cpp`, 4096-sector path)

`wl_partition_start_addr 0`, `wl_page_size 4096`, `flash_sector_size 4096`,
`wl_update_rate 16`, `wl_pos_update_record_size 16`, `version 2`,
`wl_temp_buff_size 32`. On our 256 KiB device this reserves 4 sectors (2 state +
1 cfg + 1 dummy = 16 KiB) and exposes a 240 KiB logical volume to FatFs.
