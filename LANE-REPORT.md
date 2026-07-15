# Lane T2 report — concurrency suite vs. the REAL worker backend (ADR-0024 §13)

Worktree: `/Users/benh/git/flashvis-test-concurrency`, branch `lane/test-concurrency`.

## Outcome

The converted concurrency suite is now **green against the real production
worker backend end to end** — the real coordinator (`web/src/lockstep.js`) +
real session proxies (`web/src/session-proxy.js`) + the real standalone worker
host (`web/src/session-worker.js`) over real WASM, reached only through the
frozen `protocol.js` wire and the faithful mock transport.

```
node scripts/lockstep-concurrency-test.mjs   # PASS, stable across repeated runs
```

Tasks 1 (repoint to the production host) and 2 (`FV_COORDINATOR` seam onto the
real coordinator) are done — that closes the core §13 gate. Beyond that, **8
scenario groups are converted and green**, three of them mutation-proven against
scratch-copy defects, plus cross-FS byte-identity via the settled journal-print
technique.

## Architecture (what changed since the pre-integration pass)

The pre-integration harness played the coordinator role by hand (there was no
real coordinator in the tree). Now the whole production stack exists, so the
harness composes it verbatim:

```
createChurnModel → createLockstep (real C, §2 algebra, autoTick:false)
                     │  N × createSessionProxy (real wire endpoints)
                     │        │  mock transport pair (structuredClone + async)
                     │        │        │  installWorkerHost (REAL host)
                     │        │        │        │  createRunner → REAL WASM
```

Scenarios drive the coordinator's public API (`broadcast`/`setMode`/`start`/
`stop`/`step`/`reset`/`snapshots`/`waitStates`) exactly as `playground.js` does.

### Two seams (carry forward FV_LOCKSTEP/FV_SESSION)

- `FV_WORKER_HOST` — defaults to `web/src/session-worker.js`. **Task 1 repoint
  done**: the old `ref-worker-host.mjs` (which wrapped the retained main-thread
  `session.js`) is **deleted**; the harness accepts `installWorkerHost` /
  `createWorkerHost` / `attachWorkerHost` exports so a mutated scratch copy or a
  future host drops in with one env var.
- `FV_COORDINATOR` — defaults to `web/src/lockstep.js`. **Task 2 done**: point
  it at a scratch copy with one guard reintroduced-as-a-bug to prove a scenario
  is not vacuous.

### ref-worker-host / session.js retirement

