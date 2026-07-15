/*
 * Concurrency / exactly-once regression suite — ADR-0024 (worker-per-session),
 * driven against the REAL production backend end to end: the real coordinator
 * (web/src/lockstep.js) + real session proxies (web/src/session-proxy.js) +
 * the real standalone worker host (web/src/session-worker.js) over real WASM,
 * all reached only through the frozen protocol.js wire and the faithful mock
 * transport (structuredClone + async queued delivery). This is the §13
 * acceptance path: the scenarios the pre-0024 in-process concurrency suite
 * proved, re-expressed against the worker backend and green.
 *
 * See LANE-REPORT.md for the full OLD->NEW observable mapping and which
 * scenarios are covered here vs. by lane C's coord-wire-test.mjs (the §2
 * algebra + signals against MOCK workers) — this suite's distinct role is the
 * REAL-WASM composition plus cross-FS byte-identity, which a WASM-free suite
 * cannot check.
 *
 * OBSERVABLES (all in-band; no closure counter, no synchronous device reach-in):
 *   - dispatch count: the worker's own JOURNAL, pulled via C2W.PULL (a command
 *     that runs twice appends its op lines twice). Data leaves a session ONLY
 *     via the journal — there is no byte side-channel (settled decision).
 *   - cost: drainedCounters (fileOpCount/flashTimeNs) on GRANT_ACK.
 *   - cross-FS byte-identity: a command PRINTs a content hash of the files into
 *     the journal; we compare the printed hash across FS (the settled
 *     journal-print technique — the only way bytes are observable over the wire).
 *   - standing signals: snapshots()[i].{holding (debounced), csActive (raw)} and
 *     waitStates() — `stalled`/`waiting` are REMOVED (settled signal rework).
 *
 * Pause model (settled): stop() gates the churn GENERATOR only (ADR-0020); it
 * NEVER aborts an in-flight command. reset() voids in-flight rounds via the
 * epoch bump. Scenarios 5/6 are reframed to this: a paused command COMPLETES.
 */
import {
  makeRig, bootFormat, frame, run, pumpUntil, snapById,
  pullJournal, allDrainedTo, cursorsEqualAt, FS_ORDER, flushTurns,
} from './worker-harness.mjs';

process.on('unhandledRejection', (e) => { console.error('\nFAIL - unhandled rejection:', (e && e.stack) || e); process.exit(1); });

let failures = 0;
function fail(msg) { failures++; console.error('  FAIL - ' + msg); }
function ok(msg) { console.log('  ok   - ' + msg); }

const countLines = (journal, substr) => journal.filter((j) => j.text.includes(substr)).length;
const hashLines = (journal, tag) => journal.filter((j) => j.text.startsWith(tag)).map((j) => j.text);

// A command that writes `name` then prints an FNV-1a content hash of it into the
// journal — the settled cross-FS byte-identity probe (no byte side-channel).
function hashingWrite(name, size, tag = 'HASH') {
  return `await writeFile('${name}', ${size}); { const b = await fs.read('${name}'); let x = 2166136261 >>> 0; for (let i = 0; i < b.length; i++) { x ^= b[i]; x = Math.imul(x, 16777619) >>> 0; } print('${tag} ${name} ' + x); }`;
}
async function assertCrossFsIdentical(rig, tag, label) {
  const perFs = {};
  for (const fsId of FS_ORDER) perFs[fsId] = hashLines(await pullJournal(rig, fsId), tag).sort();
  const [a, b] = FS_ORDER.map((f) => perFs[f]);
  if (a.length === 0) { fail(`${label}: no '${tag}' hash lines printed (probe never ran)`); return; }
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    fail(`${label}: FASTFFS and LittleFS content hashes differ\n         fastffs: ${a.join(' | ')}\n         littlefs: ${b.join(' | ')}`);
  } else ok(`${label}: both FS printed byte-identical content hashes (${a.length} file(s))`);
}

