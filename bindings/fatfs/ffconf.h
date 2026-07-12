/*----------------------------------------------------------------------------/
/  FatFs Functional Configuration for the flashvis fatfs driver
/----------------------------------------------------------------------------/
/
/ Mirrors ESP-IDF v5.3.2's EFFECTIVE ffconf.h for the FASTFFS ESP32-S3 FAT
/ benchmark: that benchmark's sdkconfig.defaults sets no FATFS/WL overrides, so
/ every value below is IDF's Kconfig DEFAULT resolved to a literal (IDF's
/ ffconf.h reads them as CONFIG_* macros; we can't run Kconfig, so we bake the
/ defaults in and cite each). Provenance and the full derivation live in the
/ fatfs lane report.
/
/ Deviations from IDF's effective config, each forced by the WASM/visualizer
/ environment and with NO effect on the on-flash FAT format:
/   - FF_USE_LFN 1 (IDF default: 0 / FATFS_LFN_NONE). The shared flashvis
/     workload generates 13-char basenames (e.g. "f000-1a2b3c4d.bin") that
/     exceed 8.3; without LFN every write would fail FR_INVALID_NAME. Mode 1
/     (static working buffer) keeps to the fixed-heap discipline (ADR-0013).
/   - FF_FS_REENTRANT 0 (IDF: 1). No FreeRTOS in the sandbox; the driver is
/     single-threaded, so the volume mutex is unnecessary.
/   - FF_MULTI_PARTITION 0 + FF_VOLUMES 1 (IDF: 1 / 2). One WL device, one SFD
/     volume; multi-partition + a 2nd volume exist in IDF to also mount an SD
/     card. Single SFD volume is byte-identical on flash.
/---------------------------------------------------------------------------*/

#define FFCONF_DEF	80286	/* Revision ID (must match ff.h FF_DEFINED) */

/*---------------------------------------------------------------------------/
/ Function Configurations
/---------------------------------------------------------------------------*/

#define FF_FS_READONLY	0
#define FF_FS_MINIMIZE	0
#define FF_USE_FIND		0
#define FF_USE_MKFS		1		/* IDF: FF_USE_MKFS 1 (format support) */
#define FF_USE_FASTSEEK	0		/* CONFIG_FATFS_USE_FASTSEEK default n */
#define FF_USE_EXPAND	1		/* IDF: FF_USE_EXPAND 1 */
#define FF_USE_CHMOD	1		/* IDF: FF_USE_CHMOD 1 */
#define FF_USE_LABEL	0		/* CONFIG_FATFS_USE_LABEL default n */
#define FF_USE_FORWARD	0
#define FF_USE_STRFUNC	0
#define FF_PRINT_LLI	0
#define FF_PRINT_FLOAT	0
#define FF_STRF_ENCODE	3

/*---------------------------------------------------------------------------/
/ Locale and Namespace Configurations
/---------------------------------------------------------------------------*/

#define FF_CODE_PAGE	437		/* CONFIG_FATFS_CODEPAGE default FATFS_CODEPAGE_437 */
#define FF_USE_LFN		1		/* deviation (see header): static LFN working buffer */
#define FF_MAX_LFN		255		/* CONFIG_FATFS_MAX_LFN default 255 */
#define FF_LFN_UNICODE	0		/* CONFIG_FATFS_API_ENCODING default ANSI/OEM */
#define FF_LFN_BUF		255
#define FF_SFN_BUF		12
#define FF_FS_RPATH		0

/*---------------------------------------------------------------------------/
/ Drive/Volume Configurations
/---------------------------------------------------------------------------*/

#define FF_VOLUMES		1		/* deviation: single WL volume (IDF default 2) */
#define FF_STR_VOLUME_ID	0
#define FF_VOLUME_STRS		"RAM","NAND","CF","SD","SD2","USB","USB2","USB3"
#define FF_MULTI_PARTITION	0	/* deviation: single SFD volume (IDF 1) */
#define FF_MIN_SS		512		/* IDF: MIN(FF_SS_SDCARD 512, FF_SS_WL 4096) */
#define FF_MAX_SS		4096	/* IDF: MAX(512, CONFIG_WL_SECTOR_SIZE 4096) */
#define FF_LBA64		0
#define FF_MIN_GPT		0x10000000
#define FF_USE_TRIM		1		/* IDF: FF_USE_TRIM 1 */

/*---------------------------------------------------------------------------/
/ System Configurations
/---------------------------------------------------------------------------*/

#define FF_FS_TINY		0		/* CONFIG_FATFS_PER_FILE_CACHE default y -> per-file cache */
#define FF_FS_EXFAT		0
#define FF_FS_NORTC		0		/* IDF: 0; get_fattime() provided in diskio.c */
#define FF_NORTC_MON	1
#define FF_NORTC_MDAY	1
#define FF_NORTC_YEAR	2022
#define FF_FS_NOFSINFO	0
#define FF_FS_LOCK		0		/* CONFIG_FATFS_FS_LOCK default 0 */
#define FF_FS_REENTRANT	0		/* deviation: single-threaded, no RTOS mutex */
/* Note: R0.15 references neither FF_FS_TIMEOUT nor FF_SYNC_t anywhere in
 * ff.c/ff.h (it uses the ff_mutex_* API, compiled out at FF_FS_REENTRANT 0),
 * so no timeout/sync defines are needed here. */

/* IDF patch knob (not upstream ChaN): heap-allocated FATFS::win / FIL::buf
 * sized to the runtime sector size instead of static BYTE[FF_MAX_SS] arrays.
 * 0 matches the benchmark's effective build: at IDF v5.3.2 the Kconfig option
 * FATFS_USE_DYN_BUFFERS `depends on CONFIG_WL_SECTOR_SIZE_4096` — a CONFIG_-
 * prefixed symbol that doesn't exist in Kconfig namespace, so the dependency
 * never satisfies and the option resolves n (v5.5 dropped the broken depends
 * and made it plain `default n`). Even if it were 1, the only difference is
 * heap-vs-static buffers of identical size (sector size == FF_MAX_SS == 4096)
 * — zero on-flash or device-traffic effect — and static is what ADR-0013/0014
 * want anyway. Defined explicitly so `#if FF_USE_DYN_BUFFER` in the vendored
 * (IDF-patched) ff.c/ff.h never rides on undefined-macro semantics. */
#define FF_USE_DYN_BUFFER	0
