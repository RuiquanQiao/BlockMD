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

export const slash = slashFactory('bmdSlash');

/** Menu entries. Every one of these is expressible in standard Markdown. */
const ITEMS = [
  { id: 'text', label: 'Text', hint: 'Plain paragraph', keys: ['text', 'p', 'paragraph', 'plain'], run: setParagraph },
  { id: 'h1', label: 'Heading 1', hint: '# Heading', keys: ['h1', 'heading1', 'title'], run: (v) => setHeading(v, 1) },
  { id: 'h2', label: 'Heading 2', hint: '## Heading', keys: ['h2', 'heading2'], run: (v) => setHeading(v, 2) },
  { id: 'h3', label: 'Heading 3', hint: '### Heading', keys: ['h3', 'heading3'], run: (v) => setHeading(v, 3) },
  { id: 'ul', label: 'Bulleted list', hint: '- item', keys: ['ul', 'list', 'bullet', 'unordered'], run: (v) => wrapList(v, 'bullet_list') },
  { id: 'ol', label: 'Numbered list', hint: '1. item', keys: ['ol', 'ordered', 'number'], run: (v) => wrapList(v, 'ordered_list') },
  { id: 'todo', label: 'Task list', hint: '- [ ] task', keys: ['todo', 'task', 'check', 'checkbox'], run: (v) => wrapList(v, 'bullet_list', true) },
  { id: 'quote', label: 'Quote', hint: '> quoted text', keys: ['quote', 'blockquote', 'cite'], run: wrapQuote },
  { id: 'code', label: 'Code block', hint: '``` fenced code', keys: ['code', 'pre', 'fence'], run: setCodeBlock },
  { id: 'hr', label: 'Divider', hint: '--- rule', keys: ['hr', 'divider', 'rule', 'separator'], run: insertHr },
];

let activeProvider = null;

/** Used by the add button: open the menu right after inserting a block. */
export function openSlashMenuAt() {
  if (activeProvider) activeProvider.show();
}

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

  activeProvider = provider;

  return {
    view: () => ({
      update: (view, prevState) => provider.update(view, prevState),
      destroy: () => {
        provider.destroy();
        if (activeProvider === provider) activeProvider = null;
      },
    }),
    props: {
      handleKeyDown: (_view, event) => {
        // SlashProvider only toggles data-show; never swallow keys while hidden.
        if (dom.dataset.show !== 'true') return false;
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

// ——— Commands behind each menu entry ———

function setParagraph(view) {
  const { state, dispatch } = view;
  const { $from } = state.selection;
  dispatch(state.tr.setBlockType($from.before(), $from.after(), state.schema.nodes.paragraph));
}

function setHeading(view, level) {
  const { state, dispatch } = view;
  const { $from } = state.selection;
  dispatch(state.tr.setBlockType($from.before(), $from.after(), state.schema.nodes.heading, { level }));
}

function setCodeBlock(view) {
  const { state, dispatch } = view;
  const { $from } = state.selection;
  dispatch(state.tr.setBlockType($from.before(), $from.after(), state.schema.nodes.code_block));
}

function wrapList(view, typeName, checked = false) {
  const { state, dispatch } = view;
  const listType = state.schema.nodes[typeName];
  const itemType = state.schema.nodes.list_item;
  if (!listType || !itemType) return;
  const { $from } = state.selection;
  const content = $from.parent.content;
  const attrs =
    checked && itemType.spec.attrs && 'checked' in itemType.spec.attrs ? { checked: false } : null;
  const item = itemType.create(attrs, state.schema.nodes.paragraph.create(null, content));
  const list = listType.create(null, item);
  dispatch(state.tr.replaceWith($from.before(), $from.after(), list).scrollIntoView());
}

function wrapQuote(view) {
  const { state, dispatch } = view;
  const quote = state.schema.nodes.blockquote;
  if (!quote) return;
  const { $from } = state.selection;
  const node = quote.create(null, $from.parent.copy($from.parent.content));
  dispatch(state.tr.replaceWith($from.before(), $from.after(), node).scrollIntoView());
}

function insertHr(view) {
  const { state, dispatch } = view;
  const hr = state.schema.nodes.hr ?? state.schema.nodes.horizontal_rule;
  if (!hr) return;
  const { $from } = state.selection;
  dispatch(state.tr.replaceWith($from.before(), $from.after(), hr.create()).scrollIntoView());
}