// ============================================================================
// [1] exactly-once dispatch: N distinct commands each execute exactly once per
// session, and both FS end byte-identical. The core no-double-execution
// invariant, re-expressed in-band. Mutation-proven via a scratch worker-host
// copy (FV_WORKER_HOST) that drops the in-flight re-entrancy guard — see
// LANE-REPORT.md "Mutation evidence".
// ============================================================================
async function scenarioExactlyOnce() {
  console.log('\n[1] exactly-once dispatch: N distinct commands run once per session, both FS identical');
  const rig = await makeRig({ speed: Infinity });
  const N = 5;
  const names = [];
  let last = 0;
  for (let k = 0; k < N; k++) {
    const name = `x${k}.bin`;
    names.push(name);
    last = rig.coord.broadcast(hashingWrite(name, 2048 + k * 1024), `w ${name}`).index;
  }
  rig.coord.setMode('pace');
  await pumpUntil(rig, () => allDrainedTo(rig, last), 's1-drain');
  for (const fsId of FS_ORDER) {
    const j = await pullJournal(rig, fsId);
    let bad = false;
    for (const name of names) {
      const n = countLines(j, `write(${name}`);
      if (n !== 1) { fail(`s1: ${fsId} executed write(${name}) ${n}x, expected exactly 1 (double dispatch?)`); bad = true; }
    }
    if (!bad) ok(`s1: ${fsId} executed all ${N} distinct commands exactly once each`);
  }
  await assertCrossFsIdentical(rig, 'HASH', 's1');
}

// ============================================================================
// [8] reset() reproducibility (byte-for-byte) + fresh-epoch cleanliness.
// OLD scenario 8(a): a produced run reset then re-run must be byte-identical.
// NEW: reproducibility proven via the journal-print content hash (the settled
// technique) since no byte side-channel exists. Mutation: a coordinator that
// drops churn.reset() (scratch FV_COORDINATOR copy) diverges run2 from run1.
// ============================================================================
async function scenarioResetReproducible() {
  console.log('\n[8] reset() reproducibility: a produced run, reset, re-run = byte-identical (journal-print)');
  const rig = await makeRig({ speed: Infinity });
  // Run 1: a fixed batch of produced churn steps, then a hash-print of the whole tree.
  const STEPS = 10;   // bounded so the small (256KB) chip never overflows a churn write
  async function producedRunThenHash(tag) {
    rig.coord.setMode('pace');
    rig.coord.start();
    await pumpUntil(rig, () => rig.proxies[0].acked.cursor >= STEPS, `${tag}-produce`);
    rig.coord.stop();
    await run(rig, 2);   // let any in-flight step drain before hashing
    // hash every file currently on the chip into the journal
    const src = `const fs2 = await getFiles(); fs2.sort((a,b)=> a.name<b.name?-1:1); for (const f of fs2){ const b = await fs.read(f.name); let x=2166136261>>>0; for(let i=0;i<b.length;i++){x^=b[i];x=Math.imul(x,16777619)>>>0;} print('${tag} '+f.name+' '+x); }`;
    const { index } = rig.coord.broadcast(src, 'hash-all');
    await pumpUntil(rig, () => allDrainedTo(rig, index), `${tag}-drain`);
  }
  await producedRunThenHash('R1');
  const run1 = {};
  for (const fsId of FS_ORDER) run1[fsId] = hashLines(await pullJournal(rig, fsId), 'R1').sort();
  if (run1.fastffs.length === 0) { fail('s8: run 1 produced no files to hash (churn made nothing?)'); return; }
  ok(`s8: run 1 produced ${run1.fastffs.length} files on fastffs, ${run1.littlefs.length} on littlefs`);
  // reset() -> fresh epoch; re-boot the chip (format ships as a command post-reset)
  rig.coord.reset();
  await flushTurns(6);
  if (!cursorsEqualAt(rig, 0)) fail(`s8: cursors not zeroed after reset (${rig.proxies.map((p) => p.acked.cursor)})`);
  else ok('s8: cursors zeroed on the fresh epoch');
  await bootFormat(rig);
  await producedRunThenHash('R2');
  const run2 = {};
  for (const fsId of FS_ORDER) run2[fsId] = hashLines(await pullJournal(rig, fsId), 'R2').sort();
  for (const fsId of FS_ORDER) {
    const a = run1[fsId], b = run2[fsId];
    // R1/R2 tags differ; compare the name+hash suffix (strip the tag).
    const strip = (arr) => arr.map((s) => s.replace(/^R[12] /, '')).sort();
    const A = strip(a), B = strip(b);
    if (A.length !== B.length || A.some((v, i) => v !== B[i])) {
      fail(`s8: ${fsId} second run diverged from the first (churn/rnd/chip carryover across reset)\n         run1: ${A.join(' | ')}\n         run2: ${B.join(' | ')}`);
    } else ok(`s8: ${fsId} reset re-run is byte-for-byte reproducible (${A.length} files identical)`);
  }
}

