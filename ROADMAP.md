# Roadmap

Rough order, not a contract. See `adr/` for the decisions behind these.

## Now
- [x] Prove the pipeline: FASTFFS → WASM, driven against the JS NOR device (`npm run test:fastffs`).
- [x] **Wire the visualizer to the live device event stream.** `runner.js` loads
      `dist/fastffs.mjs`, attaches `device.js`, and `viz.js` replays `prog`/`erase`/`read`
      events onto the die. Fills reconstruct from real events; write-amp / erases / violations
      are read off the device.
- [x] **Playground:** control panel (write / gc / format) plus a JS console over the FS API,
      with a self-pacing auto-workload.

## Next
- [x] Simulated flash timing (ESP32-S3 preset) + timed playback + per-op timing log.
- [x] Inspect: per-sector roles (index / live / obsolete / erased) via footer decode; live·garbage·free bar.
- [x] **Per-record obsolete coloring.** `fffs_inspect_live_map` (added to FASTFFS on branch
      `flashvis-live-map`, reusing its reachability walk) yields a per-page erased/metadata/
      obsolete/live map; the die tints each page and the live·garbage bar is now exact.
- [x] **Background-GC ratio slider.** Workload splits between foreground file ops and
      background GC steps; turn GC down to watch FASTFFS fall into foreground/inline GC —
      write times spike in the op log and garbage piles up.
- [x] **Timed playback + await-pacing.** Ops cost real ESP32-S3 flash time; a timed player
      scales them to real time (SPEED: slow-mo → real-time → no-delay); `await fs.op()` blocks
      for the op's simulated time. See [ADR-0009](adr/0009-timed-playback-and-pacing.md).
- [x] **Streaming `ls`** via the `fffs_dir_open`/`dir_read`/`dir_close` iterator — entries
      stream at sim pace instead of one blob.
- [x] **Churn-model file tracking** (`runner.names()`) — the workload and Delete pick from a
      recorded file set, so a step never scans the directory first.
- [x] **`fffs_inspect_live_map` upstreamed to FASTFFS `main`** (`c18ab22`, pushed to
      `origin`). A fresh clone now gets per-page obsolete coloring; the parent gitlink already
      pointed at this SHA, so no submodule bump was needed.
- [x] Strip the now-dead CSS in `index.html`: `@keyframes prog/ping/erase-wash` plus the
      `.cell.prog`/`.cell.ping`/`.sector.erasing` rules, all replaced by the Web Animations API.
- [x] **Port the FASTFFS churn model to JS** (`web/src/churn.js`). Byte-exact PRNG/event
      sequence (reproduces FASTFFS benchmark runs; feeds every FS the same logical workload for
      lockstep), idiomatic JS above the PRNG. A target live size fills toward a steady state
      instead of monotonically overfilling. See [ADR-0010](adr/0010-churn-model-in-js.md).
- [x] **Console FS API sweep.** A two-tier console surface — friendly top-level pokes
      (`writeFile`/`readFile`/`deleteFile`/`ls`/`getFiles`, all paced, returning descriptors so a
      script self-tracks) over a raw handle-based `fs.` layer (`fs.open`/`fs.openDir` file/dir
      proxies with partial/seeked I/O, stat, prefix), on a static handle pool in the shim, plus a
      setup-mode toggle. Brings the shim ABI to its final shape **before** LittleFS, so the second
      driver is built against it. See [ADR-0014](adr/0014-console-fs-api.md).
- [ ] **Integrate LittleFS**: submodule under `fs/littlefs/`, a `bindings/littlefs/shim.c`
      onto the same three HAL imports and the uniform shim ABI ([ADR-0011](adr/0011-uniform-fs-driver-abi.md)),
      WASM build, plus a native `lfs_inspect.c` liveness hook ([ADR-0012](adr/0012-per-fs-liveness-inspect.md)).
- [ ] **UI: switch filesystem implementation.** A control to pick which FS drives the die;
      switching is simple — fresh state, no cross-FS carryover. Rides on the FS-agnostic
      `runner.js` from [ADR-0011](adr/0011-uniform-fs-driver-abi.md).
- [ ] **UI: lockstep multiple filesystems.** Run the same deterministic churn workload across
      several FS implementations in parallel; the UI switches which die/log view is shown (each
      FS has its own timing, so logs and playback pace differ). Two modes:
  - **Race** — each FS runs the workload as fast as possible; monitor their progress against
    each other.
  - **Pace** — the simulation paces to the slowest FS so all stay at the same workload step
    (files in sync, die images directly comparable), while tracking each FS's total active time.
- [ ] **Churn workload tuning knobs.** Expose the churn model's parameters in the UI — target
      live size, file-size distribution, create/replace/delete mix, seed — so the workload can be
      shaped (and reproduced) instead of hardcoded. (Later — the hardcoded model is fine for
      testing as is; this is more an exploration nicety.)

## Borrow from FASTFFS later
The FASTFFS repo has more reusable workload and fault machinery worth pulling rather than
reinventing (the churn model and VFS workloads are already promoted into **Next** above):
- `tools/fffs_api_crash_sweep.c` — simulates partial writes / power loss during churn; the basis
  for a future crash-safety / recovery visualization (nothing on the near roadmap models this yet).
- `benchmarks/esp32s3_*` — more real device configs. The ESP32-S3 *timing* preset is already
  mirrored in `device.js`; these would seed a preset picker if we revisit configurable geometry.

## Later filesystems
Behind the same shim contract (`fs/*/`) — once LittleFS proves the second-driver path and the
switch/lockstep UI above, adding more drivers is mechanical:
- [ ] SPIFFS
- [ ] JesFS
