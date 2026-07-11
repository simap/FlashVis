# ADR 0009: Two-layer playback — instant execution, timed animation, await-pacing

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** —

## Context

The filesystem runs in WASM and returns synchronously; results and every op's simulated cost are
known the instant a call returns. But we want to *watch* it at a controllable speed and make op cost
legible (an erase is ~200× a read, [ADR-0007](0007-timing-and-inspect.md)). Animating inline would
tie filesystem speed to render speed; a fixed animation rate would flatten the cost differences.

## Decision

Split into two layers with an explicit bridge.

1. **Execution — synchronous.** Each FS call runs to completion in WASM; every device op emits an
   event carrying a simulated-time cost in ns (ESP32-S3 preset). Bytes and result are final
   immediately.
2. **Animation — a timed player.** Events queue; a per-frame loop drains the queue spending a
   real-time budget converted to sim-ns by `scale` (the SPEED slider, log scale from slow-mo through
   real-time to `Infinity`/no-delay). Each op animates at the **start** of its time slot for the
   slot's scaled duration; multi-page ops split to sweep page-by-page. Durations apply via the **Web
   Animations API** (`element.animate`, duration captured synchronously) because the CSS `animation:`
   shorthand didn't honor a reliable per-trigger duration (erases flashed at a fixed rate or got cut
   short by `animationend` races, worse at high speed).
3. **Bridge — await-pacing via a queue barrier.** A paced op enqueues a marker after its events and
   resolves when the player *reaches* it, so `await fs.write(...)` blocks for the op's simulated time
   at the current SPEED and a console loop locksteps with the die. Streaming `ls` uses the
   `fffs_dir_read` iterator so each entry paces and prints on its own.

## Consequences

- Filesystem speed is decoupled from render speed; op cost is legible; SPEED means one thing
  everywhere.
- Un-awaited ops let execution run ahead and the animation queue backlog; `await` (or Pause) brings
  lockstep. The queue is shared with the background workload, so an awaited op also waits behind
  whatever is already queued.
- Telemetry reads off the device (authoritative, instant); the die reflects the paced replay.

## Alternatives considered

- **Animate inline / fixed rate.** Rejected: inline ties throughput to frame rate; fixed rate hides
  the cost differences that are the whole point.
- **Depth-based drain pacing** (resolve when the queue returns to a prior depth). Rejected: fragile
  when the background workload queues concurrently; the barrier marker is exact.
