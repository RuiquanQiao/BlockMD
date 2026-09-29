/**
 * Slash menu — the view layer for plugin-slash.
 *
 * plugin-slash only decides *when* the menu should be visible and where to place it.
 * Rendering, filtering and keyboard navigation are ours to implement.
 *
 * A deliberate constraint: the menu offers only block types that map losslessly onto
 * standard Markdown. No database views, no synced blocks — they have no Markdown
 * representation, and listing them would promise something the format cannot keep.
 */

import { slashFactory, SlashProvider } from '@milkdown/kit/plugin/slash';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import { BLOCK_TYPES, blockAtSelection, insertDivider, turnInto } from './block-types.js';
import { insertMathBlock, insertInlineMath } from './math.js';
import { insertToggle, insertColumns } from './containers.js';
import { openEmojiPicker } from './emoji.js';
import { isImeKey } from './ime.js';
import { size, shift } from '@floating-ui/dom';

export const slash = slashFactory('bmdSlash');

/** Menu entries: every block type, plus the ones with no text to carry: divider, equations. */
const ITEMS = [
  ...BLOCK_TYPES.map((t) => ({ ...t, run: (v) => turnInto(v, blockAtSelection(v.state), t.id) })),
  { id: 'hr', label: 'Divider', hint: '--- rule', keys: ['hr', 'divider', 'rule', 'separator'], run: insertDivider },
  { id: 'toggle', label: 'Toggle list', hint: '<details>', keys: ['toggle', 'details', 'collapse', 'fold'], run: insertToggle },
  { id: 'col2', label: '2 columns', hint: 'side by side', keys: ['columns', 'col', '2', 'two', 'layout', 'side'], run: (v) => insertColumns(v, 2) },
  { id: 'col3', label: '3 columns', hint: 'side by side', keys: ['columns', 'col', '3', 'three', 'layout', 'side'], run: (v) => insertColumns(v, 3) },
  { id: 'emoji', label: 'Emoji', hint: ':smile:', keys: ['emoji', 'smiley', 'icon', 'face'], run: openEmojiPicker },
  { id: 'math', label: 'Block equation', hint: '$$ TeX $$', keys: ['math', 'equation', 'latex', 'tex', 'formula'], run: insertMathBlock },
  { id: 'imath', label: 'Inline equation', hint: '$ TeX $', keys: ['inline', 'equation', 'math', 'latex', 'tex'], run: insertInlineMath },
];

/**
 * @param {any} ctx Milkdown ctx
 * @returns {import('@milkdown/prose/state').PluginSpec<any>}
 */
export function createSlashMenu(ctx) {
  const dom = document.createElement('div');
  dom.className = 'bmd-slash';
  dom.setAttribute('role', 'listbox');
  dom.setAttribute('aria-label', 'Insert block');

  /** @type {HTMLButtonElement[]} */
  let rendered = [];
  let filtered = ITEMS;
  let cursor = 0;

  function render() {
    dom.textContent = '';
    rendered = [];

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bmd-slash-empty';
      empty.textContent = 'No matching block type';
      dom.append(empty);
      return;
    }

    filtered.forEach((item, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'bmd-slash-item' + (i === cursor ? ' is-active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === cursor));

      const label = document.createElement('span');
      label.className = 'bmd-slash-label';
      label.textContent = item.label;

      const hint = document.createElement('span');
      hint.className = 'bmd-slash-hint';
      hint.textContent = item.hint;

      row.append(label, hint);
      // mousedown rather than click: click would let the editor blur first and lose
      // the selection we are about to act on.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(i);
      });
      row.addEventListener('mouseenter', () => {
        cursor = i;
        syncActive();
      });
      dom.append(row);
      rendered.push(row);
    });
  }

  function syncActive() {
    rendered.forEach((node, i) => {
      node.classList.toggle('is-active', i === cursor);
      node.setAttribute('aria-selected', String(i === cursor));
    });
    rendered[cursor]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const item = filtered[i];
    if (!item) return;
    const view = ctx.get(editorViewCtx);
    removeQuery(view);
    item.run(view);
    view.focus();
    provider.hide();
  }

  /** Delete the `/query` text that triggered the menu. */
  function removeQuery(view) {
    const { state, dispatch } = view;
    const { $from } = state.selection;
    const text = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
    const at = text.lastIndexOf('/');
    if (at === -1) return;
    const from = $from.start() + at;
    dispatch(state.tr.delete(from, $from.pos));
  }

  const provider = new SlashProvider({
    content: dom,
    trigger: '/',
    // After the provider's own flip: in a short window neither side has room for the
    // whole menu, so it gets the height there is (it scrolls) and stays on screen.
    middleware: [
      size({ padding: 8, apply({ availableHeight, elements }) { elements.floating.style.maxHeight = `${Math.max(120, Math.min(330, availableHeight))}px`; } }),
      shift({ padding: 8 }),
    ],
    shouldShow(view) {
      const { selection } = view.state;
      if (!(selection instanceof TextSelection) || !selection.empty) return false;
      const $from = selection.$from;
      // A slash inside a code block is ordinary input, not a trigger.
      if ($from.parent.type.spec.code) return false;

      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
      const at = before.lastIndexOf('/');
      if (at === -1) return false;
      // The slash must start a line or follow whitespace, so URLs do not trigger it.
      const prev = at === 0 ? '' : before[at - 1];
      if (prev && !/\s/.test(prev)) return false;

      const query = before.slice(at + 1);
      if (/\s/.test(query)) return false; // typing a space abandons the menu

      const q = query.toLowerCase();
      filtered = q
        ? ITEMS.filter(
            (it) =>
              it.keys.some((k) => k.startsWith(q)) || it.label.toLowerCase().includes(q),
          )
        : ITEMS;
      cursor = 0;
      render();
      return true;
    },
  });

  return {
    view: () => ({
      update: (view, prevState) => provider.update(view, prevState),
      destroy: () => provider.destroy(),
    }),
    props: {
      handleKeyDown: (_view, event) => {
        // SlashProvider only toggles data-show; never swallow keys while hidden.
        if (dom.dataset.show !== 'true') return false;
        if (isImeKey(event)) return false; // confirming a candidate, not choosing an item
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            cursor = (cursor + 1) % Math.max(filtered.length, 1);
            syncActive();
            return true;
          case 'ArrowUp':
            event.preventDefault();
            cursor = (cursor - 1 + filtered.length) % Math.max(filtered.length, 1);
            syncActive();
            return true;
          case 'Enter':
            if (filtered.length === 0) return false;
            event.preventDefault();
            pick(cursor);
            return true;
          case 'Escape':
            event.preventDefault();
            provider.hide();
            return true;
          default:
            return false;
        }
      },
    },
  };
}

