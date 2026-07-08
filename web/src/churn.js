/*
 * churn.js — JS port of the FASTFFS deterministic churn generator
 * (fs/fastffs/benchmarks/churn_model/churn_model.{h,c}).
 *
 * The port is BYTE-EXACT with the C model: the same LCG PRNG and the same
 * order of PRNG draws (size-class weighting, replace-vs-create, delete
 * selection, forced-large) so that for a given seed this emits the identical
 * event stream the C model would. That is what lets the browser sim reproduce a
 * FASTFFS benchmark run.
 *
 * Everything around the numeric sequence is JS-idiomatic: classes/events are
 * plain objects, class + event type are strings, and the model is a small class
 * driven by next()/apply() — no C structs, enums-as-ints, or fixed name buffers.
 */

// Size classes, in the SAME order the C enum declares them. The order is
// load-bearing: choose_churn_size subtracts weights in this order, so reordering
// would change which PRNG value maps to which class.
export const CHURN_CLASS = Object.freeze({ SMALL: 'small', MEDIUM: 'medium', LARGE: 'large' });
const CLASS_ORDER = [CHURN_CLASS.SMALL, CHURN_CLASS.MEDIUM, CHURN_CLASS.LARGE];

export const CHURN_EVENT = Object.freeze({
  DONE: 'done',       // total_written reached target_written — nothing more to do
  DELETE: 'delete',   // remove event.name (freeing event.size bytes)
  WRITE: 'write',     // create-or-replace event.name with event.size bytes
  NO_SLOT: 'no_slot', // wanted to write but no slot was available
});

const U32 = 0x100000000;
const FORCED_LARGE_SIZE = 350 * 1024; // C hardcodes 350*1024 for a forced-large write

/** The C default_profile, verbatim (weights + sizes), for byte-exact parity. */
export function defaultProfile() {
  return {
    namePrefix: 'w',
    replacePercent: 25,
    protectFirstLarge: true,
    classes: [
      { key: CHURN_CLASS.SMALL,  name: 'small_10_20k',  weight: 800, minSize: 10 * 1024,  maxSize: 20 * 1024 },
      { key: CHURN_CLASS.MEDIUM, name: 'medium_20_60k', weight: 150, minSize: 20 * 1024,  maxSize: 60 * 1024 },
      { key: CHURN_CLASS.LARGE,  name: 'large_350k',    weight: 50,  minSize: 350 * 1024, maxSize: 350 * 1024 },
    ],
  };
}

/**
 * @typedef {Object} ChurnOptions
 * @property {number} seed                 PRNG seed (uint32).
 * @property {number} targetLiveBytes      steady-state live-data target.
 * @property {number} targetWrittenBytes   emit DONE once this many bytes have been written.
 * @property {number} targetSlackBytes     tolerance above targetLive before forced deletes kick in.
 * @property {number} forceLargeAfterBytes once total_written passes this, force one large write. Use 0xFFFFFFFF to disable.
 * @property {Object} [profile]            defaults to defaultProfile().
 * @property {number} [slotCount]          max concurrent files (C default 256).
 */

export class ChurnModel {
  constructor(opts) {
    this._opts = opts;
    this.profile = opts.profile || defaultProfile();
    this.slotCount = opts.slotCount ?? 256;
    this.reset();
  }

  /** Re-initialise to a pristine run. Pass { seed } to re-seed. */
  reset(overrides = {}) {
    const o = this._opts;
    this.seed = (overrides.seed ?? o.seed) >>> 0;
    this.state = this.seed;
    this.targetLiveBytes = o.targetLiveBytes >>> 0;
    this.targetWrittenBytes = o.targetWrittenBytes >>> 0;
    this.targetSlackBytes = o.targetSlackBytes >>> 0;
    this.forceLargeAfterBytes = o.forceLargeAfterBytes >>> 0;

    // running totals / metrics
    this.totalWritten = 0;
    this.liveBytes = 0;
    this.opCount = 0;
    this.createCount = 0;
    this.replaceCount = 0;
    this.deleteCount = 0;
    this.forcedLargeWritten = false;
    this.liveFileCount = 0;

    // in-flight next()/apply() state machine
    this.pendingWrite = false;
    this.optionalDeleteChecked = false;
    this.slotChosen = false;
    this.pendingReplacing = false;
    this.pendingSlot = -1;
    this.protectedLargeSlot = -1;
    this.pendingCls = CHURN_CLASS.SMALL;
    this.pendingSize = 0;

    // slot table — the model's own record of what "exists"
    this.slots = Array.from({ length: this.slotCount }, () => ({
      live: false, cls: CHURN_CLASS.SMALL, size: 0, writeSeed: 0, name: '',
    }));
  }

