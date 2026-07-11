# ADR 0018: The console tape as journal of truth; the scoreboard shell

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** —

## Context

With every operation broadcast through one shared timeline (ADR-0017),
the interface has three new jobs: make the timeline and its *pending* state legible; give one
authoritative record of what was done; and present N filesystems' standings with a focus control. The
current layout fights all three — poke buttons call functions while the console logs separately (two
sources of truth), a standalone CELL STATES card and a separate compare strip each eat a panel, and
switching filesystem writes a log line. This is the UI decision following 0017, building on the
console surface of ADR-0014.

## Decision

**The console is the tape — the journal of truth.** Control buttons *inject* their command rather
than call a function: pressing Write echoes `> writeFile('cfg.bin')` into the tape and then runs it,
so the tape is a complete, replayable record. **A button that can't be expressed as a console command
has no home** — a healthy constraint keeping API and UI in step. Two visually-distinct registers share
the pane: the **workload engine** (Run / Stop / Step, Race / Pace, SPEED, BG GC) and the **manual
pokes** (write / ls / delete / gc / format, plus free-form input). Both journal to the tape.

**Tape entries carry a lifecycle**, and the focused filesystem's cursor decides which you see:
**⧗ queued** (appended at present, this FS's cursor hasn't reached it; doubles as instant submit
feedback so a command never dead-clicks), **▸ live** (executing/animating now), **done** (resolved,
with simulated cost `→ 41 ms · 1 erase 19 prog 23 read`). When the focused FS is behind the frontier
(a Race follower), the tape shows a **present-gap header** with a **"Catch up by switching to Pace
mode"** action. In Pace (the default on load) cursors stay together, so the queued state rarely shows
— the pending complexity is opt-in with Race, where it belongs.

**The header is a scoreboard that is also the switcher.** Filesystem name, per-FS standings (step,
active flash time, one quality metric), and the focus control collapse into one card; the standalone
compare strip is gone. Each FS is a segment showing live standings; the focused one is lit; clicking
focuses it.

**Die-adjacent view controls.** The CELL STATES card becomes a compact legend chip-row under the die
(`swatch: word`, explainer on hover/focus), driven by a **per-FS class descriptor** so it is
filesystem-specific by construction (LittleFS can grow metadata-pair / CTZ classes later without
rework, per ADR-0011/ADR-0012).
The wear-heatmap toggle sits beside it; telemetry under the die stays the focused FS's deep stats.

**Dropped:** the program-granule control (a niche re-format knob), the standalone CELL STATES card,
the separate compare strip, and the "switched to X" log line.

## Consequences

- The tape gets busy during Run, so injected commands must be styled distinctly from auto-generated
  ops or the journal stops reading as "what I did" vs "what the workload did".
- Buttons-inject-commands couples the UI to the console API surface — deliberate: a new control needs
  a console verb first.
- The scoreboard must stay legible as N grows; per-FS segments bound how much each shows (standings in
  the header, deep telemetry under the die, no duplication).
- Accessibility floor: the legend's hover explainers must be keyboard-reachable, and the tape's state
  changes must not depend on motion alone.

## Alternatives considered

- **Buttons keep calling functions, console as a separate tool.** Rejected: two sources of truth, no
  replayable record.
- **Compare strip separate from the header.** Rejected: it costs a whole vertical band and splits one
  question (which FS / how doing / focus one) across two elements.
- **A single shared op-log for all filesystems.** Rejected: each FS has its own timing and pending
  state, so the tape is per-FS and follows focus; one merged log couldn't show a follower's queue.
