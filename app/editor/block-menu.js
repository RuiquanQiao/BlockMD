/**
 * Block menu — what clicking the drag handle opens, as in Notion.
 *
 *   Turn into ▸   (flyout with every block type, current one checked)
 *   Duplicate     Ctrl+D
 *   Delete        Del
 *
 * The target block is captured when the menu opens. The handle follows the pointer,
 * so on the way from the handle to the menu it may well move to another block —
 * acting on "whatever the handle points at now" would edit the wrong one.
 *
 * Keys are taken with a capture-phase listener on the window rather than by moving
 * focus into the menu: plugin-block refocuses the editor in a requestAnimationFrame
 * after every mouseup on the handle, which would steal focus straight back.
 */

import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import {
  BLOCK_TYPES,
  canConvert,
  currentType,
  deleteBlock,
  duplicateBlock,
  turnInto,
} from './block-types.js';

const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * @param {object} opts
 * @param {() => import('@milkdown/prose/view').EditorView} opts.getView
 */
export function createBlockMenu({ getView }) {
  const menu = panel('Block actions');
  const flyout = panel('Turn into');

  /** @type {import('./block-types.js').Target|null} */
  let target = null;
  /** @type {{el:HTMLElement, run:()=>void, submenu?:boolean, disabled?:boolean}[]} */
  let rows = [];
  let cursor = 0;
  /** @type {{el:HTMLElement, run:()=>void}[]} */
  let subRows = [];
  let subCursor = -1; // -1: keyboard focus is in the main menu

  function panel(label) {
    const el = document.createElement('div');
    el.className = 'bmd-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', label);
    // Keep the editor's selection (the highlighted block) while clicking in the menu.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    return el;
  }

  function row(parent, { label, hint, onRun, submenu, disabled, checked }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'bmd-menu-item';
    el.setAttribute('role', submenu ? 'menuitem' : checked !== undefined ? 'menuitemradio' : 'menuitem');
    if (checked !== undefined) el.setAttribute('aria-checked', String(checked));
    if (submenu) el.setAttribute('aria-haspopup', 'menu');
    if (disabled) {
      el.disabled = true;
      el.classList.add('is-disabled');
    }

    const text = document.createElement('span');
    text.className = 'bmd-menu-label';
    text.textContent = label;
    el.append(text);

    const tail = document.createElement('span');
    tail.className = 'bmd-menu-tail';
    if (hint) tail.textContent = hint;
    if (submenu) tail.innerHTML = CHEVRON;
    if (checked) tail.innerHTML = CHECK;
    el.append(tail);

    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (!disabled) onRun();
    });
    parent.append(el);
    return el;
  }

  function render() {
    const view = getView();
    menu.textContent = '';
    const convertible = canConvert(target);
    rows = [
      { submenu: true, disabled: !convertible, label: 'Turn into', run: () => openFlyout(true) },
      { label: 'Duplicate', hint: IS_MAC ? '⌘D' : 'Ctrl+D', run: () => act(duplicateBlock) },
      { label: 'Delete', hint: 'Del', run: () => act(deleteBlock) },
    ].map((r, i) => {
      const el = row(menu, { ...r, onRun: r.run });
      el.addEventListener('mouseenter', () => {
        cursor = i;
        subCursor = -1;
        sync();
        if (r.submenu && !r.disabled) openFlyout(false);
        else closeFlyout();
      });
      return { ...r, el };
    });

    flyout.textContent = '';
    const current = convertible ? currentType(view.state, target) : null;
    subRows = BLOCK_TYPES.map((t, i) => {
      const el = row(flyout, {
        label: t.label,
        checked: t.id === current,
        onRun: () => act((v, tg) => turnInto(v, tg, t.id)),
      });
      el.addEventListener('mouseenter', () => {
        subCursor = i;
        sync();
      });
      return { el, run: () => act((v, tg) => turnInto(v, tg, t.id)) };
    });
  }

  function sync() {
    rows.forEach((r, i) => r.el.classList.toggle('is-active', i === cursor && subCursor === -1));
    rows[0]?.el.classList.toggle('is-open', flyout.dataset.show === 'true');
    subRows.forEach((r, i) => r.el.classList.toggle('is-active', i === subCursor));
    subRows[subCursor]?.el.scrollIntoView({ block: 'nearest' });
  }

  /** Run a block command against the captured target, if it still exists. */
  function act(command) {
    const view = getView();
    const tg = target;
    close();
    if (!tg || view.state.doc.nodeAt(tg.pos) !== tg.node) return;
    command(view, tg);
    view.focus();
  }

  function place(floating, reference, placement) {
    computePosition(reference, floating, {
      placement,
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(floating.style, { left: `${x}px`, top: `${y}px` }));
  }

  function openFlyout(withKeyboard) {
    if (rows[0]?.disabled) return;
    flyout.dataset.show = 'true';
    place(flyout, rows[0].el, 'right-start');
    if (withKeyboard) subCursor = Math.max(0, subRows.findIndex((r) => r.el.getAttribute('aria-checked') === 'true'));
    sync();
  }

  function closeFlyout() {
    flyout.dataset.show = 'false';
    subCursor = -1;
    sync();
  }

  function onKey(e) {
    const inSub = subCursor !== -1;
    const list = inSub ? subRows : rows;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        if (inSub) subCursor = (subCursor + step + list.length) % list.length;
        else {
          cursor = (cursor + step + list.length) % list.length;
          closeFlyout();
        }
        sync();
        break;
      }
      case 'ArrowRight':
        if (!inSub && rows[cursor]?.submenu) openFlyout(true);
        break;
      case 'ArrowLeft':
        if (inSub) closeFlyout();
        break;
      case 'Enter':
      case ' ':
        if (inSub) subRows[subCursor].run();
        else if (rows[cursor].submenu) openFlyout(true);
        else if (!rows[cursor].disabled) rows[cursor].run();
        break;
      case 'Escape':
        if (inSub) closeFlyout();
        else close(true);
        break;
      case 'Delete':
      case 'Backspace':
        act(deleteBlock);
        break;
      default:
        if ((e.key === 'd' || e.key === 'D') && (IS_MAC ? e.metaKey : e.ctrlKey)) act(duplicateBlock);
        // Swallow plain typing. The whole block is node-selected while the menu is
        // open, so letting a keystroke through would replace the block with it.
        else handled = e.key === 'Tab' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey);
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onPointerDown(e) {
    if (menu.contains(e.target) || flyout.contains(e.target)) return;
    close();
  }

  /**
   * @param {HTMLElement} anchor The grip button
   * @param {import('./block-types.js').Target} block
   */
  function open(anchor, block) {
    const view = getView();
    const host = view.dom.parentElement ?? document.body;
    if (!menu.isConnected) host.append(menu, flyout);
    target = block;
    cursor = 0;
    subCursor = -1;
    render();
    flyout.dataset.show = 'false';
    menu.dataset.show = 'true';
    place(menu, anchor, 'bottom-start');
    sync();
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointerDown, true);
  }

  /** @param {boolean} [refocus] Return keyboard focus to the editor */
  function close(refocus = false) {
    if (menu.dataset.show !== 'true') return;
    menu.dataset.show = 'false';
    flyout.dataset.show = 'false';
    target = null;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onPointerDown, true);
    if (refocus) getView().focus();
  }

  return {
    open,
    close,
    get isOpen() { return menu.dataset.show === 'true'; },
    destroy() {
      close();
      menu.remove();
      flyout.remove();
    },
  };
}
