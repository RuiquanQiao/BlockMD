/**
 * Link editor: a small input under the selection, opened by Ctrl+K or the toolbar.
 * Enter applies the link, an empty value removes it, Escape or clicking away cancels.
 */

import { TextSelection } from '@milkdown/prose/state';
import { isImeKey } from './ime.js';

let open = null;

/**
 * @param {import('@milkdown/prose/view').EditorView} view
 * @returns {boolean} false when there is no text selected to link
 */
export function openLinkEditor(view) {
  const { from, to, empty } = view.state.selection;
  if (empty) return false;
  open?.close();

  const type = view.state.schema.marks.link;
  let href = '';
  view.state.doc.nodesBetween(from, to, (node) => {
    const mark = node.marks.find((m) => m.type === type);
    if (mark) href = mark.attrs.href;
  });

  const box = document.createElement('div');
  box.className = 'bmd-link-editor';
  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'Paste or type a link';
  input.value = href;
  input.spellcheck = false;
  box.append(input);
  document.body.append(box);

  const at = view.coordsAtPos(from);
  box.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - 328))}px`;
  box.style.top = `${view.coordsAtPos(to).bottom + 6}px`;

  let closed = false;
  function close(apply) {
    if (closed) return;
    closed = true;
    open = null;
    box.remove();
    if (apply) {
      const value = input.value.trim();
      const tr = view.state.tr.removeMark(from, to, type);
      if (value) tr.addMark(from, to, type.create({ href: value }));
      tr.setSelection(TextSelection.create(tr.doc, to));
      view.dispatch(tr);
    }
    view.focus();
  }

  input.addEventListener('keydown', (e) => {
    if (isImeKey(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); close(true); }
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
  });
  input.addEventListener('blur', () => setTimeout(() => close(false), 0));
  open = { close: () => close(false) };
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return true;
}
