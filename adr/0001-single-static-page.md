# ADR 0001: Ship as a single dependency-free static page

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** Ben

> Superseded: the project compiles real filesystems to WASM and needs a build step,
> multiple source components, and a dev server — a single static page no longer fits.
> Kept for the record; the no-build, inspect-every-cell instincts still guide the web layer.

## Context

flashvis is a demo and teaching tool: something to open, share as a link, and hand to
someone learning how NOR flash and a flash filesystem behave. Its value is in being
*immediately runnable* and easy to reason about, not in framework machinery. There is no
server, no persistence, no auth — it is a pure client-side simulation.

## Decision

We will build the whole thing as a single `index.html` with inline CSS and JavaScript, no
build step, no runtime dependencies, no package manager. Opening the file in any modern
browser runs it. Web fonts load from Google Fonts with system fallbacks, so it degrades
gracefully offline.

## Consequences

- Zero-friction to run, host (any static host or `file://`), and review — the whole app is
  one readable file.
- No transpilation means we write to baseline-modern browser JS/CSS directly.
- The simulation model and the DOM rendering live in the same file. If the model grows
  beyond what is comfortable inline, that is the trigger to revisit this ADR — likely by
  splitting the pure model into its own module while keeping a no-build story.
- Testing the model means porting/extracting it; we keep the model as plain functions over
  plain arrays specifically so it can be exercised headless in Node.

## Alternatives considered

- **A bundled SPA (Vite/React).** Rejected: the interactivity is a canvas/grid and a control
  bar, not an application. A framework would add weight and a build step for no benefit here.
- **Canvas/WebGL rendering.** Rejected for now: ~1k DOM cells with CSS transitions is well
  within budget and keeps state inspection trivial (each cell is an element). Revisit if cell
  count or animation density grows an order of magnitude.
