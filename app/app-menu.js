/**
 * The app menu: File / Edit / View / Help behind the BlockMD icon, the way Notion's
 * desktop app does it (a compact card with fly-out submenus) rather than a Windows
 * menu bar. Every item shows its shortcut; the shortcuts themselves are handled in
 * main.js and work without opening the menu.
 *
 * How it should feel (checked by parity/feel.json):
 * - Every row lights up the moment the pointer is on it (CSS :hover), keyboard focus
 *   the same way (:focus-visible).
 * - A section's submenu switches as soon as the pointer reaches another section —
 *   except while the pointer is heading into the open submenu ("menu aim", as in
 *   macOS and Notion). A fixed delay on every switch (0.1.6) made the whole menu lag.
 * - Arrow keys, Enter, Home/End and Esc work at every level.
 */

import iconUrl from '../src-tauri/icons/64x64.png';
import { isImeKey } from './editor/ime.js';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const key = (s) => s.replace(/Mod\+/g, MOD).replace(/Shift\+/g, IS_MAC ? '⇧' : 'Shift+');

/** How long a pointer heading for the open submenu may take before we give up on it. */
const AIM_MS = 300;

/**
 * @typedef {{label: string, shortcut?: string, run?: () => void, submenu?: () => Item[], disabled?: boolean, checked?: boolean} | 'sep'} Item
 * @param {HTMLButtonElement} button
 * @param {Record<string, () => Item[]>} sections File / Edit / View / Help → items
 */
