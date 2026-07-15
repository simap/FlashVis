# Lane W (worker-host) — report

Branch: `lane/worker` in `/Users/benh/git/flashvis-worker`. All commits are on this branch only.

## What I built

- **`web/src/session-worker.js`** — the worker-hostable per-session executor.
  `createWorkerHost(port, opts)` wires onto anything MessagePort-shaped (a real
  dedicated Worker's `self`, or `mock-worker-transport.mjs`'s `workerPort` in
  tests); a bootstrap at the bottom self-attaches to `self` when actually
  loaded as a Worker. Handles `INIT`/`ENTRIES`/`GRANT`/`PULL`/`RESET`, emits
  `GRANT_ACK`/`FRAME`/`TELEMETRY`, exactly per `protocol.js`.
- **`web/src/worker-heat.js`** — headless per-page heat/shown accumulator +
  timed player, ported from `viz.js`'s numeric core (queue drain, per-page
  step expansion, read/prog heat coalescence) with every DOM/animation call
  stripped out. `drain(dtMs, scale, playLimitNs)` implements the §2 gate;
  `snapshotHeat(scale)` computes decay closed-form at PULL time (no worker
  rAF), matching §7. `viz.js` itself is untouched — it keeps only the
  render/DOM half now (another lane's concern).
- **`web/src/worker-rings.js`** — a tiny append-only, monotonic-id ring buffer
  used for both the journal and viz-event logs (`since`/`newest`/`limit`).
- **`scripts/worker-stub-runner.mjs`** — a test-only `runner.js` stand-in.
  `device.js` has no WASM dependency, so this wires a **real** `createNorDevice`
  (real timing, real read/prog/erase events — heat/wear/pacing are exercised
  faithfully) behind a small in-memory file table. `dist/*.mjs` (real WASM) is
  gitignored and absent from this worktree, per the brief.
- **`scripts/session-worker-test.mjs`** — the message-level conformance test,
  driven entirely over `mock-worker-transport.mjs`. Added as
  `npm run test:sessionworker` and appended to the default `npm test`
  aggregate (it needs no WASM/dist, so it's safe in every worktree).

`web/src/session.js` was read for relocation but **left untouched** — see
"What I deliberately did not do" below.

## What I verified (`npm run test:sessionworker`, 15/15 assertions green)

1. **I10** — every `GRANT` is acked on receipt, including a near-zero
   `playLimitNs` (idle/parked ack).
2. **§2 gate + one-op overshoot** — with `playLimitNs:1` and two ready ops,
   execution races ahead (`cursor` reaches 2 immediately — execution is
   instant/synchronous) but `entriesDrained` stops at exactly `0`: the op
   already in flight when the gate was open plays out in full (one-op
   overshoot), but the *second* op's playback never starts past the
   watermark. This is the crux of §2 and was the trickiest thing to get right
   — the gate is checked only **between** ops, never used to interrupt one
   already dequeued.
3. Raising `entryLimit`/`playLimitNs` across further grants lets execution and
   playback both catch up to the tail (`cursor:4`, `entriesDrained:3`).
4. **I1 quiescence-as-ack** — a compiled SOURCE command (two `writeFile`
   calls) actually runs both ops before its `done` journal line lands; the
   command entry's completion is exactly quiescence.
5. `FRAME` shape: `heat` (readHeat/progHeat, full per-page state),
   `shown`+`wear` (correctly sized to geometry), `journalHead`/`eventHead`.
6. `TELEMETRY` fires unconditionally on its own ~250ms cadence with the
   documented payload shape, independent of any PULL.
7. **I5** — a `GRANT` with a mismatched epoch is silently discarded.
8. **`RESET`** — voids `cursor`/`playbackNs`/journal, moves to the new epoch,
   without reloading the WASM module (mirrors `session.js`'s old
   `blankChip()`: `device.reset()` + local-state wipe, not a fresh
   `createRunner()` call).

Also unit-checked all three new modules with `node --check` (pure ESM,
Node-runnable, no bundler needed).

## Design decisions worth flagging

- **`entryBoundaryNs[i]` / `entryBoundaryFileOps[i]`** — per-entry cumulative
  markers I added (not a protocol field) to compute `entriesDrained` as
  "highest index whose boundary `simNs` is `<= playbackNs`" and
  `drainedCounters` as the counters *as of* that boundary. `entriesDrained`
  is `-1` when nothing has drained yet (JS-idiomatic "none" sentinel) — the
  wire field is just `number`, protocol.js doesn't reserve a value for
  "none", so I picked the obvious one. Flagging in case the coordinator lane
  needs a different sentinel convention.
- **`BACKLOG_CAP_OPS = 3000`, `TAPE_CAP_NS = 250ms`** — local tunables for I3
  (`pending < BACKLOG_CAP`, `executedTapeNs − playbackNs < TAPE_CAP`).
  `BACKLOG_CAP_OPS` mirrors the old `lockstep.js` constant; `TAPE_CAP_NS` is a
  new placeholder I picked (no prior value exists anywhere in the repo/ADRs —
  I grepped). Both are explicitly deferred-sizing knobs, same status as
  protocol.js's own ENTRIES-window-size knob — size by measurement later.
- **Command SOURCE compile convention** — `protocol.js` says commands "ship
  as SOURCE text, compiled worker-side with a per-command seed" but doesn't
  pin the exact text shape. I assumed an async-function **expression**
  string, e.g. `"async (api) => { await api.writeFile(...); }"`, compiled via
  `(0, eval)('(' + source + ')')`. If the coordinator lane serializes
  commands differently (e.g. a function body only, or `Function`
  constructor args), this needs to match — flagging as an assumption, not a
  blocking ambiguity.
- **`ls`/`getFiles` scope reduction** — session.js's originals stream a
  per-entry `openDir`/`read`/`close` dance (each its own paced op, ADR-0014).
  My port uses a single `runner.list()` call instead (one paced op). The
  "simple command" bound didn't need the streaming tier; noted in a code
  comment. If the UI needs the animated per-entry stream, this needs
  revisiting — not a protocol issue, just a scope call.
- **Local API surface ported**: `writeFile`, `readFile`, `deleteFile`,
  `mkdir`, `ls`, `getFiles`, `stat`, `gc`, `print`, and a `fs.{format,mount,
  unmount,write,read,remove,exists,fsinfo}` subset. NOT ported: the tier-2
  raw handle/dir API (`fs.open`/`fs.openDir`/`wrapHandle`/`wrapDir`,
  `sectorClasses`/`liveMap` passthroughs) — out of the "churn + gc + a simple
  command" bound. Straightforward to add by following the same `runOp`
  pattern if a lane needs it.
- **Viz-events ring content** — I populate it minimally (`started`/`done` on
  command entries) since the ADR text ("erase sweep, command lifecycle") is a
  UI-consumer-driven shape I don't own the far end of. Not exhaustively
  matched to whatever the renderer lane ends up expecting — flag if it needs
  richer event coverage (e.g. per-erase-sweep events).

## What I deliberately did not do (scope discipline)

- **`session.js` is untouched.** It's still the live import for
  `lockstep.js`/`playground.js` (both off-limits to me). Gutting/replacing it
  now would break the running main-thread app before a coordinator lane
  migrates `lockstep.js` to speak `protocol.js` instead of calling
  `createSession` directly — that migration is cross-lane and not something
  I own. `session-worker.js` is the new, parallel, worker-side executor;
  `session.js` remains the pre-cutover main-thread executor until the
  coordinator lane retires it. This is a deviation from the brief's literal
  phrasing ("refactor session.js into the worker-side executor") in favor of
  not leaving the app broken — flagging explicitly since it's a judgment call,
  not something I want to have silently decided.
- **prep bracket (ADR-0024 §9)** not implemented — not in BOUND's explicit
  scenario list (churn + gc + a simple command). The execution/pump loop has
  no prep-mode branch at all right now.
- **Race/Pace-specific behavior** — none needed; the worker is intentionally
  mode-agnostic per the ADR (cross-session lockstep is the coordinator's, off
  this thread). Nothing to report here, just confirming it was a deliberate
  non-feature, not an oversight.
- Did not attempt to convert `scripts/lockstep-concurrency-test.mjs` (ADR
  §13's "definition of done" mentions this, but it's coordinator-side and
  explicitly not in this lane's BOUND).

## Questions / things the lead may want to weigh in on

1. Is leaving `session.js` untouched (see above) the right call, or did you
   want it gutted/marked deprecated now regardless of the coordinator lane's
   timing?
2. Command SOURCE text shape (assumption above) — confirm or correct before
   the coordinator lane starts emitting real command entries.
3. `entriesDrained: -1` "none yet" sentinel and the two local tunables
   (`BACKLOG_CAP_OPS`, `TAPE_CAP_NS`) — fine as placeholders, or do you want
   them pinned to specific values now?

No protocol.js ambiguities forced a stop — the frozen contract was sufficient
to build against once cross-referenced with the ADR's prose (§6/§7 in
particular carried the detail protocol.js's terse JSDoc summarizes).
