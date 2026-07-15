# Lane W (worker-host) — integration-phase report

Branch `lane/worker` @ integrated base a0cf5ed. Files I own/changed this phase:
`web/src/session-worker.js`, `web/src/worker-heat.js` (rewritten), and my tests
`scripts/session-worker-test.mjs`, plus one sanctioned import-line change in
`scripts/worker-conformance-test.mjs`. `web/src/worker-rings.js` unchanged.

## The five follow-ups — all done, verified

**1. PREP BRACKET §9 + seam reconciliation.** `session-worker.js` now exports
`installWorkerHost(port, opts)` (the seam `worker-conformance-test.mjs`
imports; `createWorkerHost` kept as a back-compat alias for my own test).
Repointed that test's default import from `./stub-worker-host.mjs` to
`../web/src/session-worker.js` (the test's own header sanctions updating that
one line, "not the assertions"); `FV_WORKER_HOST` still overrides.

`node scripts/worker-conformance-test.mjs` is **green against my real host** —
all six groups: I1 (quiescence-as-ack), I2 (barrier), I4 (derived limit), I5
(epoch coherence), I10 (grant continuity), **§9 prep bracket join** (entry j
withheld until every session drained j−1, prep entries instant despite a tiny
`playLimitNs`, displayed counters zeroed at `prep(false)`). Re-verified the
stub still passes via `FV_WORKER_HOST=./stub-worker-host.mjs`.

**2. EVENTS ring.** The events ring now carries **only** `EventEntry`s sourced
from device ERASE/reset ops: `{id, kind:'erase', sector, ms}` on each device
`erase` (ms = the worker-computed animated slot `clamp(eraseNs/scale,
110..9000)`, MIN_ANIM at no-delay) and `{id, kind:'reset'}` on device
reset/format. Command lifecycle (`started`/`op`/`done`) lives in the **journal**
ring, never events. viz.js `applyEvents` consumes these for the one-shot
Element.animate() erase sweep — verified in `viz-frame-test` (green) and my own
test (erase events well-formed, no `kind:'command'` leaking into events).

**3. FRAME field naming.** FRAME now emits exactly the pinned typedefs:
`heat={read,prog}` Float32Array[pageCount], `shown={pages:Uint16Array,
wear:Uint32Array}`, `liveMap={version, classes:Uint8Array}` (sent iff
`version>since`), `events:EventEntry[]`, `journalHead`/`eventHead`. Asserted by
`instanceof`/length in my test; consumed cleanly by viz.js.

**4. REAL command source.** Ported ADR-0019's sandbox from playground.js:
`makeSandbox` (Proxy, `has`→true for every name, `get`→api→bag→globalThis,
`set`→bag) + `compileSource` (`new AsyncFunction('scope','with(scope){…}')`,
sloppy so `with` is legal, try-expression-then-statement). The wire ships RAW
console source text; the worker compiles + runs it against the per-session api
(buildLocalApi + `prep`/`format`/`text`/`randomBytes`). Verified end-to-end
against **real fastffs WASM** (built dist): a command
`await format(); for (i=0;i<4;i++) await writeFile('r'+i,800); await gc()`
compiled through the sandbox (bare loop var `i` stays local), ran to
quiescence, real device produced heat/shown/erase-events.

**5. TELEMETRY write-amp.** Added `programBytes` (`device.stats.programBytes`)
and `hostBytes` (`runner.hostBytes`) to the TELEMETRY payload. Real run
reported programBytes/hostBytes = 3351/3200 (WA 1.05). Guarded for the
runner-less case (zeros).

## The architectural reconciliation (the load-bearing decision)

`worker-conformance-test.mjs` is the executable spec, and it encodes a
**drain-synchronous** execution model that my first-phase real-time-ticked
player did not match. So I **rewrote the execution core**:

- On each GRANT the pump executes entries while `cursor < entryLimit AND
  (prepActive OR playbackNs < playLimitNs)`, crediting each entry's cost to
  `playbackNs` immediately — the §2 gate gates **execution**, with one-op
  overshoot (the entry straddling the watermark runs in full, then the gate
  shuts). No worker-side real-time timed player for the currency anymore.
