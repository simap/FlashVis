/*
 * About / explainer panel wiring.
 *
 * The panel is a native <dialog>, so Esc-to-close, focus trapping while open,
 * and focus-return to the opener are handled by the platform. This module only
 * opens it and closes it on a backdrop click. Loaded on its own from index.html
 * (not by the headless test harness, which imports playground.js directly), so
 * it is defensive: if the markup or showModal is missing, it quietly does
 * nothing rather than throwing.
 */
const dlg = document.getElementById('aboutPanel');
const openBtn = document.getElementById('aboutBtn');
const closeBtn = document.getElementById('aboutClose');

if (dlg && openBtn) {
  const open = () => {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');   // fallback for a dialog without modal support
  };
  const close = () => {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  };

  openBtn.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);

  // A click that lands on the dialog element itself (not its content) is a click
  // on the backdrop area; close on it, matching the usual modal affordance.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
}
