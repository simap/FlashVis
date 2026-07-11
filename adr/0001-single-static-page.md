# ADR 0001: Ship as a single dependency-free static page

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** —

> Superseded: the project compiles real filesystems to WASM and needs a build step,
> multiple source components, and a dev server, so a single static page no longer fits.


## Context (still relevant)

flashvis is a demo and teaching tool: something to open, share as a link, and hand to
someone learning how NOR flash and a flash filesystem behave. Its value is in being
*immediately runnable* and easy to reason about, not in framework machinery. There is no
server, no persistence, no auth — it is a pure client-side simulation.

## Decision (prototype era)

~~We will build the whole thing as a single `index.html`.~~
