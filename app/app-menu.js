/**
 * The app menu: File / Edit / View / Help behind the BlockMD icon, the way Notion's
 * desktop app does it (a compact card with fly-out submenus) rather than a Windows
 * menu bar. Every item shows its shortcut; the shortcuts themselves are handled in
 * main.js and work without opening the menu.
 */

import iconUrl from '../src-tauri/icons/64x64.png';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const key = (s) => s.replace(/Mod\+/g, MOD).replace(/Shift\+/g, IS_MAC ? '⇧' : 'Shift+');

/**
 * @typedef {{label: string, shortcut?: string, run?: () => void, submenu?: () => Item[], disabled?: boolean, checked?: boolean} | 'sep'} Item
 * @param {HTMLButtonElement} button
 * @param {Record<string, () => Item[]>} sections File / Edit / View / Help → items
 */
export function setUpAppMenu(button, sections) {
  button.innerHTML = `<img src="${iconUrl}" alt="" width="20" height="20">`;

  const root = panel('bmd-app-menu', 'BlockMD menu');
  const fly = panel('bmd-app-sub', '');

  function panel(cls, label) {
    const el = document.createElement('div');
    el.className = `bmd-menu ${cls}`;
    el.setAttribute('role', 'menu');
    if (label) el.setAttribute('aria-label', label);
    el.dataset.show = 'false';
    el.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(el);
    return el;
  }

  function row(item, { parent = false } = {}) {
    if (item === 'sep') {
      const hr = document.createElement('div');
      hr.className = 'bmd-app-sep';
      return hr;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bmd-menu-item bmd-app-item';
    b.setAttribute('role', 'menuitem');
    b.disabled = Boolean(item.disabled);
    const check = item.checked === undefined ? '' : `<span class="bmd-app-check">${item.checked ? '✓' : ''}</span>`;
    const tail = parent || item.submenu ? '<span class="bmd-app-arrow">›</span>' : item.shortcut ? `<span class="bmd-app-key">${key(item.shortcut)}</span>` : '';
    b.innerHTML = `${check}<span class="bmd-app-label"></span>${tail}`;
    b.querySelector('.bmd-app-label').textContent = item.label;
    return b;
  }

  // Hover intent. Moving diagonally from a section to its submenu crosses the other
  // sections (and, one level down, the other items); switching on every mouseenter
  // swapped the menu away before the pointer arrived. While a submenu is open, a hover
  // elsewhere switches only if the pointer rests there; entering the open submenu
  // cancels the switch. Clicks always switch at once.
  const INTENT_MS = 220;
  let pending = null;
  const later = (fn) => { clearTimeout(pending); pending = setTimeout(fn, INTENT_MS); };
  const cancel = () => clearTimeout(pending);

  function showSub(anchor, items) {
    cancel();
    fly.textContent = '';
    for (const item of items) {
      const r = row(item);
      if (item !== 'sep') {
        if (item.submenu) {
          r.addEventListener('mouseenter', () => (deep.dataset.show === 'true' ? later : (f) => f())(() => nested(r, item.submenu())));
        } else {
          r.addEventListener('mouseenter', () => (deep.dataset.show === 'true' ? later(closeNested) : undefined));
          r.addEventListener('click', () => { close(); item.run?.(); });
        }
      }
      fly.append(r);
    }
    const a = anchor.getBoundingClientRect();
    fly.dataset.show = 'true';
    fly.style.left = `${a.right + 4}px`;
    fly.style.top = `${Math.min(a.top - 6, window.innerHeight - fly.offsetHeight - 8)}px`;
    [...root.children].forEach((c) => c.classList.toggle('is-open', c === anchor));
  }

  // A third level (Open Recent ▸, Page Style ▸).
  const deep = panel('bmd-app-sub bmd-app-deep', '');
  function nested(anchor, items) {
    deep.textContent = '';
    for (const item of items) {
      const r = row(item);
      if (item !== 'sep') r.addEventListener('click', () => { close(); item.run?.(); });
      deep.append(r);
    }
    const a = anchor.getBoundingClientRect();
    cancel();
    deep.dataset.show = 'true';
    deep.style.left = `${a.right + 4}px`;
    deep.style.top = `${Math.min(a.top - 6, window.innerHeight - deep.offsetHeight - 8)}px`;
  }
  function closeNested() { deep.dataset.show = 'false'; }

  function open() {
    root.textContent = '';
    for (const name of Object.keys(sections)) {
      const r = row({ label: name }, { parent: true });
      r.dataset.section = name;
      const show = () => { closeNested(); showSub(r, sections[name]()); };
      r.addEventListener('mouseenter', () => (fly.dataset.show === 'true' && !r.classList.contains('is-open') ? later(show) : show()));
      r.addEventListener('click', show);
      root.append(r);
    }
    const b = button.getBoundingClientRect();
    root.style.left = `${b.left}px`;
    root.style.top = `${b.bottom + 6}px`;
    root.dataset.show = 'true';
    button.setAttribute('aria-expanded', 'true');
  }

  function close() {
    cancel();
    root.dataset.show = fly.dataset.show = deep.dataset.show = 'false';
    button.setAttribute('aria-expanded', 'false');
  }

  // Reaching the open submenu (or the level below) keeps it: drop any pending switch.
  fly.addEventListener('mouseenter', cancel);
  deep.addEventListener('mouseenter', cancel);

  button.addEventListener('click', () => (root.dataset.show === 'true' ? close() : open()));
  document.addEventListener('mousedown', (e) => {
    if (root.dataset.show !== 'true') return;
    if (![root, fly, deep, button].some((el) => el.contains(e.target))) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.dataset.show === 'true') close(); }, true);
  return { close };
}