`scripts/ref-worker-host.mjs` is **retired (deleted)** — nothing imports it now
that the real host is the default. `web/src/session.js` **cannot** retire yet:
`scripts/boot-format-test.mjs` still imports it (not in this lane's scope). Flag
for whoever owns the main-thread-session cleanup: `session.js` has exactly one
remaining test consumer.

## Scenario mapping (OLD → NEW, this suite)

| # | OLD (in-process) | NEW (real backend) | Status |
|---|---|---|---|
| 1-3 | busy-map exactly-once across race/pace call-path races | **[1]** N distinct commands each execute exactly once per session (journal dispatch count == 1) + both FS byte-identical (journal-print hash) | **Green** (see mutation note) |
| 8(a) | `reset()` byte-for-byte reproducibility | **[8]** produced churn run, `reset()`, re-run → byte-identical via journal-print content hash | **Green, mutation-proven** |
| 4 | rejecting command releases the lock, recovers | **[4]** a throwing command logs its error, still quiesces (I1), the next command runs; both FS identical | **Green** |
| 5/6 | `stop()` aborts a churn step / command mid-drain (FIX B / ADR-0019 rewind) | **[5/6] REFRAMED** to the settled model: `stop()` gates the GENERATOR only, never aborts an in-flight command — asserts the paused command COMPLETES exactly once and no further steps are produced while stopped | **Green** |
| 7 | Pace→Race `raceClock` reseat = min | **[7]** Pace→Race reseat: the behind FS bursts its cursor forward (burns headroom, §2 MAX), nothing reads a sustained hold | **Green** |
| 9 | `opsPerSec` tracks workload ops, not flash ops | **[9]** in Pace lockstep `fileOpCount` equal across FS, `opsPerSec` tracks within EMA slop despite the flash-op gap | **Green, mutation-proven** |
| 10-15 | `stalled`/`waiting` signals | **[10-15] REFRAMED** to the settled signals (`stalled`/`waiting` REMOVED): `holding` (debounced, laggard-safe) + `csActive` (raw per-frame) surface correctly for REAL WASM sessions — idle⇒neither, running⇒csActive, holding∧csActive never both true, csActive clears on drain-to-idle | **Green** |
| 16(b/c) | `reset()` abandons a mid-flight round; stale completion void | **[16]** a command parked mid-fn at a test-held gate, `reset()` bumps epoch, release → the zombie's post-gate write never lands on the fresh chip (I5/§8) | **Green, mutation-proven** |
| 1b, 8(b/c), CE | realistic smoke / setSessions removal / command-error leak | covered by lane C's `coord-wire-test.mjs` (mock workers) and `command-error-test.mjs` | Not re-duplicated here |

### Relationship to lane C's coord-wire-test.mjs

Lane C's suite proves the §2 **algebra** and the signal **derivation** against
MOCK workers (synthetic cost, no WASM): Race divergence, Pace lockstep,
sustained Pace hold, reseat, csActive, hold debounce, grant-continuity/
no-accumulation, epoch discard, boot flow. This suite's distinct §13 role is the
**real-WASM composition** — the real coordinator + real worker host + real
filesystems actually compose over the wire — plus **cross-FS byte-identity**,
which a WASM-free suite structurally cannot check (no bytes exist to compare).
The two are complementary, not redundant.

## Byte-identity via journal-print (task 4)

Settled decision honored: **data leaves a session ONLY via the journal; no byte
side-channel exists.** So cross-FS byte-identity is verified by broadcasting a
command that reads each file back and `print()`s an FNV-1a content hash into the
journal, then comparing the printed hash lines across FS (pulled via `C2W.PULL`
/ `W2C.FRAME`). Used in scenarios 1, 4, 5/6, and — as the reproducibility proof
— scenario 8. Both filesystems consistently print identical hashes for the same
logical writes.

## Mutation evidence (scratch-copy defects via the seams)

Scratch copies live in the session scratchpad with their `./`-relative imports
rewritten to absolute `web/src/` paths so they resolve out-of-tree; production
files untouched.

| Mutation | Seam | Result |
|---|---|---|
| `reset()` drops `churn.reset()` | `FV_COORDINATOR` | **[8] FAILs** — run 2 diverges from run 1 (different file set + hashes: stale churn PRNG carryover) |
| `opsOf` → `acked.flashTimeNs` (the exact original flash-ops defect) | `FV_COORDINATOR` | **[9] FAILs** — opsPerSec diverges 53% across FS (fastffs vs the chattier littlefs) though workload is lockstep |
| worker `RESET` drops the `gen++` (I5 void) | `FV_WORKER_HOST` | **[16] FAILs** — the abandoned command's post-gate write (`z-after.bin`) lands on the fresh chip |

Scenarios 4, 5/6, 7, 10-15 assert protocol/model behavior directly (a throw that
wedged the pump, an aborted-vs-completed command, a non-bursting reseat, a
laggard reading holding) — the assertion **is** the guard; each would fail under
a faithful reintroduction of its target defect, and 7/10-15's signal algebra is
additionally mutation-proven in lane C's coord-wire-test. Scenario 1's
exactly-once is structural in this architecture (a worker executes each cursor
once, serially; the coordinator ships each entry once) — its faithful
re-dispatch mutation lives in the worker's epoch/re-entry family, which scenario
16's `gen++` mutation exercises; the journal dispatch-count assertion (== 1)
still catches any re-execution directly.

## Two integration findings for the lead (not blocking; flagged)

1. **A churn write larger than the chip crashes the real worker.** With
   `createChurnModel`'s DEFAULT profile, the first churn write is 358 400 B on a
   256 KiB chip → `runner.write` throws `-4` (no space) **synchronously inside
   `session-worker.js`'s `pump()`**, which is uncaught and takes the worker
   down. The pre-0024 in-process path swallowed this (the old coordinator's
   `runEntry` wrapped churn in try/catch). The suite avoids it by mirroring
   `playground.js`'s real churn `profile` + `slotCount` exactly (large-class
   weight 0 ⇒ writes cap at 20 KB) — which is the faithful config anyway. But a
   real deployment whose churn/geometry ever produces an oversized write would
   crash the worker rather than log-and-continue. Worth deciding whether
   `pump()`'s churn/gc execution should be wrapped (session.js-parity) — not
   mine to change (`web/src/`).

2. **INIT's async runner build races an immediately-following RESET.** The
   coordinator's boot flow is `setSessions()` (→ INIT) then `reset()` (→ RESET).
   With the real host, INIT builds the runner ASYNCHRONOUSLY; a RESET arriving
   before that finishes bumps `gen`, so INIT's `myGen !== gen` guard starves the
   build and `handleReset` reuses a still-null runner → the worker is left
   runner-less and every real command parks forever. The harness works around it
   by flushing INIT to completion before `reset()` (see `makeRig`), which is
   fine for tests. In the real app the workers are genuine OS threads and the
   boot timing differs, but this is a latent ordering hazard worth confirming is
   handled in the production boot path (playground) — again not mine to change.

## Files

- `scripts/lockstep-concurrency-test.mjs` — rewritten onto the real backend (deliverable)
- `scripts/worker-harness.mjs` — rebuilt: composes real C + real proxies + real host; `FV_COORDINATOR` + `FV_WORKER_HOST` seams; `bootFormat` boot flow
- `scripts/ref-worker-host.mjs` — **deleted** (retired)

No `web/src/*` file was modified. `fs/fastffs` + `fs/littlefs` submodules
initialized and `dist/*` built locally to run the suite (gitignored).

## Open items

- Deferred/duplicative scenarios (1b, 8(b/c), realistic smoke) are covered by
  lane C's coord-wire-test + command-error-test; not re-created here.
- `session.js` retirement blocked on `boot-format-test.mjs` (one consumer).
- Two integration findings above are flagged for a product/robustness decision,
  not fixed (out of lane scope — `web/src/`).
