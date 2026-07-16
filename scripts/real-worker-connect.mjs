/*
 * real-worker-connect.mjs: a REAL-runner `__flashvisWorkerConnect` adapter for
 * headless whole-playground e2e (scripts/real-smoke.mjs).
 *
 * playground.js connects each session over a Port seam (playground.js
 * connectWorker): in the browser it spawns `new Worker(session-worker.js)`;
 * headless it consults `globalThis.__flashvisWorkerConnect(fsId, meta)` and uses
 * whatever Port that returns. Node has no `new Worker`, so a headless run MUST
 * install this seam.
 *
 * Two adapters exist for the seam:
 *   - the STUB one (scripts/playground-boot-test.mjs): createWorkerHost over a
 *     mock transport with a STUB runner (worker-stub-runner.mjs), deterministic,
 *     WASM-free, NO real clock. Proves the wire + page mechanics.
 *   - THIS one: the SAME in-realm worker host over the SAME faithful mock
 *     transport (mock-worker-transport.mjs: structuredClone + async ordered
 *     macrotask delivery), but with the REAL production runner (runner.js/dist
 *     real WASM, the createWorkerHost default when no createRunner is injected).
 *     Real WASM means real per-FS simulated flash cost (SPIFFS's 64-erase format
 *     vs FASTFFS's 2-erase, real gc timing, real op telemetry), which is what
 *     drives the coordinator's Race clock / pace metering. This is the substrate
 *     for the real-clock/real-WASM behaviors a stub cannot exercise.
 *
 * It is deliberately NOT node:worker_threads: realsmoke is not testing OS-thread
 * parallelism, it needs a real WASM backend + a real clock reached through the
 * frozen protocol.js wire. This reuses the exact mechanics the concurrency suite
 * runs real WASM on (worker-harness.mjs: createSessionProxy + real
 * createWorkerHost over the mock transport), behind the playground's own seam.
 *
 * Requires the built dist/*.mjs (npm run build:*), same as the concurrency suite.
 */
import { createTransport } from './mock-worker-transport.mjs';
import { createWorkerHost } from '../web/src/session-worker.js';

/**
 * Install the real-runner seam. Each connectWorker(fsId) spins up a linked
 * mock-transport pair, wires a REAL worker host (default real-WASM runner) to
 * the worker side, and hands the coordinator side back to the proxy. The proxy
 * owns port.onmessage (playground.js), so we only return { port, terminate }.
 *
 * @returns {{ hosts: object[], uninstall: () => void }}  the live hosts (for
 *   teardown) and a restore for globalThis.__flashvisWorkerConnect.
 */
export function installRealWorkerConnect() {
  const hosts = [];
  const had = '__flashvisWorkerConnect' in globalThis;
  const prev = globalThis.__flashvisWorkerConnect;
  globalThis.__flashvisWorkerConnect = (/* fsId, meta */) => {
    const { mainPort, workerPort } = createTransport();
    // No createRunner override -> createWorkerHost uses the real runner.js
    // default (real WASM), the same factory worker-harness.mjs drives.
    const host = createWorkerHost(workerPort, {});
    hosts.push(host);
    return {
      port: mainPort,
      terminate: () => { host._stop?.(); workerPort.close?.(); mainPort.close?.(); },
    };
  };
  return {
    hosts,
    uninstall() {
      for (const h of hosts) h._stop?.();
      if (had) globalThis.__flashvisWorkerConnect = prev;
      else delete globalThis.__flashvisWorkerConnect;
    },
  };
}
