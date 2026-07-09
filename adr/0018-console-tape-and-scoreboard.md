# ADR 0018: The console tape as journal of truth; the scoreboard shell

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** —

## Context

With every operation broadcast through one shared timeline ([ADR-0017](0017-broadcast-operations-focus-the-view.md)),
the interface has three jobs it didn't before: make the timeline and its *pending* state legible (an
operation issued to a lagging filesystem hasn't happened there yet); give one authoritative record of
what was done to the simulation; and present N filesystems' standings with a focus control. The
current layout works against all three — the poke buttons call functions directly while the console
logs separately (two sources of truth), a standalone CELL STATES card and a separate compare strip
each eat a panel, and switching filesystem writes a log line. This ADR is the UI/UX decision that
follows from 0017; it builds on the console surface of [ADR-0014](0014-console-fs-api.md).

## Decision

**The console is the tape — the journal of truth.** Control buttons *inject* their command rather
than call a function: pressing Write echoes `> writeFile('cfg.bin')` into the tape and then runs it,
so the tape is a complete, teachable, replayable record of everything done to the sim. A button that
can't be expressed as a console command therefore has no home — a healthy constraint that keeps the
API and the UI in step. Two registers share the pane but stay visually distinct because they are
different kinds of thing: the **workload engine** (Run / Stop / Step, Race / Pace, SPEED, BG GC) that
drives the auto-churn on every filesystem, and the **manual pokes** (write / ls / delete / gc / format,
plus the free-form input) that inject discrete operations. Both journal to the tape.

**Tape entries carry a lifecycle**, and the focused filesystem's cursor decides which you see:

- **⧗ queued** — appended at present; this filesystem's cursor hasn't reached it. This doubles as the
  instant submit feedback, so a command never dead-clicks even when it won't resolve for a while.
- **▸ live** — executing / animating on this filesystem now.
- **done** — resolved, with its simulated cost (`→ 41 ms · 1 erase 19 prog 23 read`).

When the focused filesystem is behind the frontier (a Race follower), the tape shows a **present-gap
header** — how far back it is and which filesystem leads — with a **"Catch up by switching to Pace
mode"** action ([ADR-0017](0017-broadcast-operations-focus-the-view.md)). In Pace (the default on
load) cursors stay together, so pokes resolve promptly everywhere and the queued state rarely shows:
the pending complexity is opt-in with Race, where it belongs.

**The header is a scoreboard that is also the switcher.** Filesystem name, per-FS standings (step,
active flash time, one quality metric), and the focus control collapse into one card — the standalone
compare strip is gone, and the vertical band it took is returned to the die and the tape. Each
filesystem is a segment showing its live standings; the focused one is lit; clicking a segment focuses
it.

**Die-adjacent view controls.** The big CELL STATES card becomes a compact legend chip-row directly
under the die — `swatch: word`, with the explainer on hover / focus — driven by a **per-FS class
descriptor** so it is filesystem-specific by construction (the same baseline for both drivers today,
but LittleFS can grow metadata-pair / CTZ classes later without rework, per
[ADR-0011](0011-uniform-fs-driver-abi.md)/[ADR-0012](0012-per-fs-liveness-inspect.md)). The
wear-heatmap toggle sits beside it, since both are die-view controls. Telemetry under the die stays
the focused filesystem's deep stats.

**Dropped:** the program-granule control (a niche re-format knob), the standalone CELL STATES card,
the separate compare strip, and the "switched to X" log line.

## Consequences

- The tape gets busy during Run — churn operations stream alongside injected commands — so injected
  commands must be styled distinctly from auto-generated ops, or the journal stops reading as "what I
  did" versus "what the workload did".
- Buttons-inject-commands couples the UI to the console API surface. That is deliberate: it means the
  console can do everything the buttons can, and it keeps a single vocabulary, but it does mean a new
  control needs a console verb first.
- The scoreboard must stay legible as N grows (two drivers today, three or four later); the per-FS
  segment has to degrade gracefully, which bounds how much each can show — hence standings in the
  header, deep telemetry under the die, no duplication.
- Accessibility floor: the legend's hover explainers must also be keyboard-reachable, and the tape's
  state changes must not depend on motion alone.

## Alternatives considered

- **Keep the buttons calling functions directly, with the console as a separate tool.** Rejected: two
  sources of truth, and no replayable record of what was done — the opposite of the journal this
  instrument needs.
- **Keep the compare strip separate from the header.** Rejected: it costs a whole vertical band and
  splits "which filesystem / how are they doing / focus one" across two elements that are really one
  question.
- **A single shared op-log for all filesystems.** Rejected: each filesystem has its own timing and its
  own pending state ([ADR-0017](0017-broadcast-operations-focus-the-view.md)), so the tape is per-FS
  and follows focus; one merged log couldn't show a follower's queue.
