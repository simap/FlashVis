/*
 * flashvis <-> JesFS low-level SPI backend (the "fake-SPI" lower layer).
 *
 * JesFS's HAL is SPI-command level: the mid-level driver (jesfs_ml.c) drives a
 * NOR chip by emitting RDID / read-data / page-program / 4K-erase / status-reg
 * opcodes through sflash_spi_write()/sflash_spi_read(). This file is that chip:
 * a tiny SPI-opcode state machine that DECODES those commands back into the
 * three block-level HAL imports flashvis exposes (js_flash_read/prog/erase ->
 * web/src/device.js), so the emulated NOR device sees ordinary read/prog/erase
 * traffic just like the LittleFS and FASTFFS drivers do.
 *
 * Ported directly from the FASTFFS benchmark's jesfs_ll_esp_partition.c
 * (benchmarks/esp32s3_jesfs/main/), which already decodes the JesFS SPI opcodes
 * into esp_partition_read/write/erase_range calls; the only change is swapping
 * those three ESP-IDF calls for flashvis's HAL imports and routing reads through
 * the shim's g_quiet flag so the liveness inspector (jesfs_inspect.c) emits no
 * device events (ADR-0012). No malloc: a single static state struct.
 *
 * RDID answers a plausible Macronix MX25R-series JEDEC id (C2 28) with a density
 * byte derived from the configured geometry (ff_config -> g_density). For the
 * fixed 256 KiB device that density is 0x12 (1<<18 = 262144), i.e. an MX25R2035F
 * (2 Mbit) -- a real member of the same low-power family the benchmark's 4 MB
 * MX25R3235F (density 0x16) belongs to, and comfortably inside JesFS's supported
 * density range (MIN_DENSITY 0x0D .. MAX_DENSITY 0x18, see jesfs_int.h).
 */
#include <stdint.h>
#include <string.h>

#include "jesfs.h"
#include "jesfs_int.h"

/* ---- imports: the emulated NOR chip lives in JS (device.js) ---- */
extern int js_flash_read(uint32_t off, void *buffer, uint32_t size);
extern int js_flash_prog(uint32_t off, const void *buffer, uint32_t size);
extern int js_flash_erase(uint32_t off, uint32_t size);
extern int js_flash_read_quiet(uint32_t off, void *buffer, uint32_t size);

/* Set by the shim during inspection (jesfs_inspect.c): route reads to the silent
 * backend so the liveness walk perturbs no wear/op counters (ADR-0012). */
extern int g_quiet;
/* JEDEC density byte (log2 of total flash bytes), set by ff_config in shim.c. */
extern uint8_t g_density;

/* SPI opcodes JesFS emits (mirrors jesfs_ml.c's private #defines). */
#define CMD_DEEPPOWERDOWN  0xB9
#define CMD_RELEASEDPD     0xAB
#define CMD_RDID           0x9F
#define CMD_WRITEENABLE    0x06
#define CMD_STATUSREG      0x05
#define CMD_READDATA       0x03
#define CMD_BULKERASE      0xC7
#define CMD_PAGEWRITE      0x02
#define CMD_SECTOR4K_ERASE 0x20

/* Post-opcode transfer states (>=128 mean "a read will return payload"). */
enum { ST_IDLE = 0, ST_PAGEWRITE = 1, ST_RDID = 128, ST_STATUS = 129, ST_READDATA = 130 };

typedef struct {
    uint32_t addr;     /* address latched by READDATA / PAGEWRITE / erase */
    uint8_t  selected; /* chip-select asserted */
    uint8_t  state;    /* SPI transfer sub-state (see enum) */
    uint8_t  status;   /* status register: bit0 WIP (always clear here), bit1 WEL */
    uint8_t  powerdown;/* deep-power-down flag (informational) */
} jesfs_ll_t;

static jesfs_ll_t s_ll;

/* ---- SPI HAL required by jesfs_ml.c (declared in jesfs_int.h) ---- */

void sflash_wait_usec(uint32_t usec) {
    (void)usec; /* synchronous emulation: device time is modeled in JS, not here */
}

int16_t sflash_spi_init(void) {
    s_ll.addr = 0xffffffffu;
    s_ll.selected = 0;
    s_ll.state = ST_IDLE;
    s_ll.status = 0;
    s_ll.powerdown = 0;
    return 0;
}

void sflash_spi_close(void) {
}

