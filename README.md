# flashvis

Watch real flash filesystems work. flashvis compiles embedded flash filesystems to
WebAssembly and runs them in the browser against an emulated **NOR** chip, animating every
`program` / `erase` / `read` the driver actually issues. First filesystem: **FASTFFS**.

**Live demo: <https://simap.github.io/FlashVis/>** — real FASTFFS in your browser, no install.

## Status

- ✅ **Real FASTFFS in the browser.** Compiled to WASM, driven against the JS-emulated NOR
  device — format / mount / write / read / delete / list, byte-exact through churn + GC
  (`npm run test:fastffs`, `npm run test:integrity`).
- ✅ **Timed visualizer.** Every op costs real **ESP32-S3 flash time** and plays back scaled to
  it; the SPEED slider runs from slow-mo through real-time to no-delay, with a per-op timing log.
- ✅ **Truthful coloring.** FASTFFS `inspect` drives per-page live / obsolete / metadata tint
  and a live·garbage·free bar, alongside the wear heatmap and write-amplification.
- ✅ **Playground.** Control panel + JS console over the FS API (streaming `ls`, `await`-paced
  ops), a churn auto-workload, and a background-GC ratio slider.
- ⏳ **Next:** geometry controls, upstream the inspect helper, then LittleFS/SPIFFS behind the
  same shim. See [ROADMAP.md](ROADMAP.md).

## How it fits together

    playground  →  ff_write()          WASM: real FASTFFS + a thin C shim (bindings/fastffs)
                     →  backend.program()   the filesystem's own block-device callback
                          →  js_flash_prog()    imported HAL (build/flash_hal.js)
                               →  device.js: NOR-write into a Uint8Array (clears 1→0),
                                             count wear, emit an event
                                    →  viz: animate the affected pages / sector

Because the chip lives in JS, NOR semantics, wear counting, and the event stream come for
free — and write amplification, fragmentation, and wear hotspots are *measured from the real
driver*, not fabricated.

## Principles

- **Real driver, emulated chip.** The actual filesystem runs (compiled to WASM); only the NOR
  device is emulated, and faithfully — AND-only programming, sector erase, wear counted.
- **Measured, not faked.** Write amplification, fragmentation, wear, and op timing come off the
  real driver and a measured device preset — no fabricated numbers.
- **Simulation and animation in lockstep.** The die shows exactly what the driver did, paced to
  real flash time.

## Layout

    bindings/fastffs/shim.c   FASTFFS backend (read/program/erase) + flat WASM API
    build/flash_hal.js        Emscripten JS library: HAL imports → device.js
    build/build-fastffs.sh    emcc build → dist/fastffs.mjs (+ .wasm)
    web/src/device.js         emulated NOR chip: byte program (1→0), sector erase, wear, events
    web/index.html            visualizer (prototype; being rewired to the live event stream)
    fs/fastffs/               FASTFFS (git submodule)
    scripts/                  dev server + node pipeline test
    adr/                      architecture decision records — start at 0005
    ROADMAP.md                what's next

## Prerequisites

- Node ≥ 20
- Emscripten (`brew install emscripten`) — provides `emcc`
- FASTFFS source: `git submodule update --init fs/fastffs`

## Build and prove the pipeline

    npm run build:fastffs    # emcc → dist/fastffs.mjs
    npm run test:fastffs     # real FASTFFS over the emulated NOR chip, in Node

Expected: two files written and one read back, reporting the reads / programs / erases the
driver issued with 0 NOR-rule violations.

## Run the visualizer

    npm run build:fastffs    # once, to produce dist/fastffs.mjs
    npm run dev              # http://localhost:8017/web/

The die animates from real FASTFFS traffic. Drive it with the control panel, the JS console,
or let the auto-workload run. `web/prototype.html` is preserved as the original pure-animation
reference (no WASM).

### Console API

Type `help()` in the console at any time. Everything below is in scope:

| Call | Does | Notes |
|------|------|-------|
| `fs.write(name, data)` | Create or replace a file | `data` = string or `Uint8Array`. Paced. |
| `fs.read(name)` / `cat(name)` | Read a file → bytes / text | Paced. |
| `fs.remove(name)` | Delete a file | Paced. |
| `ls()` / `fs.list()` | List files → `[{name, size}]` | Streams entries one at a time via the `fffs_dir_read` iterator (paced); returns the array. |
| `fs.exists(name)` | → boolean | |
| `gc(n=1)` / `fs.gcStep()` | Run `n` background GC steps | Paced. |
| `fs.fsinfo()` | → `{ files, bytes }` | committed totals |
| `device` | Emulated chip: `flash`, `wear[]`, `stats` | `stats.simNs`, `.reads`, `.programs`, `.erases`, `.programBytes` |
| `fs.geometry` | `{ sectorSize, sectorCount, pageSize, granule }` | |
| `viz` | Player: `pending()`, `setScale(nsPerMs)`, `liveCounts()` | |
| `print(x)` | Log a value to the console | e.g. `for (…) print(await ls())` |
| `randomBytes(n)`, `text(s)` | Make a `Uint8Array` | |

**Paced** calls resolve after the op has played out at the current SPEED, so `await` steps
through in simulated flash time:

```js
for (let i = 0; i < 10; i++) await fs.write(`log_${i}.dat`, randomBytes(500))
```

Without `await` they fire-and-queue (the animation backlogs). The console supports top-level
`await`. **↑/↓** cycle command history (persisted, last 20).

## Adding another filesystem

Drop it under `fs/<name>/`, write `bindings/<name>/shim.c` mapping its block-device
read/program/erase onto the same three HAL imports, and mirror `build/build-fastffs.sh`. The
JS side (`device.js`, runner, viz) is filesystem-agnostic.