  // --- PRNG: state = (state*1664525 + 1013904223) mod 2^32, exactly as C ---
  _prng() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  _chooseChurnSize() {
    let totalWeight = 0;
    for (const c of this.profile.classes) totalWeight += c.weight;
    if (totalWeight === 0) return { cls: CHURN_CLASS.SMALL, size: 0 };

    let r = this._prng() % totalWeight;
    for (const c of this.profile.classes) {
      if (r >= c.weight) { r -= c.weight; continue; }
      if (c.maxSize <= c.minSize) return { cls: c.key, size: c.minSize };
      return { cls: c.key, size: c.minSize + (this._prng() % (c.maxSize - c.minSize + 1)) };
    }
    // unreachable when weights are consistent; mirror C's fallthrough
    return { cls: CHURN_CLASS.SMALL, size: this.profile.classes[0].minSize };
  }

  _findFreeSlot() {
    for (let i = 0; i < this.slotCount; i++) if (!this.slots[i].live) return i;
    return -1;
  }

  _chooseLiveSlot() {
    let liveCount = 0;
    for (let i = 0; i < this.slotCount; i++) {
      if (this.slots[i].live && i !== this.protectedLargeSlot) liveCount++;
    }
    if (liveCount === 0) {
      if (this.protectedLargeSlot >= 0 && this.slots[this.protectedLargeSlot].live) return this.protectedLargeSlot;
      return -1;
    }
    let target = this._prng() % liveCount;
    for (let i = 0; i < this.slotCount; i++) {
      if (this.slots[i].live && i !== this.protectedLargeSlot && target-- === 0) return i;
    }
    return -1;
  }

  static _deleteWeight(slot) {
    const w = Math.floor(slot.size / 4096);
    return w === 0 ? 1 : w;
  }

  _chooseDeleteSlot() {
    let totalWeight = 0;
    for (let i = 0; i < this.slotCount; i++) {
      if (this.slots[i].live && i !== this.protectedLargeSlot) totalWeight += ChurnModel._deleteWeight(this.slots[i]);
    }
    if (totalWeight === 0) {
      if (this.protectedLargeSlot >= 0 && this.slots[this.protectedLargeSlot].live) return this.protectedLargeSlot;
      return -1;
    }
    let target = this._prng() % totalWeight;
    for (let i = 0; i < this.slotCount; i++) {
      if (!this.slots[i].live || i === this.protectedLargeSlot) continue;
      const w = ChurnModel._deleteWeight(this.slots[i]);
      if (target < w) return i;
      target -= w;
    }
    return -1;
  }

  _deleteEvent(slot) {
    const s = this.slots[slot];
    return { type: CHURN_EVENT.DELETE, slot, cls: s.cls, size: s.size, oldSize: 0, writeSeed: 0, replacing: false, name: s.name };
  }

  _writeEvent() {
    const slot = this.slots[this.pendingSlot];
    const writeSeed = (this.totalWritten ^ this.pendingSlot) >>> 0;
    const name = this.pendingReplacing
      ? slot.name
      : `${this.profile.namePrefix || 'w'}${String(this.pendingSlot).padStart(4, '0')}-${writeSeed.toString(16).padStart(8, '0')}.bin`;
    return {
      type: CHURN_EVENT.WRITE,
      slot: this.pendingSlot,
      cls: this.pendingCls,
      size: this.pendingSize,
      oldSize: this.pendingReplacing ? slot.size : 0,
      writeSeed,
      replacing: this.pendingReplacing,
      name,
    };
  }

