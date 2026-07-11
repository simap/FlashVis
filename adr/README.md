# Architecture Decision Records

This directory records the significant decisions behind **flashvis** — what we chose, why,
and what we traded away. The point is that a reader (or a future us) can reconstruct the
reasoning without archaeology through diffs.

## Format

Lightweight [Nygard-style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
records. One file per decision, `NNNN-kebab-title.md`, numbered in order. Copy
[`template.md`](template.md) to start a new one.

Each record has a **Status**: `Proposed`, `Accepted`, `Superseded by ADR-XXXX`, or `Deprecated`.
Supersede rather than edit: once an ADR is `Accepted`, changing the decision means writing a
new ADR that supersedes it, so the trail of *why it changed* survives.

Reference another record inline as plain text — `ADR-0015` — not as a markdown link.

ADRs 0001–0004 document the throwaway JS prototype that established the visual language.
They're kept as history; the live architecture starts at ADR-0005.
