/**
 * Equations: KaTeX rendering for `$…$` (math_inline) and `$$…$$` (math_block), and a
 * small editor for their TeX.
 *
 * The nodes are atoms defined in src/milkdown-adapter.js; this file only draws them.
 * Clicking one opens the editor under it, with a live preview. Enter saves an inline
 * equation, Ctrl+Enter a block one (Enter adds a line there), Escape cancels, and
 * saving an empty equation removes it. Only that one node changes, so only its block
 * is re-serialized.
 */

import katex from 'katex';
import 'katex/dist/katex.min.css';
import { $prose, $inputRule } from '@milkdown/kit/utils';
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@milkdown/prose/state';
import { InputRule } from '@milkdown/prose/inputrules';
import { isImeKey } from './ime.js';

function render(el, value, displayMode) {
  if (!value.trim()) {
    el.textContent = displayMode ? 'Empty equation — click to edit' : 'Empty';
    el.classList.add('bmd-math-empty');
    return;
  }
  el.classList.remove('bmd-math-empty');
  katex.render(value, el, { displayMode, throwOnError: false, output: 'html' });
}

/**
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {number} pos Position of the math node
 */
export function openMathEditor(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !/^math_/.test(node.type.name)) return;
  const block = node.type.name === 'math_block';
  document.querySelector('.bmd-math-editor')?.remove();

  const box = document.createElement('div');
  box.className = 'bmd-math-editor';
  const input = document.createElement('textarea');
  input.value = node.attrs.value;
  input.rows = block ? 3 : 1;
  input.spellcheck = false;
  input.placeholder = block ? 'TeX, e.g. a^2 + b^2 = c^2' : 'TeX, e.g. E=mc^2';
  const preview = document.createElement('div');
  preview.className = 'bmd-math-preview';
  const hint = document.createElement('div');
  hint.className = 'bmd-math-hint';
  hint.textContent = block ? 'Ctrl+Enter to save · Esc to cancel' : 'Enter to save · Esc to cancel';
  box.append(input, preview, hint);
  document.body.append(box);

  const r = (view.nodeDOM(pos) ?? view.dom).getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 420))}px`;
  box.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 180)}px`;
  const update = () => render(preview, input.value, block);
  update();

  let done = false;
  function close(save) {
    if (done) return;
    done = true;
    box.remove();
    const current = view.state.doc.nodeAt(pos);
    if (save && current?.type === node.type) {
      const value = input.value.trim();
      const tr = value
        ? view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, value })
        : view.state.tr.delete(pos, pos + current.nodeSize);
      const after = value ? pos + current.nodeSize : pos;
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size))));
      view.dispatch(tr);
    }
    view.focus();
  }
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (isImeKey(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    if (e.key === 'Enter' && (!block || e.ctrlKey || e.metaKey)) { e.preventDefault(); close(true); }
  });
  input.addEventListener('blur', () => setTimeout(() => close(true), 0));
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

class MathView {
  constructor(node, view, getPos) {
    this.node = node;
    this.block = node.type.name === 'math_block';
    this.dom = document.createElement(this.block ? 'div' : 'span');
    this.dom.className = this.block ? 'bmd-math bmd-math-block' : 'bmd-math bmd-math-inline';
    this.dom.dataset.bmd = this.block ? 'math-block' : 'math-inline';
    this.dom.contentEditable = 'false';
    // Open on click, not mousedown: the mouseup that follows a mousedown would hand
    // focus back to the editor, blurring the just-opened input and closing it again.
    this.dom.addEventListener('mousedown', (e) => e.preventDefault());
    this.dom.addEventListener('click', () => {
      const pos = getPos();
      if (pos != null) openMathEditor(view, pos);
    });
    this.draw();
  }

  draw() {
    this.dom.dataset.value = this.node.attrs.value;
    render(this.dom, this.node.attrs.value, this.block);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.value !== this.node.attrs.value;
    this.node = node;
    if (changed) this.draw();
    return true;
  }

  stopEvent(e) { return e.type === 'mousedown' || e.type === 'click' || e.type === 'mouseup'; }
  ignoreMutation() { return true; }
}

/** Replace the current (empty or `/`-only) block with an empty block equation, and edit it. */
export function insertMathBlock(view) {
  const { state } = view;
  const { $from } = state.selection;
  const node = state.schema.nodes.math_block.create({ value: '' });
  const from = $from.before();
  const tr = $from.parent.textContent.trim() === ''
    ? state.tr.replaceWith(from, $from.after(), node)
    : state.tr.insert($from.after(), node);
  const at = $from.parent.textContent.trim() === '' ? from : tr.mapping.map($from.after()) - node.nodeSize;
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at)));
  openMathEditor(view, at);
}

/** Insert an empty inline equation at the cursor, and edit it. */
export function insertInlineMath(view) {
  const { state } = view;
  const at = state.selection.from;
  view.dispatch(state.tr.replaceSelectionWith(state.schema.nodes.math_inline.create({ value: '' })));
  openMathEditor(view, at);
}

export const mathViewsPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('bmdMath'),
      props: {
        nodeViews: {
          math_inline: (node, view, getPos) => new MathView(node, view, getPos),
          math_block: (node, view, getPos) => new MathView(node, view, getPos),
        },
      },
    }),
);

/**
 * `$E=mc^2$` typed out becomes an inline equation. The TeX must not start or end
 * with a space — the same rule Pandoc and GitHub use, so prices like "$5 and $10"
 * stay text while you type them.
 */
const inlineRule = $inputRule(
  () =>
    new InputRule(/(^|[^$\\])\$([^\s$](?:[^$]*[^\s$])?)\$$/, (state, match, start, end) => {
      const lead = match[1].length;
      return state.tr.replaceWith(start + lead, end, state.schema.nodes.math_inline.create({ value: match[2] }));
    }),
);

/** `$$` then space on an empty line starts a block equation. */
const blockRule = $inputRule(
  () =>
    new InputRule(/^\$\$\s$/, (state, _match, start) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type.name !== 'paragraph' || $start.depth !== 1) return null;
      const node = state.schema.nodes.math_block.create({ value: '' });
      const tr = state.tr.replaceWith($start.before(), $start.after(), node);
      tr.setSelection(NodeSelection.create(tr.doc, $start.before()));
      tr.setMeta('bmdEditMath', $start.before());
      return tr;
    }),
);

/** Open the editor for a block equation just created by `$$ `. */
const openKey = new PluginKey('bmdMathOpen');
const openAfterRule = $prose(
  () =>
    new Plugin({
      key: openKey,
      state: { init: () => null, apply: (tr) => tr.getMeta('bmdEditMath') ?? null },
      view: () => ({
        update(view) {
          const pos = openKey.getState(view.state);
          if (pos != null) requestAnimationFrame(() => openMathEditor(view, pos));
        },
      }),
    }),
);

export const mathPlugins = [mathViewsPlugin, inlineRule, blockRule, openAfterRule];