  /** Compute the next event. Mutates only the in-flight state machine + PRNG. */
  next() {
    if (!this.pendingWrite) {
      if (this.totalWritten >= this.targetWrittenBytes) {
        return { type: CHURN_EVENT.DONE, slot: -1, cls: CHURN_CLASS.SMALL, size: 0, oldSize: 0, writeSeed: 0, replacing: false, name: '' };
      }
      if (!this.forcedLargeWritten && this.totalWritten >= this.forceLargeAfterBytes) {
        this.pendingCls = CHURN_CLASS.LARGE;
        this.pendingSize = FORCED_LARGE_SIZE;
        this.forcedLargeWritten = true;
      } else {
        const { cls, size } = this._chooseChurnSize();
        this.pendingCls = cls;
        this.pendingSize = size;
      }
      this.pendingWrite = true;
      this.optionalDeleteChecked = false;
      this.slotChosen = false;
      this.pendingReplacing = false;
      this.pendingSlot = -1;
    }

    // Hard ceiling: shed live data until the pending write fits under target+slack.
    while (this.liveBytes + this.pendingSize > this.targetLiveBytes + this.targetSlackBytes) {
      const del = this._chooseDeleteSlot();
      if (del < 0) break;
      return this._deleteEvent(del);
    }

    // Occasional opportunistic delete when we're already above target.
    if (!this.optionalDeleteChecked) {
      this.optionalDeleteChecked = true;
      if (this.liveBytes > this.targetLiveBytes && (this._prng() & 7) === 0) {
        const del = this._chooseDeleteSlot();
        if (del >= 0) return this._deleteEvent(del);
      }
    }

    // Pick the slot for the pending write: replace, else free slot, else evict.
    if (!this.slotChosen) {
      if ((this._prng() % 100) < this.profile.replacePercent) {
        const slot = this._chooseLiveSlot();
        if (slot >= 0) { this.pendingSlot = slot; this.pendingReplacing = true; }
      }
      if (this.pendingSlot < 0) { this.pendingSlot = this._findFreeSlot(); this.pendingReplacing = false; }
      if (this.pendingSlot < 0) {
        const del = this._chooseDeleteSlot();
        if (del >= 0) {
          this.pendingSlot = del;
          this.pendingReplacing = false;
          return this._deleteEvent(del);
        }
      }
      this.slotChosen = true;
    }

    if (this.pendingSlot < 0) {
      return { type: CHURN_EVENT.NO_SLOT, slot: -1, cls: this.pendingCls, size: this.pendingSize, oldSize: 0, writeSeed: 0, replacing: false, name: '' };
    }
    return this._writeEvent();
  }

  /** Commit an event returned by next() into the slot table + metrics. */
  apply(event) {
    if (event.type === CHURN_EVENT.DELETE) {
      const slot = this.slots[event.slot];
      if (slot.live) {
        this.liveBytes -= slot.size;
        slot.live = false;
        if (this.liveFileCount > 0) this.liveFileCount--;
        this.deleteCount++;
      }
      return;
    }
    if (event.type === CHURN_EVENT.WRITE) {
      const slot = this.slots[event.slot];
      if (event.replacing && slot.live) {
        this.liveBytes -= slot.size;
        this.replaceCount++;
      } else {
        this.liveFileCount++;
        this.createCount++;
      }
      slot.live = true;
      slot.cls = event.cls;
      slot.size = event.size;
      slot.writeSeed = event.writeSeed;
      slot.name = event.name;
      if (this.profile.protectFirstLarge && event.cls === CHURN_CLASS.LARGE && this.protectedLargeSlot < 0) {
        this.protectedLargeSlot = event.slot;
      }
      this.liveBytes += event.size;
      this.totalWritten = (this.totalWritten + event.size) % U32; // uint32 wrap, matches C
      this.opCount++;
      this.pendingWrite = false;
      this.pendingSlot = -1;
      this.slotChosen = false;
    }
    // DONE / NO_SLOT: no state change, mirroring C's default case.
  }

  /** Live file names, per the model's own slot table (a churn-model view of what exists). */
  names() {
    const out = [];
    for (let i = 0; i < this.slotCount; i++) if (this.slots[i].live) out.push(this.slots[i].name);
    return out;
  }
}

export function createChurnModel(opts) {
  return new ChurnModel(opts);
}
