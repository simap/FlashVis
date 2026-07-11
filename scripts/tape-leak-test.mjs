/*
 * Regression guard for the tape / journal memory leak (playground.js:252 setting
 * a tapeNodes entry per line vs :268 evicting the DOM node WITHOUT deleting the
 * entry, plus session.js's unbounded `journal` array). Every auto-workload op logs
 * one line, so at sim speed thousands/sec accumulated forever.
 *
 * This drives the SESSION side directly (createSession under fake DOM). The
 * playground `tapeNodes` Map is a private closure not observable from a test, so
 * this locks the two externally-observable invariants:
 *   1. session.journal is a bounded ring buffer (does not grow with op count),
 *      keeping the newest lines (the ones the tape shows).
 *   2. a command entry trimmed out of the journal is STILL mutable via
 *      setJournalState (the coordinator holds it by reference through
 *      entry.journalEntries), so trimming can't break the queued->live->done
 *      lifecycle. This is the command-lifecycle safety argument, exercised.
 * The playground-side tapeNodes pruning is exercised end-to-end by the real-backend
 * smoke (test:realsmoke boots playground.js and drives the tape) staying green.
 */
import { installFakeDom } from './fake-dom.mjs';
// FV_SESSION points this at a scratch copy of session.js for mutation testing
// (remove the JOURNAL_MAX cap -> this test FAILs). Unset in npm test.
const { createSession } = await import(process.env.FV_SESSION || '../web/src/session.js');

const GEOMETRY = { sectorSize: 4096, sectorCount: 64, pageSize: 256, granule: 1 };
const JOURNAL_MAX = 2000;          // must match session.js
const TAPE_WINDOW = 400;           // must match playground.js renderTapeFull slice(-400)

const dom = installFakeDom();
let failures = 0;
const fail = (m) => { failures++; console.error('  FAIL -', m); };
const ok = (m) => console.log('  ok   -', m);

const s = await createSession('fastffs', { geometry: GEOMETRY, container: document.createElement('div'), name: 'fastffs' });

// ---- 1. journal is a bounded ring buffer under a long op stream ----
// Append far more than the cap; length must plateau, not track op count.
for (let i = 0; i < 500; i++) s.appendJournal(`op ${i}`, 'out');
const midLen = s.journal.length;
for (let i = 500; i < 12000; i++) s.appendJournal(`op ${i}`, 'out');
const endLen = s.journal.length;
if (endLen > JOURNAL_MAX) fail(`journal grew unbounded: length ${endLen} > cap ${JOURNAL_MAX} after 12000 appends`);
else ok(`journal bounded at ${endLen} (<= ${JOURNAL_MAX}) after 12000 appends (was ${midLen} at 500)`);
if (endLen < TAPE_WINDOW) fail(`journal shorter than the ${TAPE_WINDOW}-line tape window (${endLen})`);
else ok(`journal keeps >= the ${TAPE_WINDOW} lines the tape displays`);

// ring semantics: the newest line is retained, the oldest was dropped.
if (s.journal[s.journal.length - 1].text !== 'op 11999') fail('journal did not keep the newest line');
else ok('journal keeps the newest line (ring, not FIFO-of-oldest)');
if (s.journal.some((e) => e.text === 'op 0')) fail('journal still holds the oldest line (not trimmed)');
else ok('journal dropped the oldest lines');
// the displayed window (last 400) is the newest 400, contiguous.
const win = s.journal.slice(-TAPE_WINDOW);
if (win[win.length - 1].id - win[0].id !== TAPE_WINDOW - 1) fail('the last-400 tape window is not the newest contiguous run');
else ok('the last-400 tape window is the newest contiguous run (tape shows the same lines as before)');

// ---- 2. command-lifecycle safety: a trimmed entry is still mutable ----
// Append a command entry, then bury it far beyond the cap, then flip its state.
const cmd = s.appendJournal('> myCommand()', 'cmd', 'queued');
for (let i = 0; i < JOURNAL_MAX + 500; i++) s.appendJournal(`churn ${i}`, 'out');
if (s.journal.includes(cmd)) fail('test setup: command entry was not trimmed (cannot exercise the trimmed-but-live case)');
else ok('command entry was trimmed out of the journal array (buried > cap)');
let threw = false;
try { s.setJournalState(cmd, 'live'); s.setJournalState(cmd, 'done'); } catch (e) { threw = true; console.error('   ', e && e.message); }
if (threw) fail('setJournalState on a trimmed command entry threw (lifecycle broken)');
else if (cmd.state !== 'done') fail(`trimmed command entry did not advance: state ${cmd.state}`);
else ok('a trimmed command entry still advances queued->live->done by reference (lifecycle safe)');

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - journal is a bounded ring buffer; trimmed command entries stay mutable (tape leak guarded).');
process.exit(0);
