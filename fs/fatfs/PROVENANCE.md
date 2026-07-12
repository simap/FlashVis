# FatFs vendoring provenance

**What:** ChaN FatFs — Generic FAT Filesystem Module, **R0.15 w/patch2**
(`FF_DEFINED`/`FFCONF_DEF` = 80286).

**Upstream:** ChaN, http://elm-chan.org/fsw/ff/ (FatFs has no canonical git
repo; ChaN ships versioned release archives).

**Vendored from:** ESP-IDF **v5.3.2** (commit
`9d7f2d69f50d1288526d4f1027108e314e8c879f`),
`components/fatfs/src/`, retrieved **2026-07-12** via
`raw.githubusercontent.com/espressif/esp-idf/v5.3.2/...`.

**Version-choice rationale.** The brief asks for the release matching what
current ESP-IDF vendors, and for the config to mirror IDF's effective ffconf.
IDF v5.3.2 vendors upstream FatFs R0.15 patch2 with a couple of small ESP
patches; its `src/ff.c` is otherwise stock ChaN (it includes only `<string.h>`,
`ff.h`, `diskio.h` — no esp headers). We vendor **IDF's copy** rather than a
separately downloaded elm-chan archive precisely because that IS the code the
FASTFFS ESP32-S3 FAT benchmark compiled and ran — vendoring IDF's copy removes
any risk of patch/config drift between "upstream R0.15" and "what actually ran."
The ChaN copyright/license header in `ff.c`/`ff.h` is intact.

## Files vendored (unmodified) under `src/`

| file            | role                                                      |
|-----------------|-----------------------------------------------------------|
| `ff.c`          | FatFs core (R0.15 patch2)                                 |
| `ff.h`          | FatFs public API + on-disk types                          |
| `ffunicode.c`   | OEM/Unicode tables (only CP437 compiled; needed by LFN)   |
| `diskio.h`      | diskio contract implemented by `bindings/fatfs/diskio.c`  |
| `00readme.txt`  | ChaN release notes                                        |
| `00history.txt` | ChaN revision history                                     |

**Not vendored, and why.** `diskio.c` (IDF's diskio dispatch + `VolToPart`) is
replaced by `bindings/fatfs/diskio.c` (direct WL-backed `disk_*`).
`ffsystem.c` is unneeded: `FF_FS_REENTRANT 0` (no OS mutex) and `FF_USE_LFN 1`
static-buffer mode (no `ff_memalloc`), so nothing references it. `ffconf.h` is
**not** vendored from IDF (it is a wall of `CONFIG_*` Kconfig macros we can't
evaluate outside a build); `bindings/fatfs/ffconf.h` bakes in IDF's resolved
Kconfig **defaults** with per-value provenance and documents the few deviations
(LFN on, single-threaded, single SFD volume) forced by the WASM/visualizer
environment — none of which change the on-flash FAT format.