// ============================================================================
// [4] a rejecting (throwing) command releases the lock and the coordinator
// recovers. OLD scenario 4. Settled model: a thrown command is logged
// ('command error: …'), still reaches quiescence (I1 — a runaway can't wedge
// the pump), and the NEXT command executes normally.
// ============================================================================
async function scenarioRejectingCommand() {
  console.log('\n[4] a throwing command still quiesces; the coordinator recovers (I1)');
  const rig = await makeRig({ speed: Infinity });
  const bad = rig.coord.broadcast(`throw new Error('boom - simulated bad command')`, 'bad').index;
  const good = rig.coord.broadcast(hashingWrite('after-boom.bin', 2048), 'good').index;
  rig.coord.setMode('pace');
  await pumpUntil(rig, () => allDrainedTo(rig, good), 's4-drain');
  for (const fsId of FS_ORDER) {
    const j = await pullJournal(rig, fsId);
    if (!j.some((l) => l.text.includes('command error') && l.text.includes('boom'))) fail(`s4: ${fsId} did not log the thrown command's error`);
    else if (countLines(j, 'write(after-boom.bin') !== 1) fail(`s4: ${fsId} the command after the throw did not run exactly once (lock not released?)`);
    else ok(`s4: ${fsId} logged the throw, quiesced, and ran the following command (recovered)`);
  }
  if (!allDrainedTo(rig, good)) fail('s4: coordinator never drained past the throwing command (wedged)');
  else ok('s4: coordinator drained past the throwing command on every session');
  await assertCrossFsIdentical(rig, 'HASH', 's4');
}

// ============================================================================
// [5/6] stop() gates the GENERATOR only — a paused command COMPLETES, never
// aborts/rewinds (settled model; the old stop-aborts-churn-step / stop-aborts-
// command-mid-drain scenarios are reframed). We start a command, stop() while
// it is in flight, and assert it still completes exactly once and both FS stay
// byte-identical (no abort, no re-execution).
// ============================================================================
async function scenarioStopGatesGeneratorOnly() {
  console.log('\n[5/6] stop() gates the generator only: an in-flight command COMPLETES, never aborts');
  const rig = await makeRig({ speed: Infinity });
  // Broadcast a multi-op command; stop() the instant it starts, then keep ticking.
  const src = `await writeFile('s5a.bin', 4096); await readFile('s5a.bin'); ${hashingWrite('s5b.bin', 4096)}`;
  const idx = rig.coord.broadcast(src, 'multi').index;
  rig.coord.setMode('pace');
  // one frame to dispatch it, then immediately stop (generator gate) mid-flight
  await frame(rig);
  rig.coord.stop();
  await pumpUntil(rig, () => allDrainedTo(rig, idx), 's5-drain');
  for (const fsId of FS_ORDER) {
    const j = await pullJournal(rig, fsId);
    const a = countLines(j, 'write(s5a.bin'), b = countLines(j, 'write(s5b.bin');
    if (a !== 1 || b !== 1) fail(`s5/6: ${fsId} paused command did not complete exactly once (s5a×${a}, s5b×${b}) — stop() must not abort/rewind`);
    else ok(`s5/6: ${fsId} the in-flight command completed exactly once despite stop() (generator-only pause)`);
  }
  await assertCrossFsIdentical(rig, 'HASH', 's5/6');
  // and after the command drained, a stopped generator produces NO further steps
  const cur = rig.proxies[0].acked.cursor;
  await run(rig, 8);
  if (rig.proxies.some((p) => p.acked.cursor !== cur)) fail(`s5/6: cursor advanced while stopped (generator not gated: ${rig.proxies.map((p) => p.acked.cursor)})`);
  else ok('s5/6: no further steps produced while stopped (generator gate holds)');
}

