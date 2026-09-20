/**
 * Position guard for the floating block handle.
 *
 * Two defects motivated this, both observed in the running app:
 *
 *   1. **Stale positions flash on screen.** `BlockProvider.show()` computes the
 *      position asynchronously and only then flips `data-show` on. Moving the pointer
 *      quickly fires `show(A)` then `show(B)`; A's promise resolves first, paints the
 *      handle at A's coordinates and reveals it, and B's resolution moves it a frame
 *      later. The handle visibly appears at the previous block and jumps.
 *
 *   2. **The handle can land on top of content.** The plugin anchors to whichever
 *      node it resolved, and for a list item that is the `li` — whose left edge is
 *      where the *text* starts, not where the block starts. A handle placed to the
 *      left of that edge covers the bullet.
 *
 * Rather than nudge offsets until the symptoms go away, this gates visibility on an
 * invariant: the handle is only drawn when it is vertically on the active block and
 * horizontally clear of the text column. A position that fails the check is not
 * corrected — it is simply not shown, and the next (correct) update reveals it.
 *
 * The observer runs as a microtask, before paint, so a rejected position never
 * reaches the screen.
 */

/** Horizontal slack, in px, tolerated between the handle and the text column. */
const X_TOLERANCE = 1;
/** Vertical slack, in px, for anti-aliased/fractional block bounds. */
const Y_TOLERANCE = 2;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.element      The handle element.
 * @param {() => ({el: HTMLElement}|null)} opts.getActive  Current active block.
 * @param {() => HTMLElement} opts.getColumn  Element whose left edge is the text column.
 * @param {(msg: string, detail: object) => void} [opts.onReject] Called when a position
 *   is refused. Wired to console.error in development so regressions are loud.
 * @returns {() => void} disconnect
 */
export function guardHandlePosition({ element, getActive, getColumn, onReject }) {
  const validate = () => {
    if (element.dataset.show !== 'true') {
      element.dataset.valid = '0';
      return;
    }

    const active = getActive();
    const column = getColumn();
    if (!active?.el || !column) {
      element.dataset.valid = '0';
      return;
    }

    const handle = element.getBoundingClientRect();
    // A zero-sized rect means the browser has not laid the handle out yet; wait for
    // the next mutation rather than reporting a false failure.
    if (handle.width === 0 && handle.height === 0) {
      element.dataset.valid = '0';
      return;
    }

    const block = active.el.getBoundingClientRect();
    const col = column.getBoundingClientRect();

    // Invariant 1: the handle sits entirely left of the text column.
    const clearOfText = handle.right <= col.left + X_TOLERANCE;

    // Invariant 2: the handle is vertically on the block it belongs to. This is what
    // catches a stale async position — it will be centred on the previous block.
    const centre = handle.top + handle.height / 2;
    const onBlock =
      centre >= block.top - Y_TOLERANCE && centre <= block.bottom + Y_TOLERANCE;

    if (clearOfText && onBlock) {
      element.dataset.valid = '1';
      return;
    }

    element.dataset.valid = '0';
    onReject?.('block handle position refused', {
      reason: !clearOfText ? 'overlaps the text column' : 'not on the active block',
      handle: { top: handle.top, right: handle.right, bottom: handle.bottom },
      block: { top: block.top, left: block.left, bottom: block.bottom },
      columnLeft: col.left,
    });
  };

  const observer = new MutationObserver(validate);
  observer.observe(element, { attributes: true, attributeFilter: ['data-show', 'style'] });

  // Recheck on scroll and resize: the handle keeps its absolute position while the
  // block underneath it moves, so a previously valid position can go stale.
  const recheck = () => validate();
  window.addEventListener('resize', recheck, { passive: true });
  const scrollParent = element.closest('.pane') ?? window;
  scrollParent.addEventListener('scroll', recheck, { passive: true });

  validate();

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', recheck);
    scrollParent.removeEventListener('scroll', recheck);
  };
}
