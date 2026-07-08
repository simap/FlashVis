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
- [ ] Geometry controls (sector size/count, program granule) wired through `ff_config`.
- [ ] Strip the now-dead CSS in `index.html`: `@keyframes prog/ping/erase-wash` plus the
      `.cell.prog`/`.sector.erasing` rules, all replaced by the Web Animations API.

## Borrow from FASTFFS later (per Ben)
The FASTFFS repo already contains realistic, cross-filesystem workload and fault machinery we
should reuse rather than reinvent:
- `benchmarks/churn_model/` — a churn workload model (create/replace/delete mixes).
- `benchmarks/vfs_bench_common/` — a common VFS benchmark harness run against multiple
  filesystems (LittleFS, FatFs, JesFS, SPIFFS) — the basis for side-by-side comparison in the viz.
- `tools/fffs_api_crash_sweep.c` — simulates partial writes / power loss during churn; great for
  visualizing crash-safety and recovery.
- `benchmarks/esp32s3_*` — real device configs worth mirroring as presets.

## Later filesystems
- [ ] LittleFS and SPIFFS behind the same shim contract (`fs/*/`), so the playground can load and
      compare drivers on identical workloads.