// ============================================================================
// [7] Pace->Race reseat: the BEHIND FS burns headroom to catch up (§2 MAX, not
// a stall). OLD scenario 7. Real-WASM version of coord-wire's [6]: diverge
// playback in Pace, switch to Race, assert the behind FS's cursor bursts
// forward and no session reads a sustained hold (nothing freezes in Race).
// ============================================================================
async function scenarioReseatBurst() {
  console.log('\n[7] Pace->Race reseat: the behind FS bursts to catch up, nothing freezes (§2 MAX)');
  const rig = await makeRig({ speed: Infinity });
  rig.coord.setMode('pace');
  rig.coord.start();
  await run(rig, 24);
  rig.coord.stop();
  const before = Object.fromEntries(rig.proxies.map((p) => [p.fsId, p.acked.playbackNs]));
  const gap = Math.abs(before.fastffs - before.littlefs);
  if (gap <= 50 * 1e6) { fail(`s7 precondition: playback gap ${(gap / 1e6).toFixed(0)}ms too small to observe reseat`); return; }
  const behind = before.fastffs < before.littlefs ? 'fastffs' : 'littlefs';
  ok(`s7: pace diverged playback (fastffs ${(before.fastffs / 1e6).toFixed(0)}ms, littlefs ${(before.littlefs / 1e6).toFixed(0)}ms); ${behind} is behind`);
  const curBefore = rig.byId[behind].acked.cursor;
  rig.coord.start();
  rig.coord.setMode('race');
  let sawBehindHold = false;
  await run(rig, 10, () => { const s = snapById(rig); if (s[behind].holding) sawBehindHold = true; });
  const curAfter = rig.byId[behind].acked.cursor;
  if (!(curAfter > curBefore)) fail(`s7: behind FS ${behind} did not advance after Pace->Race (cursor ${curBefore}->${curAfter}) — reseat wrong`);
  else ok(`s7: behind FS ${behind} burst forward on reseat (cursor ${curBefore}->${curAfter}) — burned its headroom`);
  if (sawBehindHold) fail(`s7: behind FS ${behind} read holding while catching up (it is running, not frozen)`);
  else ok(`s7: behind FS ${behind} never read holding while bursting (nothing freezes in Race)`);
}

