#!/usr/bin/env bash
# Compile FASTFFS (core) + the flashvis shim to a WASM ES module.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -e fs/fastffs/include/fastffs/fastffs.h ]; then
  echo "fs/fastffs is empty — run: git submodule update --init fs/fastffs" >&2
  exit 1
fi

FFFS=fs/fastffs
# CORE_SRCS from the FASTFFS Makefile (all index modes compile together).
CORE="\
  $FFFS/src/fastffs.c \
  $FFFS/src/fffs_file.c \
  $FFFS/src/fffs_flash.c \
  $FFFS/src/fffs_index_log.c \
  $FFFS/src/fffs_sector.c \
  $FFFS/src/fffs_sector_reader.c \
  $FFFS/src/fffs_file_md.c \
  $FFFS/src/fffs_ram_index.c \
  $FFFS/src/fffs_hashtable_index.c \
  $FFFS/src/fffs_nocache_index.c \
  $FFFS/src/fffs_bitset.c \
  $FFFS/src/fffs_alloc.c \
  $FFFS/src/fffs_alloc_map.c \
  $FFFS/src/fffs_gc.c \
  $FFFS/src/fffs_inspect.c"

mkdir -p dist
emcc \
  bindings/fastffs/shim.c $CORE \
  -I "$FFFS/include" -I "$FFFS/src" \
  -Oz -std=c11 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_ff_config,_ff_format,_ff_mount,_ff_unmount,_ff_write,_ff_read,_ff_delete,_ff_exists,_ff_list,_ff_gc_step,_ff_committed_files,_ff_committed_bytes,_ff_sector_classes,_ff_live_map,_ff_dir_open,_ff_dir_read,_ff_dir_close,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  --js-library build/flash_hal.js \
  -o dist/fastffs.mjs

echo "built dist/fastffs.mjs (+ dist/fastffs.wasm)"
