/*
 * mock-worker-transport.mjs — a faithful in-realm Worker-port model (ADR-0024 §13).
 *
 * Models the semantics of `new Worker()` + postMessage WITHOUT a real OS thread:
 *   - every delivered message is structuredClone'd (no shared references across the
 *     boundary — a closure mutated on one side is invisible to the other, exactly as
 *     with a real worker; this is why dispatch/cost observables must be IN-BAND);
 *   - delivery is ASYNC and ORDERED (queued to a macrotask), so cross-boundary
 *     ordering and latency are real, not synchronous.
 *
 * This is the substrate the converted concurrency suite and the worker-conformance
 * suite run the worker backend through. A real `node:worker_threads` run is an
 * additive check layered on the same message protocol; it is not required for done.
 *
 * Contract: messages are the envelopes from web/src/protocol.js. This module knows
 * nothing about their contents — it only plumbs and clones them in order.
 */

/**
 * A single port endpoint. `.postMessage(m)` delivers structuredClone(m) to the peer
 * on a future macrotask; `.onmessage = fn` receives them in send order. Mirrors the
 * subset of the DOM MessagePort / Worker API the backend uses.
 */
class Port {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this._peer = null;
    this._closed = false;
  }
  postMessage(m) {
    if (this._closed || !this._peer) return;
    const clone = structuredClone(m);
    const peer = this._peer;
    // Macrotask delivery preserves send order (FIFO timer queue) and imposes the
    // real "next turn" latency a Worker has. Never synchronous.
    setTimeout(() => { if (!peer._closed && peer.onmessage) peer.onmessage({ data: clone }); }, 0);
  }
  close() { this._closed = true; }
}

/**
 * Create a linked port pair modelling the Worker boundary.
 * @returns {{mainPort: Port, workerPort: Port}}
 *   `mainPort` is the coordinator (C) side (what `new Worker()` returns);
 *   `workerPort` is the in-worker `self` side. Wire the worker host to workerPort
 *   and the coordinator's session-proxy to mainPort.
 */
export function createTransport() {
  const mainPort = new Port('main');
  const workerPort = new Port('worker');
  mainPort._peer = workerPort;
  workerPort._peer = mainPort;
  return { mainPort, workerPort };
}

/** Resolve after `n` macrotask turns — drains queued deliveries in tests. */
export function flushTurns(n = 1) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}