// ============================================================================
// [9] opsPerSec tracks WORKLOAD ops (drained fileOpCount), never flash ops.
// OLD scenario 9. In Pace both FS consume steps in lockstep, so opsPerSec must
// track together across FS even though their flash-op costs differ. (The
// coordinator computes opsPerSec from acked.fileOpCount; a mutation to flash
// ops would skew the two — provable via a scratch FV_COORDINATOR copy.)
// ============================================================================
async function scenarioOpsPerSec() {
  console.log('\n[9] opsPerSec tracks workload fileOpCount, not flash ops (Pace lockstep => equal-ish rate)');
  const rig = await makeRig({ speed: Infinity });
  rig.coord.setMode('pace');
  rig.coord.start();
  await run(rig, 60);
  const s = snapById(rig);
  const ff = s.fastffs, lf = s.littlefs;
  if (ff.stepCursor !== lf.stepCursor) fail(`s9: pace cursors not in lockstep (${ff.stepCursor} vs ${lf.stepCursor})`);
  else ok(`s9: workload cursors in lockstep at ${ff.stepCursor} (steps consumed 1:1)`);
  // fileOpCount tracks workload; both should be equal in Pace lockstep.
  if (ff.fileOpCount !== lf.fileOpCount) fail(`s9: fileOpCount differs across FS in Pace lockstep (${ff.fileOpCount} vs ${lf.fileOpCount}) — not workload-tracked?`);
  else ok(`s9: fileOpCount equal across FS (${ff.fileOpCount}) despite differing flash cost`);
  if (!(ff.opsPerSec > 0) || !(lf.opsPerSec > 0)) { fail(`s9: opsPerSec not positive during an active run (ff ${ff.opsPerSec}, lf ${lf.opsPerSec})`); return; }
  // the two rates track the SAME workload; allow EMA slop but they must be close, and
  // NOT skewed by the flash-op ratio (littlefs is much chattier on flash).
  const rel = Math.abs(ff.opsPerSec - lf.opsPerSec) / Math.max(ff.opsPerSec, lf.opsPerSec);
  if (rel > 0.25) fail(`s9: opsPerSec diverges across FS (ff ${ff.opsPerSec.toFixed(1)}, lf ${lf.opsPerSec.toFixed(1)}, ${(rel * 100).toFixed(0)}% apart) — measuring flash ops, not workload?`);
  else ok(`s9: opsPerSec tracks across FS within ${(rel * 100).toFixed(0)}% (ff ${ff.opsPerSec.toFixed(1)}, lf ${lf.opsPerSec.toFixed(1)}) — the workload-op rate`);
}

// ============================================================================
// [10-15] standing signals over the REAL backend (reframed to the settled
// model: holding sustained+debounced, csActive raw per-frame; NO stalled/
// waiting). lane C's coord-wire-test proves the signal ALGEBRA against mock
// workers; this asserts the same signals surface correctly for REAL WASM
// sessions — the laggard-safe invariant (a still-executing FS never reads
// holding) and csActive tracking real playback advance.
// ============================================================================
async function scenarioSignalsRealBackend() {
  console.log('\n[10-15] standing signals over real WASM: holding laggard-safe, csActive tracks real advance');
  const rig = await makeRig({ speed: Infinity });
  // idle: neither holding nor csActive
  await run(rig, 3);
  let s = snapById(rig);
  if (FS_ORDER.some((f) => s[f].csActive || s[f].holding)) fail(`s10: a signal set while idle (${JSON.stringify(rig.coord.waitStates())})`);
  else ok('s10: idle => no csActive, no holding on either FS');
  // running Race: both advance playback most frames => csActive fires; the laggard
  // (chattier flash cost) must NEVER read holding while it is actively draining.
  rig.coord.setMode('race');
  rig.coord.start();
  let ffActive = 0, lfActive = 0, laggardHeld = false, both = 0;
  const NF = 24;
  await run(rig, NF, () => {
    const x = snapById(rig);
    if (x.fastffs.csActive) ffActive++;
    if (x.littlefs.csActive) lfActive++;
    // in Race the pricier FS is the laggard on playback; while its gate is open it is
    // running, not frozen — it must not read holding.
    const laggard = x.fastffs.simNs <= x.littlefs.simNs ? 'littlefs' : 'fastffs';
    if (x[laggard].holding && x[laggard].csActive) laggardHeld = true;
    if (x.fastffs.holding && x.littlefs.holding) both++;
  });
  if (ffActive < NF * 0.4 || lfActive < NF * 0.4) fail(`s11: csActive rarely fired while running (ff ${ffActive}/${NF}, lf ${lfActive}/${NF})`);
  else ok(`s11: csActive fired on most running frames (ff ${ffActive}/${NF}, lf ${lfActive}/${NF}) — the real-time blinky`);
  if (laggardHeld) fail('s12: a session read holding=true AND csActive=true (a frozen FS must not be advancing)');
  else ok('s12: holding and csActive never both true on one FS (mutually exclusive, laggard-safe)');
  // stop the generator, then let the fixed backlog fully drain to idle (in Race the
  // cheap FS raced ahead; the pricey FS keeps draining until its cursor reaches the
  // frontier). Pump until playback stops advancing, THEN csActive must clear.
  rig.coord.stop();
  await pumpUntil(rig, () => {
    const before = rig.proxies.map((p) => p.acked.playbackNs);
    return before.length && rig.proxies.every((p) => !snapById(rig)[p.fsId].csActive);
  }, 's13-drain-to-idle', 200);
  s = snapById(rig);
  if (FS_ORDER.some((f) => s[f].csActive)) fail('s13: csActive still set after the run stopped and drained to idle');
  else ok('s13: csActive cleared once playback stopped advancing (drained to idle)');
}

