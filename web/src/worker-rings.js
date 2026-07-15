/*
 * worker-rings.js — append-only, monotonic-id ring buffer for the worker-side
 * journal + viz-event logs (ADR-0024 §7). Ids are never reused (issued from a
 * single ever-increasing counter), so `since` is a stable cursor and a gap
 * (firstId > since+1) is arithmetically detectable by the caller as ring
 * eviction. Bounded at `max` (>= protocol.js's JOURNAL_MIN floor) — the ring
 * bound is worker-local, not a wire concept.
 */
export function createRing(max) {
  let items = [];
  let nextId = 0;
  return {
    /** Append one entry (fields merged after an assigned `id`). Returns the entry. */
    push(fields) {
      const item = { id: nextId++, ...fields };
      items.push(item);
      if (items.length > max) items.shift();
      return item;
    },
    /** One past the highest id ever issued (head pointer, §7 journalHead/eventHead). */
    get head() { return nextId; },
    /** Every item with id > since, oldest-first, capped to the newest `limit` of
     *  that window when `limit` is given. */
    since(since, limit) {
      const out = items.filter((it) => it.id > (since ?? -1));
      if (limit != null && out.length > limit) return out.slice(out.length - limit);
      return out;
    },
    /** The newest `limit` items (or all, if `limit` is null) — the (re)attach mode. */
    newest(limit) {
      if (limit == null) return items.slice();
      return items.slice(Math.max(0, items.length - limit));
    },
    clear() { items = []; },
  };
}
