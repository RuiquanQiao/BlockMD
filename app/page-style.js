/**
 * Page style, as in Notion's "···" menu: font (Default / Serif / Mono), small text,
 * full width.
 *
 * Notion stores these per page; a Markdown file has nowhere to keep them, so here they
 * are an app setting, remembered in this webview's local storage and applied as
 * classes on <html> (styles.css, "Page style"). They change only how text looks, never
 * what is saved.
 */

const KEY = 'bmd.pageStyle';
const DEFAULTS = { font: 'default', small: false, wide: false };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}
function store(style) {
  try { localStorage.setItem(KEY, JSON.stringify(style)); } catch { /* private mode: not remembered */ }
}

function apply(style) {
  const root = document.documentElement;
  root.classList.toggle('style-serif', style.font === 'serif');
  root.classList.toggle('style-mono', style.font === 'mono');
  root.classList.toggle('style-small', style.small);
  root.classList.toggle('style-wide', style.wide);
}

let style = load();

/** Current page style, for the View ▸ Page Style menu. */
export const pageStyle = () => ({ ...style });

/** Change the page style (from the ··· menu or View ▸ Page Style). */
export function setPageStyle(patch) {
  style = { ...style, ...patch };
  store(style);
  apply(style);
}

/** @param {HTMLButtonElement} button The "···" button in the top bar */
export function setUpPageStyle(button) {
  apply(style);

  const menu = document.createElement('div');
  menu.className = 'bmd-menu bmd-style-menu';
  menu.setAttribute('role', 'menu');
  menu.dataset.show = 'false';
  document.body.append(menu);

  function render() {
    menu.innerHTML =
      '<div class="bmd-style-label">Style</div><div class="bmd-style-fonts">' +
      [['default', 'Default', 'Ag'], ['serif', 'Serif', 'Ag'], ['mono', 'Mono', 'Ag']].map(([id, label, sample]) =>
        `<button type="button" class="bmd-style-font${style.font === id ? ' is-active' : ''}" data-font="${id}">` +
        `<span class="bmd-style-sample bmd-sample-${id}">${sample}</span><span>${label}</span></button>`).join('') +
      '</div>' +
      toggle('small', 'Small text') + toggle('wide', 'Full width');
  }
  const toggle = (id, label) =>
    `<button type="button" class="bmd-menu-item bmd-style-toggle" role="menuitemcheckbox" aria-checked="${style[id]}" data-toggle="${id}">` +
    `<span>${label}</span><span class="bmd-switch${style[id] ? ' is-on' : ''}"></span></button>`;

  function set(patch) {
    setPageStyle(patch);
    render();
  }

  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.font) set({ font: b.dataset.font });
    if (b.dataset.toggle) set({ [b.dataset.toggle]: !style[b.dataset.toggle] });
  });

  const close = () => { menu.dataset.show = 'false'; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => {
    if (menu.dataset.show === 'true') { close(); return; }
    render();
    const r = button.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, r.right - 260)}px`;
    menu.dataset.show = 'true';
    button.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('mousedown', (e) => {
    if (menu.dataset.show === 'true' && !menu.contains(e.target) && !button.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.dataset.show === 'true') close(); });
}