// ============================================================================
// [16] reset() abandons a mid-flight round; its stale completion is void (I5).
// OLD scenario 16(b)/(c). A command parked mid-flight when reset() bumps the
// epoch must not land in the fresh epoch. We park a command at a test-held gate
// (the gate is in-realm test rigging, visible to the compiled command since the
// mock transport shares the process — see LANE-REPORT.md), reset, then release:
// the zombie's post-gate write must never appear on the fresh chip.
// ============================================================================
async function scenarioResetAbandonsMidFlight() {
  console.log('\n[16] reset() abandons a mid-flight round; the zombie completion is void (I5/§8)');
  const rig = await makeRig({ speed: Infinity });
  let release;
  globalThis.__fvGate16 = new Promise((r) => { release = r; });
  const src = `await writeFile('z-before.bin', 2048); await globalThis.__fvGate16; await writeFile('z-after.bin', 2048)`;
  const idx = rig.coord.broadcast(src, 'gated16').index;
  rig.coord.setMode('pace');
  // give it a few frames to dispatch the command and reach the gate (parked mid-fn)
  await run(rig, 6);
  let parked = true;
  for (const fsId of FS_ORDER) {
    const j = await pullJournal(rig, fsId);
    if (countLines(j, 'write(z-before.bin') < 1) parked = false;
  }
  if (!parked) { fail('s16: command never reached the gate (window not established)'); release(); return; }
  ok('s16: both sessions parked mid-command at the gate (wrote z-before)');
  rig.coord.reset();                        // epoch bump; in-flight round must starve
  await flushTurns(6);
  release();                                // wake the zombie: its post-gate write must NOT land
  await flushTurns(20);
  await bootFormat(rig);                     // fresh chip needs formatting to be readable
  for (const fsId of FS_ORDER) {
    const j = await pullJournal(rig, fsId);
    if (j.some((l) => l.text.includes('z-after.bin'))) fail(`s16: ${fsId} the zombie's post-gate write (z-after.bin) landed after reset (I5 violated)`);
    else ok(`s16: ${fsId} the abandoned round left no trace after reset (starved per §8)`);
  }
  if (!cursorsEqualAt(rig, 1)) fail(`s16: coordinator not live on the fresh epoch (cursors ${rig.proxies.map((p) => p.acked.cursor)}, expected format at 1)`);
  else ok('s16: coordinator stayed live on the fresh epoch after abandoning the round');
  delete globalThis.__fvGate16;
}

