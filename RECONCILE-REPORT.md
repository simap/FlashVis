# Integration reconciliation — ADR-0024 worker-per-session

Branch `integrate/reconcile` in worktree `/Users/benh/git/flashvis-reconcile`.
Four cross-lane mismatches fixed; all five oracle suites GREEN.

## Oracle results (all foreground, no WASM needed — stub runner)

| Suite | Result |
|---|---|
| `node scripts/playground-boot-test.mjs` | PASS (15 checks) — was FAILING on the tape echo |
| `node scripts/coord-wire-test.mjs` | PASS |
| `node scripts/worker-conformance-test.mjs` | PASS |
| `node scripts/session-worker-test.mjs` | PASS |
| `node scripts/viz-frame-test.mjs` | PASS |

## Item 1 — command-source double-wrap + determinism (CRITICAL)

Root cause exactly as briefed: `playground.wrapCommandSource` shipped a complete
`async (api) => {…}` string; the worker's `compileSource` wraps its input in
`with(scope){ return (src); }`, so it merely RETURNED playground's function without
calling it — the body never ran, nothing journalled, tape empty.

Fixes:
- `playground.js`: retired `wrapCommandSource`; `injectCommand` now ships RAW source
  (`coordinator.broadcast(userSrc, userSrc)`). Boot (`help()`/`format()`), console
  input (typed), and buttons (bare verbs, e.g. `writeFile()`) were already bare.
- `session-worker.js`: the inner `api` already carried `text`/`format`/`randomBytes`
  (seeded from the entry's per-command seed, not crypto). Added `help()` (prints a
  worker-side `HELP_TEXT` copy) and, in `startRealCommand`, an ECHO of the raw source
  to the journal as a `› <source>` line (kind `echo`) so every per-FS tape shows what
  was typed/broadcast. `randomBytes` reconfirmed I7-deterministic: seed 42 → identical
  bytes across two sessions, differs from seed 43.

## Item 2 — playground signal API → coordinator csActive/holding (cleanup)

`playground.js` holdTick rewritten to consume the coordinator's pinned contract:
`waitStates()[fsId]` is now `{ csActive, holding }`. CS pin renders RAW `csActive`
(deleted playground's own ~300ms debounce — it lives coordinator-side in lockstep.js
now); the fs-card "holding" label (`.waiting` class) renders the already-debounced
`holding`. Removed `HOLD_SHOW_MS`/`holdSince`/`csActiveOf` and the old bool treatment
of `waitStates()`. No residual `.stalled`/`.waiting`-snapshot refs remain.

## Item 3 — entriesDrained index-vs-count off-by-one (CRITICAL)

`session-worker.js:151` emitted `entriesDrained: cursor` (a COUNT). Coordinator
(`session-proxy.js` init `-1` + max-merge; `lockstep.js` paceAdvance
`entriesDrained >= sharedIndex`) and the mock worker (`mock-worker.mjs`, sets
`entriesDrained = cursor` BEFORE `cursor += 1`) are already INDEX-based — which is
why `coord-wire-test` passed while the real worker was off by one.

Decision (matches protocol.js "highest entry index executed AND tape-drained"):
- `session-worker.js` now emits `entriesDrained: cursor - 1` (highest drained index;
  `-1` when none, since `cursor` is the count in this drain-synchronous model).
- Coordinator side confirmed already index/`-1` based — NOT touched.
- Test oracles updated to index semantics: `worker-conformance-test.mjs` (I1
  tick 3/3 → 0; §9 join `aWithheld`/`bLag`/`bCaughtUp` → `J-1`/`1`/`J-1`) and
  `session-worker-test.mjs` (`=== cursor-1`; final `=== 3`). The `>= J-1` join
  threshold assertions were already correct and left as-is.

## Item 4 — adaptFrame redundancy (minor)

The worker now emits protocol-conformant FRAME field names (verified by
`session-worker-test.mjs` §4: `heat.read/prog`, `shown.pages/wear`,
`liveMap.version/classes`, erase EventEntries in `events`). `adaptFrame` was
therefore an identity shim that ALSO dropped `frame.events` — so erase sweeps
weren't reaching viz. Removed it; `renderTick` now passes the pulled FRAME straight
to `viz.applyFrame(f)`, which additionally restores erase/reset event animations.

## protocol.js

No wire change needed; prose already matched the settled decisions
(`entriesDrained` = "highest entry index executed AND tape-drained"). Not edited.

## Ledger

Settled: all four items; five oracle suites green. Open: none.
