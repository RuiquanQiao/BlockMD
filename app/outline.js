/**
 * The page outline, as in Notion: a dash per heading at the right edge of the page —
 * longer for H1, shorter for H3, black for the section you're reading, grey for the
 * rest. Hovering (or focusing) it opens a card listing the headings; clicking one
 * scrolls to it.
 *
 * Notion's rules (notion.com/help/columns-headings-and-dividers): shown once a page has
 * two or more headings; H1–H3 only, H2 and H3 indented; headings nested inside other
 * blocks are left out; switched off from the ··· menu ("Table of contents", a page
 * style here). One addition: hidden when there is no room beside the text (narrow
 * window, full width), rather than covering it.
 *
 * Pure view: it reads the editor's document and never changes it or the file.
 */

import { pageStyle } from './page-style.js';

/** Room the dashes need between the text and the window edge. */
const ROOM = 64;

/**
 * @param {{ pane: HTMLElement, getView: () => import('@milkdown/prose/view').EditorView | undefined }} opts
 *   pane: the scrolling editor pane
 */
export function setUpOutline({ pane, getView }) {
  const nav = document.createElement('nav');
  nav.className = 'bmd-outline';
  nav.setAttribute('aria-label', 'Table of contents');
  nav.hidden = true;
  nav.innerHTML = '<div class="bmd-outline-dashes" tabindex="0" aria-label="Table of contents"></div><div class="bmd-outline-card" role="list"></div>';
  document.body.append(nav);
  const dashes = nav.querySelector('.bmd-outline-dashes');
  const card = nav.querySelector('.bmd-outline-card');

  /** @type {{pos: number, level: number, text: string}[]} */
  let headings = [];
  let signature = '';
  let active = -1;

  function read(view) {
    const out = [];
    // Top level only: Notion leaves out headings nested in other blocks.
    view.state.doc.forEach((node, pos) => {
      if (node.type.name === 'heading' && node.attrs.level <= 3) out.push({ pos, level: node.attrs.level, text: node.textContent.trim() });
    });
    return out;
  }

  function render() {
    dashes.textContent = '';
    card.textContent = '';
    headings.forEach((h, i) => {
      const d = document.createElement('div');
      d.className = `bmd-outline-dash bmd-outline-h${h.level}`;
      dashes.append(d);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `bmd-outline-item bmd-outline-h${h.level}`;
      b.setAttribute('role', 'listitem');
      b.textContent = h.text || 'Untitled';
      if (!h.text) b.classList.add('is-empty');
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret where it is
      b.addEventListener('click', () => go(i));
      card.append(b);
    });
    active = -1;
  }

  /** The DOM of heading i (its position can shift as the document changes). */
  const domOf = (view, i) => view.nodeDOM(headings[i].pos);

  /** The section you're reading: the last heading at or above the top quarter of the pane. */
  function findActive(view) {
    const line = pane.getBoundingClientRect().top + Math.min(120, pane.clientHeight / 4);
    let lo = 0, hi = headings.length - 1, found = 0;
    while (lo <= hi) { // headings are in document order, so their tops increase
      const mid = (lo + hi) >> 1;
      const top = domOf(view, mid)?.getBoundingClientRect().top ?? Infinity;
      if (top <= line) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  function mark(view) {
    const i = findActive(view);
    if (i === active) return;
    active = i;
    [...dashes.children].forEach((d, k) => d.classList.toggle('is-active', k === i));
    [...card.children].forEach((b, k) => { b.classList.toggle('is-active', k === i); b.toggleAttribute('aria-current', k === i); });
    // Long outlines: keep the current dash in view.
    const dash = dashes.children[i];
    if (dash && dashes.scrollHeight > dashes.clientHeight) dashes.scrollTop = dash.offsetTop - dashes.clientHeight / 2;
  }

  function place() {
    const p = pane.getBoundingClientRect();
    const text = getView()?.dom.getBoundingClientRect();
    const room = text ? p.right - text.right : 0;
    const fits = room >= ROOM;
    nav.classList.toggle('no-room', !fits);
    nav.style.right = `${Math.max(0, window.innerWidth - p.right) + 18}px`;
    nav.style.top = `${p.top + 72}px`;
    nav.style.maxHeight = `${Math.max(80, p.bottom - p.top - 120)}px`;
    // The card lists every heading: as tall as the window allows (it scrolls past that),
    // not as tall as the column of dashes.
    card.style.maxHeight = `${Math.max(120, p.bottom - (p.top + 72) - 24)}px`;
    return fits;
  }

  /** After any change to the document, the layout or the page style. */
  function update() {
    const view = getView();
    const on = pageStyle().toc !== false;
    const next = view && on ? read(view) : [];
    const sig = next.map((h) => `${h.level}${h.text}`).join('\n');
    headings = next;
    if (sig !== signature) { signature = sig; render(); }
    const show = headings.length >= 2 && place();
    nav.hidden = !show;
    if (show) { active = -1; mark(view); } else close();
  }

  function go(i) {
    const view = getView();
    const dom = view && domOf(view, i);
    if (!dom) return;
    const top = dom.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 24;
    pane.scrollTo({ top, behavior: 'smooth' });
    dom.classList.remove('bmd-outline-flash');
    void dom.offsetWidth; // restart the animation
    dom.classList.add('bmd-outline-flash');
    setTimeout(() => dom.classList.remove('bmd-outline-flash'), 1200);
  }

  /* ——— Open and close the card ——— */
  let closeTimer = null;
  function open() { clearTimeout(closeTimer); nav.classList.add('is-open'); }
  function close() { clearTimeout(closeTimer); nav.classList.remove('is-open'); }
  nav.addEventListener('pointerenter', open);
  // A short grace period, so a pointer that slips off the edge doesn't snap it shut.
  // (Not while the keyboard is in it: moving the mouse shouldn't pull the list from under it.)
  nav.addEventListener('pointerleave', () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!nav.contains(document.activeElement)) close(); }, 150);
  });
  nav.addEventListener('focusin', open);
  nav.addEventListener('focusout', (e) => { if (!nav.contains(e.relatedTarget)) close(); });
  nav.addEventListener('keydown', (e) => {
    const items = [...card.children];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); getView()?.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && at < 0 && document.activeElement === dashes) {
      e.preventDefault(); items[Math.max(0, active)]?.focus();
    }
  });

  /* ——— Keep it current ——— */
  let frame = 0;
  pane.addEventListener('scroll', () => {
    if (nav.hidden || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; const v = getView(); if (v) mark(v); });
  }, { passive: true });
  window.addEventListener('resize', update);
  window.addEventListener('bmd-page-style', update);
  new ResizeObserver(update).observe(pane);

  return { update };
}
