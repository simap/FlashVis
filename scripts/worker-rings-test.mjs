/*
 * worker-rings-test.mjs: unit guard for web/src/worker-rings.js's createRing
 * (ADR-0024 §7), the worker-side bounded ring that replaced session.js's
 * unbounded journal array (the tape-leak regression: playground.js:252 set a
 * tapeNodes entry per line while session.js's journal grew forever). Locks:
 *   1. bounded: pushing far more than `max` keeps length capped at `max`,
 *      not tracking the push count.
 *   2. ring semantics: newest item retained, oldest evicted (FIFO eviction,
 *      LIFO-recent retention).
 *   3. monotonic, never-reused ids: `since` is a stable cursor even across
 *      eviction (head is one-past the highest id ever issued, ADR-0024 §7).
 *   4. since()/newest() windowing matches the wire contract session-worker.js
 *      relies on: since(x) returns id > x oldest-first, capped to the newest
 *      `limit`; newest(limit) returns the last `limit` items.
 */
import { createRing } from '../web/src/worker-rings.js';

let failures = 0;
const fail = (m) => { failures++; console.error('  FAIL -', m); };
const ok = (m) => console.log('  ok   -', m);

const MAX = 2000;

// ---- 1. bounded: pushing far more than max keeps length capped ----
{
  const ring = createRing(MAX);
  for (let i = 0; i < 500; i++) ring.push({ text: `op ${i}` });
  const midLen = ring.newest(null).length;
  for (let i = 500; i < 12000; i++) ring.push({ text: `op ${i}` });
  const endLen = ring.newest(null).length;
  if (endLen > MAX) fail(`ring grew unbounded: length ${endLen} > cap ${MAX} after 12000 pushes`);
  else ok(`ring bounded at ${endLen} (<= ${MAX}) after 12000 pushes (was ${midLen} at 500)`);
  if (endLen !== MAX) fail(`ring did not fill to its cap (${endLen} !== ${MAX})`);
  else ok(`ring fills to exactly its cap (${MAX}) once overfull`);
}

// ---- 2. ring semantics: newest retained, oldest evicted ----
{
  const ring = createRing(MAX);
  for (let i = 0; i < 12000; i++) ring.push({ text: `op ${i}` });
  const items = ring.newest(null);
  if (items[items.length - 1].text !== 'op 11999') fail('ring did not keep the newest item');
  else ok('ring keeps the newest item (LIFO-recent retention)');
  if (items.some((it) => it.text === 'op 0')) fail('ring still holds the oldest item (not evicted)');
  else ok('ring evicted the oldest items (FIFO eviction)');
}

// ---- 3. monotonic, never-reused ids; head is one-past the highest issued ----
{
  const ring = createRing(MAX);
  for (let i = 0; i < 5; i++) ring.push({ text: `a${i}` });
  if (ring.head !== 5) fail(`head should be 5 after 5 pushes, got ${ring.head}`);
  else ok('head is one-past the highest id issued (5 after 5 pushes)');
  for (let i = 5; i < MAX + 500; i++) ring.push({ text: `a${i}` });
  if (ring.head !== MAX + 500) fail(`head should track total pushes (${MAX + 500}) even past eviction, got ${ring.head}`);
  else ok(`head tracks total pushes past eviction (${ring.head}), a stable cursor despite trimming`);
  const items = ring.newest(null);
  const ids = items.map((it) => it.id);
  if (new Set(ids).size !== ids.length) fail('ring has duplicate ids after eviction (ids reused)');
  else ok('ids are never reused, even after eviction');
}

// ---- 4. since()/newest() windowing (the wire contract session-worker.js uses) ----
{
  const ring = createRing(MAX);
  for (let i = 0; i < 50; i++) ring.push({ text: `x${i}` });
  const tail = ring.since(44);   // items with id > 44: ids 45..49
  if (tail.length === 5 && tail[0].id === 45 && tail[tail.length - 1].id === 49) ok('since(x) returns id > x, oldest-first (exclusive-since contract)');
  else fail(`since(44) wrong window: ${JSON.stringify(tail.map((t) => t.id))}`);

  const capped = ring.since(-1, 10);   // all 50, capped to newest 10
  if (capped.length === 10 && capped[0].id === 40 && capped[9].id === 49) ok('since(x, limit) caps to the newest `limit` of the window, still oldest-first');
  else fail(`since(-1, 10) wrong window: ${JSON.stringify(capped.map((t) => t.id))}`);

  const last3 = ring.newest(3);
  if (last3.length === 3 && last3[0].id === 47 && last3[2].id === 49) ok('newest(limit) returns the last `limit` items');
  else fail(`newest(3) wrong window: ${JSON.stringify(last3.map((t) => t.id))}`);

  const all = ring.newest(null);
  if (all.length === 50) ok('newest(null) returns every item');
  else fail(`newest(null) should return all 50, got ${all.length}`);
}

// ---- 5. clear() resets storage but the caller re-seeds nextId at reset time
//         (session-worker.js recreates the ring on geometry change; ids stay
//         monotonic across a same-instance clear only if the caller intends
//         that: here we just confirm clear() empties storage) ----
{
  const ring = createRing(MAX);
  for (let i = 0; i < 10; i++) ring.push({ text: `y${i}` });
  ring.clear();
  if (ring.newest(null).length !== 0) fail('clear() did not empty the ring');
  else ok('clear() empties the ring storage');
}

console.log('');
if (failures) { console.error(`FAIL - ${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS - worker-rings.js createRing is a bounded, monotonic-id ring buffer (ADR-0024 §7 tape-leak guard).');
process.exit(0);
