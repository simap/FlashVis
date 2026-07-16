# ADR 0024 — Worker-per-session: formal model (deduped, named)

As `…model.dedup.md`, but wire fields are written by their **protocol name**, not a single-letter
symbol. Symbols survive only where the §2 algebra needs them: `Δ` (chunk), `rel`, the `_s`
subscript, and the math quantifiers. Assumes the reader knows the system (ADRs 0005–0023); bound
concepts are cited, not redefined.

- **Status:** Accepted · **Date:** 2026-07-16 · Amends ADR-0019 (mechanism only)

---

## 0. Terms

```
bound (prior ADRs) — used by name, not redefined:
  session · coordinator
  simNs        execution clock — telemetry-only in this protocol
  playbackNs   player position — the protocol's currency
  scale        SPEED
  cursor       per-session sequence index
  epoch — extended by I5

new in 0024 (each used by its protocol name below):
  baseline        per-session, coordinator-internal, never sent
  playLimitNs     the granted playback ceiling (generalizes raceClock)
  entryLimit      execute-up-to index (Pace: the shared-step target; Race: the shipped frontier)
  entriesDrained  highest entry index executed AND tape-drained
  round           grant id
  rel             per-round release amount (§2)
  relMax, relMin  max / min over sessions of (acked_s − baseline_s) (§2)
  RACE_LEAD_BOUND_FRAMES   N: Race lead cap in chunks (§2 BOUNDED MAX; = 2)
  acked_s         a session's last acked playbackNs
  Δ (chunk)       = scale / targetFPS
```

## 1. Partition

```
worker granularity = one session (runner ⊕ device)
  forced: the device HAL mutates flash in the WASM heap synchronously mid-call
          ⇒ runner and device inseparable; "JS owns the device" ↦ JS-in-a-worker
goal order:  throughput  ≻  main-thread jank
induced:  cross-session rendezvous now spans threads
          ⇒ sync + marshalling off the per-op path (I9); pacing sub-op-fine at slow scale (§2)
```

## 2. Clock-release algebra  (new — the core of 0024)

```
playLimitNs: playLimitNs_s = baseline_s + rel        (same rel ∀ s ∈ S: the shared ceiling)
             relMax = max_s (acked_s − baseline_s),  relMin = min_s (acked_s − baseline_s)
             rel_uncapped = relMax + Δ                          acked_s = last acked playbackNs
             rel = max( min(rel_uncapped, relMin + N·Δ), Δ )    N = RACE_LEAD_BOUND_FRAMES (= 2)
             clamp  playLimitNs_s ≥ acked_s
barrier:     release round+1  ⟺  ∀ s ∈ S : acked(s, round)
gate:        worker executes while playbackNs < playLimitNs_s   (one-op overshoot tolerance)
```

Each choice below is a property of that formula:

```
DERIVED, not accumulated  (rel from acked playbackNs, never playLimitNs += Δ)
    ⇒ every round re-reads consumption ⇒ unconsumed grant revoked for free
    ⇒ subsumes ADR-0020's idle re-baseline: no consumption ⇒ rel pinned at Δ,
       ∀ count of no-work acks ⇒ the ADR-0020 burst bug cannot re-enter
    counter-model (rejected): a banked 70µs read against a 150ms chunk stays open
       ~50 real-sec after a switch to 333× slow-mo

MAX, not min
    laggard headroom = rel − (acked_s − baseline_s) ≥ Δ    (room to close the gap)
    leader headroom  = Δ
    min ⇒ one stalled worker pins all: that strictness is Pace's join (§3), not the clock

BOUNDED MAX  (Race lead cap: the accumulation guard)
    rel = min(relMax + Δ, relMin + N·Δ) ⇒ the leader gates at most N·Δ past the SLOWEST ACHIEVED
       position (relMin), never past the slowest ALLOCATED position
    inert while relMax − relMin ≤ (N−1)·Δ (⇒ rel = relMax + Δ, plain MAX); binds only when an
       exec-bound leader pulls further ahead, then the ceiling pins at relMin + N·Δ and the leader
       HOLDS until the laggard's ACKED playback actually rises
    relMin rises on consumed progress, not on grant: a CPU-bound laggard granted headroom it has
       not yet drained does NOT lift the floor ⇒ allocation alone never advances the leader ⇒
       lead error cannot accumulate without bound
    counter-model (rejected): uncapped MAX lets an exec-bound leader's lead grow every round the
       laggard cannot keep up, diverging Race flash-time without limit
    Pace: inert (the step join already holds relMax − relMin ≤ (N−1)·Δ); this cap is Race's bound
    N = RACE_LEAD_BOUND_FRAMES = 2

Δ = scale / targetFPS
    ⇒ coordination cost per real-second ≈ constant at every scale
    ⇒ slow: Δ ≪ one op ⇒ cross-FS pacing sub-op-fine where visible; coarsens only where imperceptible
    ⇒ scale is CAPPED: MAX_SCALE = 1e7 (10× real-time). setSpeed THROWS on Infinity or negative,
       never silently clamps (0 allowed, a future freeze option). Rationale: an unbounded scale
       un-bounds Δ, so the release window and the N·Δ lead cap lose meaning; and the worker is
       CPU-bound to ~5× real-time anyway, so 10× is finite headroom above what workers can reach.
       No infinite / no-delay path exists.

GATE       playbackNs ≤ playLimitNs_s          (± one-op overshoot): no worker outruns its playLimitNs
CEILING    Race: playLimitNs_s = baseline + min(relMax + Δ, relMin + N·Δ) (same for all) = the LEADER's
           consumed position + one chunk, but never more than N·Δ past the slowest achieved (BOUNDED MAX);
           paces every session to the shared real-time clock; a laggard's headroom
           playLimitNs − playbackNs = (leader − self) + Δ grows the further back it is, up to the N·Δ cap
SKEW       cross-session lockstep is PACE's join, NOT this inequality:
             Pace — the frontier advances one step at a time: the next entry isn't authorized
                    until ∀ s : entriesDrained ≥ the current shared index ⇒ no session gets more than one step ahead
             Race — bounds PLAYBACK-time only (shared ceiling + identical scale metering); step-count
                    divergence is intended; a stalled session self-corrects by burning headroom
PRINCIPLE  the cross-session differential is ADDITIVE within the cap: extra headroom / a higher-scale
           range to whoever is behind; no ceiling is pushed below the common clock. We speed the
           laggards up, and we hold the leader only once it reaches N·Δ past the slowest ACHIEVED
           position (BOUNDED MAX), so lead error stays bounded. (Still max-not-min in spirit: min pins
           the ceiling to slowest + Δ and holds the leader every round; the cap holds it only past N·Δ.)
scale rides grant.scale ⇒ SPEED change ≤ one frame, never a side channel
catch-up (late join / reseat / stall recovery) = a range granted at higher scale — no new mechanism
```

## 3. Modes — worker-protocol parameterization

Race/Pace *semantics* are ADR-0016; this is only how each binds the §2 algebra across the thread.

| axis | **Race** | **Pace** |
|---|---|---|
| baseline | common origin (reset/reseat) → all equal | rebased per issued entry from its **step-ack** playbackNs (never chunk acks) |
| entryLimit | shipped frontier | shared index + 1 for due sessions |
| join | none (chunk barrier + N·Δ lead cap, §2 BOUNDED MAX) | ∀ s : entriesDrained ≥ shared index |
| overshoot | debt persists (repaid vs cumulative) | dies at the join (cost already in playbackNs) |
| entriesDrained | baseline-inert bookkeeping | drives join **and** rebase |

Rebase exactness ← **I1**.

## 4. Message schemas

```
C → worker
  init      { epoch, fsId, geometry, name }   builds runner⊕device⊕player⊕heat⊕journal/event rings (JOURNAL_MAX ≥ 400)
  entries   { epoch, [{ index, kind, payload, seed }] }   prefetch only (authorizes nothing); commands ship as SOURCE
              Race: window per cursor;  Pace: frontier +1 per join
              window size = deferred knob; exhaustion acks at once ⇒ ≤ 1 round-trip idle
  grant     { epoch, round, entryLimit, playLimitNs, scale }   control plane; playLimitNs per §2; release per §2 barrier
              ALWAYS sent per frame; no-op (limits unchanged) when idle (I10)
  pull      { epoch, heat?, wear?, liveMap?{since}, journal?{since,limit,newest}, events?{since,limit} }
              once/rAF per rendered session; focus = pull selection
  reset     { epoch' }   halt: let the round's acks land (≤ 1 frame) → bump epoch

worker → C
  grantAck  { epoch, round, playbackNs, cursor, entriesDrained, drainedCounters }
              EVERY grant acked on receipt (idle = parked playbackNs), re-acked at frame cadence /
              on limit / at quiescence; idempotent per round; coordinator keeps max
              drainedCounters = fileOpCount + flash time — never exec numbers
  frame     { epoch, heat(~8KB full state), shown⊕wear(~2.3KB), liveMap⊕version(1KB iff version>since),
              journal[], events[], journalHead, eventHead }
  telemetry { epoch, fsinfo, livenessCounts, exec_fileOpCount, exec_simNs }
              scalars; ~250ms; UNCONDITIONAL = liveness heartbeat

no stop / pause / speed / focus / terminate message:
  Run/Stop → gates the churn generator only;  SPEED → grant.scale
  focus → pull selection;  terminate → worker.terminate() post-settle
```