export function setUpAppMenu(button, sections) {
  button.innerHTML = `<img src="${iconUrl}" alt="" width="20" height="20">`;

  const root = panel('bmd-app-menu', 'BlockMD menu');
  const fly = panel('bmd-app-sub', '');
  const deep = panel('bmd-app-sub bmd-app-deep', ''); // a third level: Open Recent ▸, Page Style ▸
  const levels = [root, fly, deep];
  let returnFocus = null;

  function panel(cls, label) {
    const el = document.createElement('div');
    el.className = `bmd-menu ${cls}`;
    el.setAttribute('role', 'menu');
    if (label) el.setAttribute('aria-label', label);
    el.dataset.show = 'false';
    // Clicking a row must not take focus from the editor (Undo, Copy as Markdown… act on it).
    el.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(el);
    return el;
  }

  function row(item, { parent = false } = {}) {
    if (item === 'sep') {
      const hr = document.createElement('div');
      hr.className = 'bmd-app-sep';
      hr.setAttribute('role', 'separator');
      return hr;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bmd-menu-item bmd-app-item';
    b.tabIndex = -1;
    b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
    if (parent || item.submenu) b.setAttribute('aria-haspopup', 'menu');
    b.disabled = Boolean(item.disabled);
    const check = item.checked === undefined ? '' : `<span class="bmd-app-check">${item.checked ? '✓' : ''}</span>`;
    const tail = parent || item.submenu ? '<span class="bmd-app-arrow">›</span>' : item.shortcut ? `<span class="bmd-app-key">${key(item.shortcut)}</span>` : '';
    b.innerHTML = `${check}<span class="bmd-app-label"></span>${tail}`;
    b.querySelector('.bmd-app-label').textContent = item.label;
    // Keyboard and pointer share one highlight: pointing at a row moves keyboard focus.
    onPoint(b, () => { if (levelOf(document.activeElement)) b.focus({ preventScroll: true }); });
    if (item.shortcut) b.setAttribute('aria-keyshortcuts', item.shortcut.replace(/Mod\+/g, IS_MAC ? 'Meta+' : 'Control+'));
    return b;
  }

  /* ——— Menu aim ———
   * The last few pointer positions tell where the pointer is heading. If it is inside
   * the triangle from where it was to the near edge of the open submenu, it is on its
   * way there, crossing other rows: don't switch yet. Otherwise switch at once. */
  const trail = [];
  let moved = false; // did the latest pointermove actually move?
  let lastMove = 0;
  document.addEventListener('pointermove', (e) => {
    const prev = trail[trail.length - 1];
    moved = !prev || prev.x !== e.clientX || prev.y !== e.clientY;
    if (!moved) return;
    lastMove = performance.now();
    if (root.dataset.show !== 'true') { trail.length = 0; trail.push({ x: e.clientX, y: e.clientY }); return; }
    trail.push({ x: e.clientX, y: e.clientY });
    if (trail.length > 12) trail.shift();
  }, true);

  /**
   * Run `fn` when the pointer moves onto `el`. Not mouseenter: that also fires when a
   * submenu opens under a pointer that is standing still (opened from the keyboard,
   * say), and would pull the highlight away from the row the keyboard chose.
   */
  function onPoint(el, fn) {
    let inside = false;
    el.addEventListener('pointermove', () => { if (inside || !moved) return; inside = true; fn(); });
    el.addEventListener('pointerleave', () => { inside = false; });
  }

  function aimingAt(sub) {
    if (sub.dataset.show !== 'true' || trail.length < 2) return false;
    // Direction over the last few pixels of travel — not a fixed number of events back,
    // which (after moving up to File, then cutting diagonally) still pointed upward.
    const now = trail[trail.length - 1];
    const before = trail.slice(0, -1).reverse().find((p) => Math.hypot(now.x - p.x, now.y - p.y) >= 6) ?? trail[0];
    const r = sub.getBoundingClientRect();
    // The submenu opens to the right; its left edge is the target.
    const top = { x: r.left, y: r.top - 20 }, bottom = { x: r.left, y: r.bottom + 20 };
    if (now.x <= before.x) return false; // not moving right
    const slope = (a, b) => (b.y - a.y) / (b.x - a.x);
    return slope(now, top) < slope(before, top) && slope(now, bottom) > slope(before, bottom);
  }

  let pending = null;
  const cancel = () => { clearTimeout(pending); pending = null; };
  /** Switch now, or — while the pointer heads into `sub` — once it stops heading there. */
  function aimOr(sub, fn) {
    cancel();
    if (!aimingAt(sub)) { fn(); return; }
    pending = setTimeout(() => { pending = null; if (!aimingAt(sub) || stillSince(AIM_MS)) fn(); else aimOr(sub, fn); }, AIM_MS);
  }
  const stillSince = (ms) => performance.now() - lastMove >= ms - 20;

  /* ——— Panels ——— */

  function place(el, anchor) {
    const a = anchor.getBoundingClientRect();
    el.dataset.show = 'true';
    const w = el.offsetWidth, h = el.offsetHeight;
    // Right of the anchor, or left of it when there is no room (narrow window).
    const x = a.right + 4 + w <= window.innerWidth - 8 ? a.right + 4 : Math.max(8, a.left - 4 - w);
    el.style.left = `${x}px`;
    el.style.top = `${Math.max(8, Math.min(a.top - 6, window.innerHeight - h - 8))}px`;
  }

  function fill(el, items, onRow) {
    el.textContent = '';
    for (const item of items) {
      const r = row(item);
      if (item !== 'sep') onRow(r, item);
      el.append(r);
    }
  }

  function showSub(anchor, items, { focus = false } = {}) {
    cancel();
    closeNested();
    fill(fly, items, (r, item) => {
      if (item.submenu) {
        onPoint(r, () => aimOr(deep, () => nested(r, item.submenu())));
        r.addEventListener('click', () => nested(r, item.submenu(), { focus: true }));
      } else {
        onPoint(r, () => { if (deep.dataset.show === 'true') aimOr(deep, closeNested); });
        r.addEventListener('click', () => activate(item));
      }
    });
    place(fly, anchor);
    [...root.children].forEach((c) => c.classList.toggle('is-open', c === anchor));
    anchor.setAttribute('aria-expanded', 'true');
    if (focus) first(fly)?.focus();
  }

  function nested(anchor, items, { focus = false } = {}) {
    cancel();
    fill(deep, items, (r, item) => r.addEventListener('click', () => activate(item)));
    place(deep, anchor);
    [...fly.children].forEach((c) => c.classList.toggle('is-open', c === anchor));
    if (focus) first(deep)?.focus();
  }
  function closeNested() {
    deep.dataset.show = 'false';
    [...fly.children].forEach((c) => c.classList.remove('is-open'));
  }
  function closeSub() {
    closeNested();
    fly.dataset.show = 'false';
    [...root.children].forEach((c) => { c.classList.remove('is-open'); c.removeAttribute('aria-expanded'); });
  }

  function open({ focus = false } = {}) {
    returnFocus = document.activeElement;
    root.textContent = '';
    trail.length = 0;
    for (const name of Object.keys(sections)) {
      const r = row({ label: name }, { parent: true });
      r.dataset.section = name;
      const show = (opts) => showSub(r, sections[name](), opts);
      onPoint(r, () => { if (!r.classList.contains('is-open')) aimOr(fly, show); });
      r.addEventListener('click', () => show({ focus: true }));
      root.append(r);
    }
    const b = button.getBoundingClientRect();
    root.style.left = `${b.left}px`;
    root.style.top = `${b.bottom + 6}px`;
    root.dataset.show = 'true';
    button.setAttribute('aria-expanded', 'true');
    if (focus) first(root)?.focus();
  }

  function close({ restore = true } = {}) {
    cancel();
    for (const l of levels) l.dataset.show = 'false';
    button.setAttribute('aria-expanded', 'false');
    // Back to wherever the user was (the editor), so the command acts there.
    if (restore && levels.some((l) => l.contains(document.activeElement))) returnFocus?.focus?.();
  }

  function activate(item) {
    close();
    item.run?.();
  }

  /* ——— Keyboard ——— */

  const rows = (el) => [...el.querySelectorAll('.bmd-app-item')].filter((b) => !b.disabled);
  const first = (el) => rows(el)[0];
  const levelOf = (el) => levels.find((l) => l.contains(el));

  // Window capture: ahead of the editor's own keys and of find.js / block-menu.js.
  window.addEventListener('keydown', (e) => {
    if (root.dataset.show !== 'true' || isImeKey(e)) return;
    const at = document.activeElement;
    const level = levelOf(at);
    // Keys arriving while the pointer drives the menu (focus still in the editor) start
    // from the deepest open level's highlighted row.
    const current = level ?? [deep, fly, root].find((l) => l.dataset.show === 'true');
    const list = rows(current);
    const hot = list.indexOf(at) >= 0 ? at : list.find((b) => b.matches(':hover'));
    const i = hot ? list.indexOf(hot) : e.key === 'ArrowUp' ? 0 : -1;
    const go = (el) => { e.preventDefault(); e.stopPropagation(); el?.focus(); };
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        close();
        if (!returnFocus || returnFocus === document.body) button.focus();
        return;
      case 'ArrowDown': return go(list[(i + 1) % list.length]);
      case 'ArrowUp': return go(list[(i - 1 + list.length) % list.length]);
      case 'Home': return go(list[0]);
      case 'End': return go(list[list.length - 1]);
      case 'ArrowRight':
        if (hot?.getAttribute('aria-haspopup') === 'menu') { e.preventDefault(); e.stopPropagation(); hot.click(); }
        return;
      case 'Enter': case ' ':
        // Handled here for focused and merely hovered rows alike (and never twice: the
        // native Enter-clicks-a-button is prevented).
        if (hot) { e.preventDefault(); e.stopPropagation(); hot.click(); }
        return;
      case 'ArrowLeft':
        if (current === deep) { const back = fly.querySelector('.is-open'); closeNested(); return go(back); }
        if (current === fly) { const back = root.querySelector('.is-open'); closeSub(); return go(back); }
        return;
      case 'Tab':
        e.preventDefault(); close();
    }
  }, true);

  // Reaching the open submenu keeps it: drop any pending switch.
  fly.addEventListener('mouseenter', cancel);
  deep.addEventListener('mouseenter', cancel);

  // A click from the keyboard (Enter / Space on the focused icon) has detail 0.
  button.addEventListener('click', (e) => (root.dataset.show === 'true' ? close() : open({ focus: e.detail === 0 })));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && root.dataset.show !== 'true') { e.preventDefault(); open({ focus: true }); }
  });
  // F10, or Alt pressed and released on its own: the Windows way into an app's menu.
  let altAlone = false;
  window.addEventListener('keydown', (e) => {
    altAlone = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (root.dataset.show === 'true') close(); else open({ focus: true });
    }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altAlone) return;
    altAlone = false;
    e.preventDefault();
    if (root.dataset.show === 'true') close(); else open({ focus: true });
  }, true);
  window.addEventListener('mousedown', () => { altAlone = false; }, true);
  window.addEventListener('blur', () => { altAlone = false; });

  document.addEventListener('mousedown', (e) => {
    if (root.dataset.show !== 'true') return;
    if (!levels.concat(button).some((el) => el.contains(e.target))) close({ restore: false });
  });
  return { close };
}
