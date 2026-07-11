# ADR 0001: Ship as a single dependency-free static page

- **Status:** Superseded by [ADR-0005](0005-real-fs-to-wasm.md)
- **Date:** 2026-07-07
- **Deciders:** —

> Superseded: the project compiles real filesystems to WASM and needs a build step,
> multiple source components, and a dev server, so a single static page no longer fits.
> Kept for the record; the no-build, inspect-every-cell instincts still guide the web layer.

## Summary (prototype era)

The prototype was one `index.html` with inline CSS/JS, no build step, no dependencies, opened
straight in a browser. It established that the interactivity is a canvas/grid plus a control bar,
not an application, and that ~1k DOM cells with CSS transitions are cheap enough to keep each cell
individually inspectable (each cell an element). Those instincts carry forward; the single-file
packaging does not.
