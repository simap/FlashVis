# fix/erase-timing — B18 lane report (erase sweep inverted visibility)

Scope: one bug (B18). Owned files: `web/src/worker-heat.js`, `web/src/session-worker.js`,
`web/src/viz.js` (+ tests). Did NOT touch playground.js / lockstep.js / session-proxy.js /
protocol.js. Only `session-worker.js` (one call site in `handlePull`) needed to change,
plus a regression test in `scripts/session-worker-test.mjs`.

## Verdict on the brief's hypothesis: REFUTED

The brief's leading hypothesis — that erase EventEntries are pushed at EAGER EXECUTION
time and fire in an early burst — is **wrong**. Traced the whole path:

- Execution (`execRealEntry` / `subscribeDevice`) only CAPTURES the device erase op into
  `captureBatch` and QUEUES it onto `pbQueue` (as a per-page step). It does NOT push to
  the events ring.
- The erase EventEntry is pushed from `drain()` (the metered player) at the START of the
  erase step's playback slot (`if (!step.started) { … events.push({kind:'erase', … ms: eraseMs(ps.ns)}) }`),
  with `ms = clamp(ns/scale, 110, 9000)`. This is exactly OLD viz.js's `runStep` → `sweep`
  during the timed `frame()` drain. Emission timing AND duration were already correct and
  already paced. Confirmed with a headless probe: at slow scale the erase is emitted with
  `ms=7090` (deep slow-mo) / `ms=709` (33× slow-mo) — LONGER at slower speed, correct
  direction. So neither the emission locus nor the `eraseMs` formula is the bug.

## Actual root cause: an events-ring cursor off-by-one at the PULL boundary

The erase EventEntry reaches the ring correctly, but the coordinator's PULL DROPS it at
slow speed. The impedance mismatch:

- `worker-rings.js`: `head` = `nextId` = ONE PAST the highest id issued; `since(s)` is
  EXCLUSIVE (`id > s`).
- `playground.js` (the consumer, not ours): each frame sets `eventsSince = frame.eventHead`
  (line 425) and pulls `events: { since: eventsSince }` (line 438) — i.e. it feeds the
  one-past `head` back as an exclusive lower bound.
- Result: the next erase pushed gets `id === eventHead`, and `id > eventHead` excludes it.
  The BOUNDARY event of every pull window is dropped.

Why this reads as "visible at fast, invisible at slow" (the inversion):
- FAST / no-delay: MANY erases land per frame, so dropping the first of each pull window is
  invisible (the other 8 of 9 still animate).
- SLOW-MO: execution is scale-backpressured and playback is slow, so EXACTLY ONE erase lands
  between pulls — and it is precisely the dropped boundary event. Zero erases surface. The
  ~2.8× threshold the report noted is just where enough erases per frame accumulate that
  some survive the drop.

Headless proof (real `device.js` timing via the stub runner, `scripts/…/probe2.mjs`), erases
that SURFACED through the head-as-since cursor, before vs after:

| scale        | speed          | pre-fix erases | post-fix erases | erase ms |
|--------------|----------------|----------------|-----------------|----------|
| 1e8          | no-delay       | 60             | 60              | 110      |
| 1e6          | real-time      | 21             | 60              | 110      |
| 3e5          | ~3× slow-mo    | **0**          | 60              | 110      |
| 3e4          | ~33× slow-mo   | **0**          | 55*             | **709**  |
| 3000         | deep slow-mo   | **0**          | 12*             | **7090** |

(*fewer only because the fixed-length probe hit its frame cap mid-drain — each sweep is
seconds long. Dedup check: exactly one surfacing per erase id, zero duplicates.)

## The fix

`session-worker.js` `handlePull`, events branch only (one line + comment):

    - events.since(m.events.since, m.events.limit)
    + events.since((m.events.since ?? 0) - 1, m.events.limit)

`handlePull` is the one place in OUR code that knows the wire protocol (that the consumer's
`since` is derived from the `eventHead` we reported). Bridging `head` (one-past) to an
INCLUSIVE lower bound there — `id >= head` — makes every event pushed at or after the
reported head surface exactly once. Chosen over editing `worker-rings.js` (shared, not
owned) or reporting a different `eventHead` (changes the §7 wire value other readers/tests
depend on). No historical replay: ids below the reported head were already seen, or reset
past on focus switch via the `{ newest: true, limit: 0 }` head-seed (B4/B11 path, untouched).

## Verification

- Behavioral (load-bearing): at slow-mo an erase now surfaces and holds for a long scaled
  duration (709ms at 33×, 7090ms at deep slow-mo); at fast it flashes at 110ms; no longer
  inverted. Each erase surfaces exactly once (no double-animation).
- New regression `scripts/session-worker-test.mjs` §8 (B18): drives gc erases at 33× slow-mo,
  pulls with the playground `eventHead`-as-`since` convention, asserts ≥10/12 erases surface,
  zero duplicates, and `ms > 300`. Confirmed it FAILS pre-fix (0/12, 0ms) and PASSES post-fix
  (12/12, 709ms).
- Suites green (real WASM built: fastffs + littlefs): session-worker, worker-conformance,
  coord-wire, lockstep-concurrency (§13), viz-frame, tape-leak.

## Open / adjacent (NOT fixed — out of B18 scope)

- The JOURNAL ring shares the identical off-by-one: `playground.js` feeds `journalHead` back
  as `journalSince` the same way, so the boundary tape line of each pull window is dropped
  too. Less visually obvious than a missing erase sweep, and touching the journal branch
  risks the tape suite, so I left it for B18. **Now fixed as B19 — see the follow-up below.**

---

# B19 follow-up — journal ring off-by-one (same root as B18)

Logged as B19 after B18. Same root cause: `worker-rings.js` `head` = `nextId` (one-past-last),
`since()` exclusive (`id > since`), consumer (`playground.js`) feeds `journalHead` back as
`journalSince`. So the boundary tape line of every pull window is dropped; at slow-mo exactly
one journal entry lands per window (= the dropped one), so tape lines go missing at slow speed.

## The fix

`session-worker.js` `handlePull`, JOURNAL branch — the same inclusive-lower-bound bridge B18
applied to the events branch:

    - journal.since(m.journal.since, m.journal.limit)
    + journal.since((m.journal.since ?? 0) - 1, m.journal.limit)

Kept it symmetric with the already-merged events bridge rather than refactoring the shared
root in `worker-rings.js` (which would mean reverting the merged/verified events bridge and
re-touching the events path — churn on a shipped surface for elegance, which the brief
cautioned against). `worker-rings.js` was untouched.

No duplicate tape lines: the bridge does not re-return already-seen ids across pulls (the next
window is `id >= reported head`), and the consumer additionally dedups by monotonic id via
`tapeSeen` (playground.js:235) — belt and suspenders.

## Verification

- Extended the B18 slow-mo regression (`session-worker-test.mjs` §8) to also pull the JOURNAL
  stream with the `journalHead`-as-`since` cursor: asserts ~24 op lines (12 write + 12 gc)
  surface at 33× slow-mo AND none is returned twice on the wire. Confirmed it FAILS pre-fix
  (0/24 lines — every boundary line dropped) and PASSES post-fix (24/24, 0 duplicates).
- Full suite battery green (real WASM: fastffs + littlefs): session-worker, worker-conformance,
  coord-wire, lockstep-concurrency (§13), viz-frame, **tape-leak, playground-boot** (the two the
  brief flagged as the reason B18 deferred this — both stay green).
