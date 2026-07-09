#!/usr/bin/env bash
# Compile LittleFS (core) + the flashvis shim to a WASM ES module.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -e fs/littlefs/lfs.h ]; then
  echo "fs/littlefs is empty — run: git submodule update --init fs/littlefs" >&2
  exit 1
fi

LFS=fs/littlefs
CORE="\
  $LFS/lfs.c \
  $LFS/lfs_util.c"

mkdir -p dist
# Fixed, non-resizable heap (ADR-0013): no ALLOW_MEMORY_GROWTH, so HEAPU8.buffer stays a plain
# ArrayBuffer (browser TextDecoder rejects resizable-backed views). The shared 16MB budget is sized
# to hold a whole-file read (= device capacity) of the largest realistic chip, not any FS's own RAM.
# -DLFS_NO_MALLOC: littlefs never calls malloc; every buffer (caches, lookahead, per-file) is a
# static caller-owned buffer sized in bindings/littlefs/shim.c.
emcc \
  bindings/littlefs/shim.c $CORE \
  -I "$LFS" \
  -DLFS_NO_MALLOC \
  -Oz -std=c11 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web \
  -sINITIAL_MEMORY=16MB -sABORTING_MALLOC=1 \
  -sEXPORTED_FUNCTIONS=_ff_config,_ff_format,_ff_mount,_ff_unmount,_ff_write,_ff_read,_ff_open,_ff_file_read,_ff_file_write,_ff_file_seek,_ff_file_stat,_ff_file_close,_ff_delete,_ff_exists,_ff_stat,_ff_mkdir,_ff_list,_ff_gc_step,_ff_committed_files,_ff_committed_bytes,_ff_abi_version,_ff_caps,_ff_dir_open,_ff_dir_read,_ff_dir_close,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  --js-library build/flash_hal.js \
  -o dist/littlefs.mjs

echo "built dist/littlefs.mjs (+ dist/littlefs.wasm)"
