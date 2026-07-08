# Development notes

Working knowledge for picking this up fresh. See [README.md](README.md) for the architecture
and console API, [adr/](adr/) for the decisions, [ROADMAP.md](ROADMAP.md) for what's next.

## Environment

- macOS. Node ≥ 20 (developed on 25). Emscripten via Homebrew (`brew install emscripten`, emcc 6.0.2).
- No npm dependencies — everything is plain ESM plus a zero-dep static dev server.

## Commands

    npm run build:fastffs   # emcc: FASTFFS core + shim → dist/fastffs.mjs (+ .wasm)
    npm run dev             # static server → http://localhost:8017/web/
    npm run test:fastffs    # node: format/mount/write/read over the emulated device
    npm run test:integrity  # node: byte-exact through 3000 ops + GC (backend fidelity)

Rebuild the WASM after any change to `bindings/fastffs/shim.c` or the FASTFFS submodule.
The web JS (`web/src/{device,runner,viz,playground}.js`) is plain ESM — just refresh, no build.
`dist/` is gitignored (build artifact).

## The FASTFFS submodule (important)

- `fs/fastffs` is a submodule of `git@github.com:simap/FASTFFS.git`.
- It is checked out on `main` at commit `c18ab22`, which adds `fffs_inspect_live_map()` to
  `src/fffs_inspect.c` + `include/fastffs/fastffs_inspect.h` (per-page liveness, reusing the
  existing index reachability walk).
- **That commit is on `origin/main`** (pushed), so a fresh clone gets it and the per-page
  obsolete coloring. The former local-only `flashvis-live-map` branch fast-forwarded into `main`
  and is now redundant.
- The build compiles FASTFFS's `CORE_SRCS` list (mirrored in `build/build-fastffs.sh`) + the
  shim. It does **not** use FASTFFS's `verify_flash` host backend — the NOR device is emulated
  in JS (`web/src/device.js`) instead.

## Verifying without a browser

Almost everything is tested headless in node by stubbing a minimal DOM and running the real
modules. `scripts/integrity-test.mjs` and `scripts/fastffs-test.mjs` are the committed guards.
During development I also used throwaway harnesses that stub `document` (getElementById → fake
element, createElement → fake), `matchMedia`, and `requestAnimationFrame`, then
`await import('web/src/playground.js')` and assert against the fake DOM — a "dom-smoke" that
boots the whole playground against the real WASM. Focused variants tested the timed player,
barrier pacing, the live-map, and the dir iterator.

Key rule: **do not define `global.window`** in these harnesses — emscripten would switch to
web mode and fail to load the `.wasm` under node. Defining `document`/`matchMedia`/`rAF` alone
is fine.

## Gotchas and non-obvious decisions

- **NOR program is AND-only.** `device.js` does `flash[i] &= in[i]` — identical to the reference
  `lfs_emubd` (FASTFFS relies on in-place monotonic bit-clearing for footers/commits). You
  physically cannot set a bit to 1 by programming, so there is no "NOR violation" to count — an
  earlier metric that flagged it was wrong and was removed. **Don't re-add it.**
- **`fffs_valid_backend` requires a non-NULL `ctx`.** The shim sets `g_be.ctx = &g_fs`.
- **Animations use the Web Animations API, not CSS `@keyframes`.** The CSS `animation:` shorthand
  didn't honor a reliable per-trigger duration (erases flashed at a fixed rate, or got cut short
  by `animationend` races — worse at fast speed). See [ADR-0009](adr/0009-timed-playback-and-pacing.md).
  There are still dead `@keyframes prog/ping/erase-wash` + `.cell.prog`/`.sector.erasing` rules
  in `index.html` to strip (ROADMAP).
- **inspect is mount-like.** `fffs_inspect_live_map` / `_check` re-discover and replay the
  on-flash index on every call (they don't reuse the mounted FS's cached index). The playground
  only re-walks when the flash changed (a `mapDirty` flag set on program/erase), not on a timer —
  keep it that way.
- **Timing = ESP32-S3 measured preset** (`device.js` `ESP32S3`): read `64522 + 120·bytes`,
  program `5937·bytes`, erase `21_269_000` ns/sector. SPEED = sim-ns per real-ms (`Infinity` =
  no delay). See [ADR-0007](adr/0007-timing-and-inspect.md), [ADR-0009](adr/0009-timed-playback-and-pacing.md).
- **Two FS facades in the playground.** `runner` is the low-level API. `fs` wraps it synchronously
  (used by the auto-workload). `pfs` wraps it *paced* and is what the console sees as `fs` —
  `await` blocks for the op's simulated time via a queue barrier (`viz.barrier`). The workload and
  the Delete button pick victims from `runner.names()` (a JS record of what's been written), never
  a directory scan (the churn model).

## Context

Author: Ben Hencke (github: simap), who also wrote FASTFFS. Priorities from the build sessions:
NOR fidelity, real measurements, truthful metrics (no faked numbers), and locking the simulation
and animation in step. Decisions get an ADR. Commits use plain messages with no attribution
trailers; committed to `main` for this solo project.