- `playbackNs` is the coordination currency, chunk-granular per frame-grant.
  Cross-frame **animation** smoothness is now the renderer's job (heat
  coalescing + erase `EventEntry.ms`), which is exactly the post-integration
  split (viz.js is a pure FRAME renderer). "Continuous intra-event" for a 21ms
  erase rides `EventEntry.ms`, not worker playback metering.
- **`entriesDrained == cursor`** in this model (execution and drain coincide).
  This is what the conformance suite asserts (`entriesDrained === J` where
  `cursor === J`), so I report `entriesDrained: cursor`. NOTE: this reads
  `entriesDrained` as a **frontier/count** (next-index, = highest-drained-index
  + 1), matching the suite and `cursor`; protocol.js's prose says "highest
  index executed", which taken literally would be `cursor − 1`. The suite (the
  coordinator's encoded expectation) wins. Flagging in case lane C's
  `session-proxy`/`lockstep` expects last-index semantics — if so this is a
  one-line change, but the conformance suite would then need to change too, so
  it needs your call, not mine.

worker-heat.js was rewritten to a **pure eager accumulator** (no timed
queue/drain): each device op applies to shown/heat immediately; decay is
closed-form at snapshot (pull) time. Playback currency left the heat module
entirely (now host-owned).

## Dual entry-payload model (synthetic + real, coexisting)

The conformance suite ships **synthetic-cost** payloads (`{costNs, fileOps,
ticks, prep}`) with no device — and never PULLs — so the §2/§5/§9 state
machine is exercised WASM-free. Production ships **real** payloads (churn
objects / command SOURCE strings). The host detects shape (`costNs`/`prep`/
`ticks` ⇒ synthetic; a string command ⇒ real) and branches. To let the suite
run with no runner, INIT establishes epoch + state machine **synchronously**
and builds the runner in the background; a build failure (no dist module for a
synthetic-only `fsId`) is **non-fatal** (runner-less mode). Real entries park
until a runner exists. This is the only way to satisfy "pass against the real
host" for a suite that is deliberately WASM-free — flagged as the notable
design choice.

## Verified

- `worker-conformance-test` (real host, default) — PASS, all 6 groups incl §9.
- `worker-conformance-test` (`FV_WORKER_HOST=./stub-worker-host.mjs`) — PASS.
- `session-worker-test` (real device via stub runner) — PASS, 21 assertions.
- Real fastffs WASM smoke (built dist) — command to quiescence, FRAME
  populated from the real device, write-amp telemetry.
- Unaffected green: `viz-frame`, `session-client`, `coord-wire`, `tape-leak`,
  `opcount`.

## Out-of-scope issue I hit (NOT mine, flagging)

`npm run test:commanderror` fails at the integrated base with
`TypeError: p.reset is not a function` at `web/src/lockstep.js:325`
(`for (const p of proxies) … p.reset(epoch)`). command-error-test.mjs imports
`lockstep.js` + `session.js`/`session-proxy.js` (lane C / original) and **none**
of my files — the session-proxy the coordinator holds has no `reset(epoch)`
method that lockstep's `reset()` calls. Pre-existing in a0cf5ed, independent of
this lane's changes. Lane C owns `lockstep.js`/`session-proxy.js`; needs a
`reset(epoch)` on the proxy (or lockstep should call whatever the proxy
exposes). Reported, not touched.

## Open questions for the lead

1. `entriesDrained == cursor` (frontier/count) vs protocol.js's "highest
   index" prose (which would be `cursor − 1`). The conformance suite forces the
   frontier reading; confirm that's the intended coordinator contract.
2. The dual synthetic/real payload model + non-fatal runner build — fine as
   the way to keep the conformance suite WASM-free, or do you want the suite
   pointed at a real runner instead (which would require WASM in CI and
   defeats the suite's design)?
3. `command-error-test`'s `p.reset` break (above) — routing to lane C.
