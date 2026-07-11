/*
 * A minimal fake DOM so the browser modules (viz, playground) can boot headless
 * in Node against the REAL WASM — no jsdom, no browser. Reused by dom-smoke.mjs
 * and any focused variant (timed player, barrier pacing, live-map, dir iterator).
 *
 * CRITICAL: never define `global.window`. Emscripten sniffs it and switches to
 * web mode, which fails to load the `.wasm` under Node. Stubbing document /
 * matchMedia / requestAnimationFrame / setInterval alone is fine — that is
 * exactly the seam these modules touch.
 *
 * The fake element is deliberately loose: unknown properties just stick. It
 * omits `animate` on purpose — viz.js guards on `!el.animate` and skips the Web
 * Animations calls, so we don't have to model them.
 */

class FakeEl {
  // `registry` is the same id→element map `document.getElementById` reads
  // (only passed by `document.createElement` — see installFakeDom). Setting
  // `.id` on an element created that way registers it, so a dynamically built
  // element (e.g. a scoreboard segment built + appended at runtime, ADR-0018)
  // is the SAME object a later `getElementById`/dispatch resolves to — not a
  // second, listener-less phantom auto-vivified by the plain lookup path
  // static HTML-id elements rely on (see getEl below).
  constructor(tag = 'div', registry = null) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this._id = '';
    this._registry = registry;
    this.textContent = '';
    this._innerHTML = '';
    this.value = '50';            // sane default for slider .value reads
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.tabIndex = -1;
    this._attrs = {};
    this._listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
    };
    this.style = new Proxy({ setProperty() {} }, {
      get: (t, k) => (k in t ? t[k] : ''),
      set: (t, k, v) => { t[k] = v; return true; },
    });
  }
  get id() { return this._id; }
  set id(v) { this._id = v; if (this._registry && v) this._registry.set(v, this); }
  // No real parsing — just enough fidelity for the common "clear + rebuild"
  // pattern real code uses (e.g. renderTapeFull/renderLegend): setting
  // innerHTML drops this element's CURRENT children, matching a real
  // browser's observable effect on `.children`/`.firstChild`/etc., even
  // though the string itself isn't parsed into new child nodes here.
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  setAttribute(k, v) { this._attrs[k] = String(v); }   // e.g. aria-pressed on a lane
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] ?? null; }
  querySelector() { return new FakeEl(); }        // e.g. .dot inside a button
  closest() { return this; }                      // e.g. e.target.closest('button')
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners.get(type); if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }
  dispatch(type, ev = {}) {
    for (const fn of this._listeners.get(type) ?? []) fn({ target: this, ...ev });
  }
}

export function installFakeDom() {
  const byId = new Map();
  const getEl = (id) => {
    if (!byId.has(id)) byId.set(id, new FakeEl());
    return byId.get(id);
  };

  const rafQueue = [];
  let clock = 0;                                   // fake ms timestamp for rAF
  const intervals = [];                            // captured, never auto-fired

  const saved = {};
  const set = (k, v) => { saved[k] = { had: k in globalThis, val: globalThis[k] }; globalThis[k] = v; };

  set('document', {
    getElementById: getEl,
    createElement: (tag) => new FakeEl(tag, byId),
    // Real documents always have a root element; the palette switcher sets
    // [data-theme] on it. No getComputedStyle here, so viz.js falls back to its
    // default glow colors (the theme resolution is guarded for exactly this).
    documentElement: new FakeEl('html', byId),
  });
  set('matchMedia', () => ({ matches: false, addEventListener() {}, addListener() {} }));
  set('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  set('cancelAnimationFrame', () => {});
  set('setInterval', (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; });
  set('clearInterval', () => {});

  return {
    getEl,
    /** Fire a click (or other event) at an element by id. */
    dispatch(id, type = 'click', ev) { getEl(id).dispatch(type, ev); },
    /** Run `n` animation frames, advancing the fake clock ~16 ms each. */
    tick(n = 1, dtMs = 16) {
      for (let i = 0; i < n; i++) {
        const batch = rafQueue.splice(0, rafQueue.length);
        clock += dtMs;
        for (const cb of batch) cb(clock);
      }
    },
    /** Fire every captured setInterval callback once (deterministic HUD/liveness). */
    runIntervals() { for (const it of intervals) it.fn(); },
    /** Restore the globals we replaced. */
    uninstall() {
      for (const k in saved) {
        if (saved[k].had) globalThis[k] = saved[k].val; else delete globalThis[k];
      }
    },
  };
}
