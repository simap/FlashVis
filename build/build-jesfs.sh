#!/usr/bin/env bash
# Compile JesFS (core: hl + ml) + the flashvis shim, fake-SPI lower layer, and
# native liveness hook to a WASM ES module.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -e fs/jesfs/jesfs.h ]; then
  echo "fs/jesfs is empty — run: git submodule update --init fs/jesfs" >&2
  exit 1
fi

JESFS=fs/jesfs
# JesFS core (high + medium level). The low level (SPI HAL) is provided by our
# ported fake-SPI layer bindings/jesfs/jesfs_ll.c, which decodes JesFS's SPI
# opcodes into the three JS HAL imports.
CORE="\
  bindings/jesfs/jesfs_ll.c \
  bindings/jesfs/jesfs_inspect.c \
  $JESFS/jesfs_hl.c \
  $JESFS/jesfs_ml.c"

mkdir -p dist
# Fixed, non-resizable heap (ADR-0013): no ALLOW_MEMORY_GROWTH, so HEAPU8.buffer stays a plain
# ArrayBuffer (browser TextDecoder rejects resizable-backed views). The shared 16MB budget is sized
# to hold a whole-file read (= device capacity) of the largest realistic chip, not any FS's own RAM.
# JesFS never calls malloc; its RAM is the single static sflash_info, and the shim's pools/buffers
# are all static too.
emcc \
  bindings/jesfs/shim.c $CORE \
  -I "$JESFS" \
  -Oz -std=c11 \
  -Wno-implicit-fallthrough \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web \
  -sINITIAL_MEMORY=16MB -sABORTING_MALLOC=1 \
  -sEXPORTED_FUNCTIONS=_ff_config,_ff_format,_ff_mount,_ff_unmount,_ff_write,_ff_read,_ff_open,_ff_file_read,_ff_file_write,_ff_file_seek,_ff_file_stat,_ff_file_close,_ff_delete,_ff_exists,_ff_stat,_ff_mkdir,_ff_list,_ff_gc_step,_ff_committed_files,_ff_committed_bytes,_ff_abi_version,_ff_caps,_ff_dir_open,_ff_dir_read,_ff_dir_close,_ff_live_map,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  --js-library build/flash_hal.js \
  -o dist/jesfs.mjs

echo "built dist/jesfs.mjs (+ dist/jesfs.wasm)"
