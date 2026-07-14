# ADR 0025: Host on GitHub Pages; designs must run on a header-less static host

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** —

## Context

flashvis is distributed as a URL, hosted on GitHub Pages, which cannot set HTTP response
headers. ADR-0024's SharedArrayBuffer alternative needs COOP/COEP — unavailable here short of a
service-worker shim (first-visit double-load, CORS/CORP opt-in on every cross-origin
subresource, isolation silently lost when embedded — so a message-based fallback is needed
anyway).

## Decision

**GitHub Pages is the host; everything must run on a header-less static site.** Firm but not
hard: it yields only to a really good reason, and a design wanting headers must first show a
no-header variant falls measurably short.

## Consequences

- Cross-origin isolation (SharedArrayBuffer, `Atomics.wait`) is unavailable on loads the shim
  doesn't control (first visit, hard refresh, embeds) — what keeps ADR-0024's SAB optimization
  parked: it would be additive, not a replacement.
- Workers, `postMessage`, and WASM work zero-config; the page stays embeddable.
- Header-dependent features are not blocked by this ADR: the shim can synthesize headers as a
  progressive enhancement. But since it's never guaranteed (above), the feature must degrade to
  a no-header path; only a design that can't degrade would need to supersede this ADR.
