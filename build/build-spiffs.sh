#!/usr/bin/env bash
# Compile SPIFFS (core) + the flashvis shim + liveness hook to a WASM ES module.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -e fs/spiffs/src/spiffs.h ]; then
  echo "fs/spiffs is empty — run: git submodule update --init fs/spiffs" >&2
  exit 1
fi

SPIFFS=fs/spiffs/src
# The SPIFFS core. spiffs_inspect.c only reads the object-lookup table via the public
# spiffs struct + geometry macros, so it needs no core static helpers and is compiled
# as an ordinary extra TU (unlike the LittleFS hook, which #includes lfs.c).
CORE="\
  $SPIFFS/spiffs_cache.c \
  $SPIFFS/spiffs_check.c \
  $SPIFFS/spiffs_gc.c \
  $SPIFFS/spiffs_hydrogen.c \
  $SPIFFS/spiffs_nucleus.c"

mkdir -p dist
# bindings/spiffs is FIRST on the include path so SPIFFS resolves #include "spiffs_config.h"
# to our benchmark-tuned config (bindings/spiffs/spiffs_config.h), never the upstream
# src/default one (which drags in the Linux test harness via params_test.h).
#
# Fixed, non-resizable heap (ADR-0013): no ALLOW_MEMORY_GROWTH, so HEAPU8.buffer stays a
# plain ArrayBuffer. Same 16MB budget / ABORTING_MALLOC and emcc flags as build-littlefs.sh.
# SPIFFS never calls malloc; every buffer (work/fd/cache + handle pools) is a static
# caller-owned buffer sized in bindings/spiffs/shim.c (mirroring esp_spiffs.c).
emcc \
  bindings/spiffs/shim.c bindings/spiffs/spiffs_inspect.c $CORE \
  -I bindings/spiffs -I "$SPIFFS" \
  -Oz -std=c11 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web \
  -sINITIAL_MEMORY=16MB -sABORTING_MALLOC=1 \
  -sEXPORTED_FUNCTIONS=_ff_config,_ff_format,_ff_mount,_ff_unmount,_ff_write,_ff_read,_ff_open,_ff_file_read,_ff_file_write,_ff_file_seek,_ff_file_stat,_ff_file_close,_ff_delete,_ff_exists,_ff_stat,_ff_mkdir,_ff_list,_ff_gc_step,_ff_committed_files,_ff_committed_bytes,_ff_abi_version,_ff_caps,_ff_dir_open,_ff_dir_read,_ff_dir_close,_ff_live_map,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  --js-library build/flash_hal.js \
  -o dist/spiffs.mjs

echo "built dist/spiffs.mjs (+ dist/spiffs.wasm)"