void sflash_select(void) {
    s_ll.selected = 1;
    s_ll.state = ST_IDLE;
}

void sflash_deselect(void) {
    s_ll.selected = 0;
}

void sflash_spi_read(uint8_t *buf, uint16_t len) {
    if (!s_ll.selected || s_ll.state < 128) {
        memset(buf, 0xff, len);
        return;
    }

    switch (s_ll.state) {
    case ST_RDID:
        if (len >= 3) {
            buf[0] = (uint8_t)(MACRONIX_MANU_TYP_RX >> 8); /* 0xC2 */
            buf[1] = (uint8_t)MACRONIX_MANU_TYP_RX;        /* 0x28 */
            buf[2] = g_density;                            /* 0x12 for 256 KiB */
        }
        s_ll.state = ST_IDLE;
        break;

    case ST_STATUS:
        if (len >= 1) {
            buf[0] = s_ll.status;
        }
        s_ll.status &= (uint8_t)~1u; /* WIP self-clears: writes/erases are instant */
        break;

    case ST_READDATA: {
        int rc = g_quiet ? js_flash_read_quiet(s_ll.addr, buf, len)
                         : js_flash_read(s_ll.addr, buf, len);
        if (rc) {
            memset(buf, 0xff, len);
        }
        s_ll.addr += len;
        break;
    }

    default:
        memset(buf, 0xff, len);
        break;
    }
}

void sflash_spi_write(const uint8_t *buf, uint16_t len) {
    if (!s_ll.selected || len == 0) {
        return;
    }

    if (s_ll.state == ST_IDLE) {
        switch (buf[0]) {
        case CMD_DEEPPOWERDOWN:
            s_ll.powerdown = 1;
            break;
        case CMD_RELEASEDPD:
            s_ll.powerdown = 0;
            break;
        case CMD_RDID:
            s_ll.state = ST_RDID;
            break;
        case CMD_WRITEENABLE:
            s_ll.status |= 2; /* WEL */
            break;
        case CMD_STATUSREG:
            s_ll.state = ST_STATUS;
            break;
        case CMD_READDATA:
            if (len >= 4) {
                s_ll.addr = ((uint32_t)buf[1] << 16) |
                            ((uint32_t)buf[2] << 8) |
                            (uint32_t)buf[3];
                s_ll.state = ST_READDATA;
            }
            break;
        case CMD_PAGEWRITE:
            if (len >= 4) {
                s_ll.addr = ((uint32_t)buf[1] << 16) |
                            ((uint32_t)buf[2] << 8) |
                            (uint32_t)buf[3];
                s_ll.state = ST_PAGEWRITE;
            }
            break;
        case CMD_SECTOR4K_ERASE:
            if (len >= 4) {
                s_ll.addr = ((uint32_t)buf[1] << 16) |
                            ((uint32_t)buf[2] << 8) |
                            (uint32_t)buf[3];
                (void)js_flash_erase(s_ll.addr, SF_SECTOR_PH);
                s_ll.status &= (uint8_t)~2u; /* WEL clears after the erase */
            }
            break;
        case CMD_BULKERASE:
            (void)js_flash_erase(0, 1UL << g_density);
            s_ll.status &= (uint8_t)~2u;
            break;
        default:
            break;
        }
        return;
    }

    if (s_ll.state == ST_PAGEWRITE) {
        /* JesFS never issues a program that crosses a 256-byte page (SectorWrite
         * chunks on the page boundary); mirror the reference's guard. */
        uint32_t max_page = 256u - (s_ll.addr & 255u);
        if (len > max_page) {
            return;
        }
        (void)js_flash_prog(s_ll.addr, buf, len);
        s_ll.addr += len;
        s_ll.status &= (uint8_t)~2u; /* WEL clears after the program */
    }
}

/* ---- JesFS platform hooks (mirrors benchmarks/.../jesfs_platform_hooks.c) ----
 * jesfs_hl.c pulls these in as user-provided externs. The benchmark backs them
 * with esp_timer / a supply-voltage ADC; flashvis has neither, so time is a
 * fixed epoch (creation_date just has to be a stable non-0xFFFFFFFF value) and
 * the supply check always passes. */
uint32_t _time_get(void) {
    return 0x60000000u; /* 2021-01-14, arbitrary but stable & != 0xFFFFFFFF */
}

int16_t _supply_voltage_check(void) {
    return 0; /* power always OK in emulation */
}
