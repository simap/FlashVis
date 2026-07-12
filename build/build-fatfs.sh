#!/usr/bin/env bash
# Compile ChaN FatFs + ESP-IDF wear_levelling (core, unmodified) + the flashvis
# fatfs shim to a WASM ES module. This is the exact stack the FASTFFS ESP32-S3
# FAT benchmark ran (FatFs -> diskio -> WL FTL -> NOR), on our emulated device.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -e fs/fatfs/src/ff.c ]; then
  echo "fs/fatfs is empty — vendored FatFs source is missing (see fs/fatfs/PROVENANCE.md)" >&2
  exit 1
fi
if [ ! -e fs/wear_levelling/src/WL_Flash.cpp ]; then
  echo "fs/wear_levelling is empty — vendored WL source is missing (see fs/wear_levelling/PROVENANCE.md)" >&2
  exit 1
fi

mkdir -p dist
OBJ="$(mktemp -d)"
trap 'rm -rf "$OBJ"' EXIT

INCS="-I bindings/fatfs -I bindings/fatfs/compat -I fs/fatfs/src \
  -I fs/wear_levelling/private_include -I fs/wear_levelling/include"

# Compile C (FatFs core + our diskio/shim) and C++ (WL core + our glue)
# separately so each is built in its own language, then link with em++. The two
# groups can't share one command line: FatFs ff.c is C (implicit void* casts),
# while WL is C++ (classes, placement new), and a single -std can't serve both.
for f in fs/fatfs/src/ff.c fs/fatfs/src/ffunicode.c bindings/fatfs/diskio.c bindings/fatfs/shim.c; do
  emcc -Oz -std=gnu11 $INCS -c "$f" -o "$OBJ/$(basename "$f").o"
done
for f in bindings/fatfs/wl_hal.cpp bindings/fatfs/fat_inspect.cpp \
         fs/wear_levelling/src/WL_Flash.cpp fs/wear_levelling/src/crc32.cpp; do
  em++ -Oz -std=gnu++17 -fno-exceptions -fno-rtti $INCS -c "$f" -o "$OBJ/$(basename "$f").o"
done

# Link. Fixed 16MB non-resizable heap + ABORTING_MALLOC (ADR-0013): shared with
# every driver, sized for whole-file scratch buffers (= device capacity), not
# any FS's own RAM. WL mallocs one small temp buffer internally.
em++ \
  -Oz \
  "$OBJ"/*.o \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web \
  -sINITIAL_MEMORY=16MB -sABORTING_MALLOC=1 \
  -sEXPORTED_FUNCTIONS=_ff_config,_ff_format,_ff_mount,_ff_unmount,_ff_write,_ff_read,_ff_open,_ff_file_read,_ff_file_write,_ff_file_seek,_ff_file_stat,_ff_file_close,_ff_delete,_ff_exists,_ff_stat,_ff_mkdir,_ff_list,_ff_gc_step,_ff_committed_files,_ff_committed_bytes,_ff_abi_version,_ff_caps,_ff_dir_open,_ff_dir_read,_ff_dir_close,_ff_live_map,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  --js-library build/flash_hal.js \
  -o dist/fatfs.mjs

echo "built dist/fatfs.mjs (+ dist/fatfs.wasm)"