## 5. Invariants

```
I1  ack-quiescence   Pace: playbackNs still between step ack and next issue ⇒ ack's playbackNs = true
                     next-step start; suite asserts (violation = an op outside a step)
I2  barrier          release round+1 ⟺ every current session acked round
I3  bounded skew     execute next op while:  index < entryLimit  ∧  awaited op covered by playback
                       ∧ pending < BACKLOG_CAP  ∧  (executedTapeNs − playbackNs) < TAPE_CAP
                       (TAPE_CAP is scale-relative: TAPE_CAP_FRAMES·Δ ≈ 4 frames of paced playback,
                        NOT a fixed sim-ns cap, which re-breaks B14/B16)
                     a sync burst may vault caps in one macrotask (accepted)
I4  derived limit    playLimitNs never accumulated (§2)
I5  epoch coherence  msg.epoch ≠ current ⇒ discard; a bump voids {playLimitNs, scale, entries, prep-flag,
                     suspended-metering}, the session rebuilds, UI re-attaches `newest`
I6  monotonic ids    index, jid, eventId consecutive per epoch ⇒ gaps arithmetically detectable
I7  determinism      one coordinator sequence · events whole · command source compiled per-worker w/ per-command seed
I8  heat conserved   only the accumulation locus moved; the ADR-0022 veto holds by construction
I9  no per-op wire   pacing/gating/quiescence/heat worker-local ⇒ steady state O(1) msg/session/frame
I10 grant continuity a grant every frame; activity in a no-op ack = a bug
```

## 6. Worker-local execution  (the per-op path never crosses a thread)

Relocations — the mechanism is its ADR's, unchanged; only the locus is now worker-side:

```
player  sole visible delay; playback at realBudget × scale, continuous intra-event, capped at
         playLimitNs; steady state playLimitNs leads playback by ≈ Δ ⇒ feel identical to in-process;
         drain pacing lives here; Pace step ack = entry executed ∧ metered playback drained
command  atomic; quiescence detection relocates with session.js; command ack IS quiescence
         NEW at the boundary: ships as source, compiles worker-side, result ⊕ per-op log in one reply
heat  worker accumulates; C PULLS, never pushed; pull O(geometry), not O(ops)
         unfocused streams nothing (heat stays warm); focus switch → full-state snap repaint
```

## 7. Data-pull model  (new framing over known state)

```
focus     pull selection; no message
logs      journal + viz-events: append-only, monotonic ids, ring (JOURNAL_MAX ≥ 400); served {since | newest, limit}
          newest = (re)attach (focus / re-foreground / epoch bump): journal{newest,400}, events{newest,0}
          firstId > since+1 ⇒ ring eviction ⇒ optional UI break marker
heat      full-state snapshot/frame ⇒ first pull after focus IS the snap repaint; decay closed-form at bump/pull
tape      status = fold over immutable events per index: queued→live→done; gc/prep gray by kind
liveMap   version execution-granular (WASM sync ⇒ atomic per-op state; past unwalkable);
          lazy walk on pull iff dirty ∧ ≥ 250ms since last;
          version stamps the WALK, not the mutation
          consequence: tint (execution-current) leads glow (paced) by ≤ TAPE_CAP + one sync burst
          — minutes at deep slow-mo; remedy UI-side, not protocol
```

## 8. Lifecycle transitions