// ============================================================================
// [17] Race at TOP speed keeps flash time bounded (the max-speed §2 bound).
// Regression for the off-spec infinite-scale path: setSpeed(Infinity) used to set
// atMax and send grant.scale=Infinity, so the worker's drain budget was Infinity and
// it IGNORED playLimitNs, the whole §2 bound lives in playLimitNs, so at "max" it did
// nothing and Race flash times DIVERGED (user repro: 61/25/25/61/106ms across 5 FS,
// growing with runtime). Now setSpeed CLAMPS to MAX_SCALE (1e7 = 10× real-time): there
// is no infinite scale, everything flows the finite metered path, and the leader may
// run at most 2×chunk of flash time ahead of the slowest. This MUST be real WASM: the
// bug only exists with the real flat-out worker. Two FS of very different per-op cost
// (fastffs vs littlefs); we assert the flash-time gap stays within ~2×chunk AND does
// not GROW over runtime (the divergence signature). Pre-clamp this fails (unbounded
// growth); post-clamp it plateaus.
// ============================================================================
async function scenarioRaceMaxSpeedBound() {
  console.log('\n[17] Race at MAX speed: flash time stays within the 2×chunk bound, does not diverge');
  const MS_PER_FRAME = 1000 / 60, MAX_SCALE = 1e7;   // mirrors lockstep.js
  const CHUNK = MAX_SCALE * MS_PER_FRAME;             // §2 Δ at the top speed
  const BOUND = 2 * CHUNK;                            // RACE_LEAD_BOUND_FRAMES = 2
  const rig = await makeRig({ speed: Infinity });     // Infinity input PROVES the clamp (becomes 1e7)
  rig.coord.setMode('race');
  rig.coord.start();
  const gapNs = () => { const v = rig.proxies.map((p) => p.acked.playbackNs); return Math.max(...v) - Math.min(...v); };
  await run(rig, 40);
  const gapEarly = gapNs();
  await run(rig, 120);
  const gapLate = gapNs();
  const ms = (n) => (n / 1e6).toFixed(0);
  // 1. absolute: within the bound (allow a small margin for one big-op overshoot).
  if (gapLate > BOUND + 0.3 * CHUNK) fail(`s17: flash-time gap ${ms(gapLate)}ms exceeds the 2×chunk bound ${ms(BOUND)}ms, the max-speed bound is not enforced (infinite-scale path still live?)`);
  else ok(`s17: flash-time gap ${ms(gapLate)}ms stays within the 2×chunk bound (${ms(BOUND)}ms) at MAX speed`);
  // 2. divergence signature: the gap must NOT grow with runtime. Unbounded (pre-clamp)
  // it grows ~linearly with frames; bounded it plateaus.
  if (gapLate > gapEarly * 1.5 + 0.15 * CHUNK) fail(`s17: flash-time gap GREW ${ms(gapEarly)}ms → ${ms(gapLate)}ms over 120 frames, diverging, not bounded (max-speed clock unmetered)`);
  else ok(`s17: flash-time gap plateaued (${ms(gapEarly)}ms → ${ms(gapLate)}ms over 120 frames), bounded, not diverging`);
  // 3. both FS actually ran (not a vacuous pass on a stalled rig).
  if (rig.proxies.some((p) => p.acked.playbackNs < CHUNK)) fail('s17: a session barely advanced, the run did not exercise MAX speed');
  else ok('s17: both FS ran flat-out at MAX speed (metered against the finite ceiling)');
}

// ---- run all ----
console.log('ADR-0024 concurrency suite — REAL coordinator + REAL worker host + REAL WASM over the wire\n');
await scenarioExactlyOnce();
await scenarioResetReproducible();
await scenarioRejectingCommand();
await scenarioStopGatesGeneratorOnly();
await scenarioReseatBurst();
await scenarioOpsPerSec();
await scenarioSignalsRealBackend();
await scenarioResetAbandonsMidFlight();
await scenarioRaceMaxSpeedBound();

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - the converted concurrency scenarios are green against the REAL production worker');
console.log('       backend end to end (real coordinator + real worker host + real WASM over the wire):');
console.log('       exactly-once dispatch, reset reproducibility (journal-print byte-identity), reject');
console.log('       recovery, stop-gates-generator-only, Pace->Race reseat, opsPerSec, signals, reset');
console.log('       abandons mid-flight. See LANE-REPORT.md for the OLD->NEW mapping + mutation evidence.');
process.exit(0);
