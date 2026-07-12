# ADR 0023: Count work as file-granular ops, decoupled from the lockstep cursor; GC is background time, not an op

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** —

## Context

The scoreboard's "ops" number is the coordinator's per-session **sequence cursor**
(`cursors`/`stepCursor` in `lockstep.js`). That one integer is overloaded three ways at once: the
sequence *position*, the Pace rendezvous unit, and the displayed op count. It counts *sequence
entries* at +1 each, where an entry is a churn event, a GC step, **or a whole atomic command**
(ADR-0019). Two unfair results fall out:

1. **A whole console line is one op.** `for (i=0;i<100;i++) ls()` compiles to one `command` entry, so
   the cursor advances once — identical to a bare `ls()` — even though the 100 inner calls each run for
   real, cost flash time, and emit device traffic. Op count fails to measure the work done.
2. **GC no-op steps count as ops.** A `{kind:'gc'}` entry is +1 like any other. FASTFFS's GC is real
   incremental work; LittleFS's is a capability-disclaimed no-op (ADR-0021) — zero time, zero device
   I/O — yet still +1. So the BG-GC knob reshapes the shared sequence and swings LittleFS's op count
   (inflated by free steps) and its ms/op (deflated by free steps) even though LittleFS ignores GC.
   The counter credits a step that did no work — that is the accounting bug.

An op count should measure **useful work**, be **explainable** in one sentence, and be **observable**
— reconstructable by hand from what the console already shows.

## Decision

**Introduce `fileOpCount`: a count of high-level file operations, decoupled from the cursor.** It is
the first rung of a deliberate granularity ladder — **file → fs → flash** — and only the file rung is
implemented now:

- **file** (counted): whole-file and lifecycle operations — `writeFile`, `readFile`, `deleteFile`,
  `ls`, `getFiles`, `mkdir`, `stat`, `format`, `mount`, `unmount`, and each churn file-event. One op
  per call, so `for (i=0;i<100;i++) ls()` is 100 and `writeFile` is 1 (its internal open+write+close
  stay below the line).
- **fs** (not counted yet): handle- and cursor-level ops — `open`/`read`/`write`/`seek`/`close`,
  `openDir`/`dir.read`/`close`. Exposed on the console (ADR-0014 Tier-2) but below the file rung.
- **flash** (not counted yet): device read/program/erase. Maybe some day, with a carve-out for the
  silent liveness-map reads that already cost nothing.

`fileOpCount` is a **new per-session counter, separate from `cursors`.** The cursor stays exactly as
the sequence index and Pace rendezvous unit; Race/Pace scheduling, determinism, and `paceStep`'s
min/due machinery are untouched. Only the *display* metrics repoint: "ops done", ops/sec, and the
Pace efficiency / ms-op denominator read `fileOpCount` instead of `stepCursor`. Increment it where the
high-level file op fires (the friendly-API surface and `runChurnEvent`), never at `runOp` (shared with
fs-level ops) and never at the command boundary.

**GC is excluded from the op count for both filesystems, uniformly** — GC is background maintenance,
never a workload op, so "one op" means the same thing on every FS. GC **still charges flash time**
(FASTFFS's real reclamation is folded into the single per-FS time total; nobody gets it free).

**GC is not shown as a second time total.** A separate "GC time" beside "flash time" is a *subset*, not
a co-equal breakdown category — the reader shouldn't have to know whether to add the two numbers. GC is
made observable a different way: **its console lines are colored gray** — present, but in the
background.

**Observability is the contract, and the console tape is the ledger.** The console already logs each
op with its flash-op breakdown and time — e.g. `write(f000-159461b1.bin, 28226 B) → 333 ms · 7 erase
138 prog 151 read` — and none of that changes; the only console change is that GC lines are grayed. The
on-screen numbers must then be reconstructable from the console by hand:

- **Count the non-gray high level op lines → that is `fileOpCount`.** writeFile, ls, churn ops, etc.
- **Sum every line's time (gray GC lines included) → that is the flash-time total.**
- Experimentally: spam `gc()` and watch flash time climb while ops stays put.

The one thing the numbers deliberately do **not** explain is *how* a filesystem turns a file op into its
particular time cost — that is what the die visualization shows, not what a number should spell out.

## Consequences

- Small change: add one field, increment it when a high-level file op fires, repoint the display
  metrics to it, and gray GC in the console. The coordinator's sequence/pacing logic, the churn model,
  and device timing do not change.
- FASTFFS's Pace ms/op **rises**: its GC time is now attributed over fewer, useful ops. That is the
  fairer number, but it is a visible shift reviewers should expect.
- The BG-GC knob stops distorting LittleFS's op count and ms/op. One effect is out of scope and
  unchanged: a high GC ratio still fills the shared sequence with gc entries (pure no-op filler for
  LittleFS), so an FS spends more of its steps on GC and fewer on files per unit wall-time. That is a
  property of the shared-sequence gc/event mix, independent of how ops are counted, and is not what
  this ADR addresses.
- **Deferred companions**, noted so the field name and framing anticipate them: counting `format` /
  `mount` / `unmount` (and later the fs/flash rungs) in their **own buckets** so stats can be filtered
  by granularity; and a **`clearStats()`** that zeroes the op and flash-time counters while leaving the
  FS formatted and mounted, to capture a clean micro-benchmark window.

## Alternatives considered

- **Keep the cursor as the op count.** Rejected: it conflates a command, a churn event, and a GC step
  as equal units, so a loop reads as one op and GC no-ops inflate the count.
- **Exclude GC from the count only where it is a no-op (asymmetric).** Rejected: "op" would mean
  something different per filesystem, reintroducing the asymmetry this removes.
- **Show a separate GC-time total.** Rejected: two on-screen totals where one is a subset of the other
  is a communication trap; gray console lines make GC observable without the ambiguity.
- **Count at `runOp`.** Rejected: `runOp` is shared by the fs-level handle/dir ops too, so it would
  count the wrong granularity; count at the file-op boundary instead.