| event | trigger | action | settle / void |
|---|---|---|---|
| new work | enqueue (paused or not) | append at the frontier index, all sessions | runnable when entryLimit covers it (Pace next join / Race cursor ≥ index); no banked time ⇒ starts at Speed |
| speed change | UI SPEED | next grant carries the new scale | consumed keeps the old scale, remainder the new; ≤ 1 frame |
| focus switch | UI | repoint pull, since = held | no worker state, no replay |
| reset | UI | let the round's acks land → bump epoch | in-flight awaits **starve**; session rebuilds |
| teardown | setSessions removal | settle acks (round + Pace-join vs new membership) → discard stragglers (epoch, round, sessionId) → terminate() | else Pace Promise.all hangs |
| crash | telemetry silent k·250ms ∨ onerror | console tape line | wedges; reload; no recovery |

## 9. prep bracket  (ADR-0014 semantics; new join + reseat)

```
prep(true) at index i / prep(false) at index j : broadcast entries. ENTER per-session at cursor = i (no sync).
While set: ADR-0014 semantics (instant; metering/drain/await pacing off; still logged, measured, wear counts).
EXIT = the only JOIN: coordinator withholds entry j (holds entryLimit = j ⇒ sessions execute only < j) until
       ∀ s : entriesDrained ≥ j−1 (all bracket backlog drained), then releases j to all at once.
       Executing prep(false)@j IS the clear+reseat — that shared execution is what "lands at
       ONE shared entry" (a momentary join even in Race).
On prep(false):  zero displayed counters (flashTime, fileOpCount);  reseat baseline := playbackNs @ j
       ⇒ every session restarts from zero at j ⇒ Race totals level, mirror the gate; ledger = window sum since last clear.
COST   exit join waits on slowest drain (backlog < TAPE_CAP at Speed) — minutes at deep slow-mo; SPEED is the remedy.
SEMANTICS  prep = a start line, not a debt (old Race bonus-workload clamp retired).
```

## 10. Design rationale (option × property)

| option | main relief | throughput | rendezvous | verdict |
|---|---|---|---|---|
| **worker / session** | ✔ | N cores | cross-thread, coarse chunk | **chosen** |
| one shared worker | ✔ | 1 core — slowest stalls rest | simple | rejected as end state; simplicity inherited via the grant interface |
| per-op event stream | partial | — | marshalling ≈ execution | rejected |
| main-thread time-slice | ✗ | — | worst op = one unyielding WASM call | rejected |
| SAB rings / Atomics | ✔ | N cores | zero msg overhead | **deferred** — needs COOP+COEP isolation, unavailable header-less; the SW-shim can't guarantee it (hard-refresh / first-visit / embed bypass) ⇒ chunk protocol stays as fallback regardless ⇒ SAB = additive, not a replacement |

## 11. Amendment scope (vs ADR-0019)

```
CHANGED   op-level dynamic-membership phaser  →  Δ-chunk barrier
UNCHANGED (visible)  slow-mo: Δ ≪ op ⇒ mid-command op-by-op cross-FS lockstep still visible;
                     fast: rendezvous coarsens to Δ where interleaving was imperceptible
UNCHANGED (model)    command-atomic broadcast · queued→live→done · quiescence · determinism (I7)
```

## 12. Empirical basis (the measurements that forced the shape)

```
pile-up      28.8 µs / session·step, flat N=2..5 (single-thread serialization)
worst op     13.5 ms LittleFS compaction = 36,501 device callbacks in ONE sync WASM call
marshalling  0.33 µs/event ⇒ 40.5k events = 13.7 ms serialize ≈ execution cost
heat pull    ~8 KB/frame (~0.5 MB/s @60fps); wear ~2.3 KB; liveMap 1 KB
Δ examples   ~50 µs @333× slow-mo … ~150 ms @10× real-time
leak example 70 µs banked vs 150 ms chunk ⇒ ~50 real-sec dead barrier at 333×
```

## 13. Acceptance gate

```
flag __flashvisBackend selects worker | in-process (fallback)
NOT default-on until scripts/lockstep-concurrency-test.mjs is green vs worker backend for:
    exactly-once dispatch · busy-locks · abort/reject recovery · Pace→Race reseat
    · holding/stalled/waiting · teardown · cross-FS byte-identity
suite already parameterizes coordinator (FV_LOCKSTEP) + UI backend (__flashvisBackend); extending it is in-scope.
```
