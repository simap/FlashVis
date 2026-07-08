# Development notes

Working knowledge for picking this up fresh — the residue that has no better home. Architecture
and console API live in [README.md](README.md), decisions in [adr/](adr/), what's next in
[ROADMAP.md](ROADMAP.md). Invariants a future edit could break live as comments at the code site;
this file just indexes them.

## Environment

- macOS. Node ≥ 20 (developed on 25). Emscripten via Homebrew (`brew install emscripten`, emcc 6.0.2).
- No npm dependencies — plain ESM plus a zero-dep static dev server. `npm install` does nothing.

## Commands

`package.json` is the source of truth; README lists the user-facing ones. The one-shot:

    npm run ci     # build:fastffs + the three guards (fastffs, integrity, dom-smoke)

Rebuild the WASM (`npm run build:fastffs`) after any change to `bindings/fastffs/shim.c` or the
FASTFFS submodule. The web JS (`web/src/*.js`) is plain ESM — just refresh, no build. `dist/` is
gitignored (build artifact); CI rebuilds it.

## The FASTFFS submodule

- `fs/fastffs` is a submodule of `git@github.com:simap/FASTFFS.git`, checked out on `main` at
  `c18ab22` — which adds `fffs_inspect_live_map()` (per-page liveness, reusing the index
  reachability walk). That commit is on `origin/main`, so a fresh clone gets per-page coloring.
- The build compiles FASTFFS's `CORE_SRCS` list (mirrored in `build/build-fastffs.sh`) + the shim.
  It emulates the NOR device in JS (`web/src/device.js`) rather than using FASTFFS's `verify_flash`
  host backend — see [ADR-0005](adr/0005-real-fs-to-wasm.md).

## Verifying without a browser

`npm run ci` (or `npm test`) runs three headless guards against the real WASM:

- `scripts/fastffs-test.mjs` — pipeline proof: format / mount / write / read plus the device
  traffic the driver issued.
- `scripts/integrity-test.mjs` — byte-exact through 3000 churn ops + GC (backend fidelity).
- `scripts/dom-smoke.mjs` — boots the *whole* playground (viz + control panel + WASM) on a fake
  DOM (`scripts/fake-dom.mjs`), drives a write, and asserts the HUD and op-log reflected it.

`fake-dom.mjs` is reusable for focused variants (timed player, barrier pacing, live-map, dir
iterator). **Key rule, enforced there:** never define `global.window` — emscripten would switch to
web mode and fail to load the `.wasm` under Node. Stubbing `document` / `matchMedia` /
`requestAnimationFrame` / `setInterval` alone is fine.

## Gotchas (indexed to the code)

Non-obvious invariants, each documented where it's enforced — change the code, read the comment:

- **NOR program is AND-only; there is no "violation" metric.** `device.js` `prog` (`flash[i] &= …`).
  A bit can't be set to 1 by programming, so there is nothing to flag — an earlier metric was wrong
  and was removed. Don't re-add it.
- **Liveness inspect is mount-like.** `playground.js` re-walks only when the flash changed
  (`mapDirty`), never on a timer; `ff_live_map` / `ff_sector_classes` replay the on-flash index.
- **Three FS facades.** `runner` (low-level) → `fs` (synchronous, used by the auto-workload) →
  `pfs` (paced — what the console sees as `fs`; `await` blocks for the op's simulated time via
  `viz.barrier`). The workload and Delete pick victims from `runner.names()`, never a dir scan.

Full rationale lives in ADRs: Web Animations API over CSS keyframes
([ADR-0009](adr/0009-timed-playback-and-pacing.md)); ESP32-S3 timing preset and inspect-driven
coloring ([ADR-0007](adr/0007-timing-and-inspect.md), [ADR-0008](adr/0008-live-map-and-background-gc.md)).
The timing constants live in `device.js` (`ESP32S3`) — the one source; don't copy them here.
