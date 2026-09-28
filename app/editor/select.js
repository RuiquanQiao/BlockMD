/**
 * Selecting several blocks at once, as in Notion.
 *
 * Esc selects the block at the cursor (keymap.js); Shift+↑/↓ then grows the selection
 * block by block, and Shift+click on another block's handle extends it to there.
 * With several blocks selected: Backspace/Delete removes them, Ctrl+Shift+↑/↓ moves
 * them, Ctrl+D duplicates them, Ctrl+C/Ctrl+X copy or cut them. Escape or any click
 * clears the selection.
 *
 * ProseMirror has no multi-node selection, so the range lives in this plugin's state
 * (top-level indices) and is drawn with node decorations. Moving re-inserts the same
 * node objects: moved blocks keep their original bytes, exactly like a drag.
 */

import { $prose } from '@milkdown/kit/utils';
import { serializerCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { Fragment, Slice } from '@milkdown/prose/model';

const key = new PluginKey('bmdBlockSelect');
/** Event the block handle sends for Shift+click on a grip: detail = top-level position. */
export const EXTEND_SELECTION = 'bmd-extend-selection';

const range = (state) => key.getState(state);
const clear = (view) => view.dispatch(view.state.tr.setMeta(key, null));

function bounds(state) {
  const r = range(state);
  if (!r) return null;
  const lo = Math.min(r.anchor, r.head), hi = Math.max(r.anchor, r.head);
  let from = 0;
  for (let i = 0; i < lo; i++) from += state.doc.child(i).nodeSize;
  let to = from;
  for (let i = lo; i <= hi; i++) to += state.doc.child(i).nodeSize;
  return { lo, hi, from, to };
}

/** Top-level index of the block holding the selection's head. */
function indexAt(state) {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.$from.depth === 0) return sel.$from.index(0);
  return sel.$head.index(0);
}

function setRange(view, anchor, head) {
  const { state } = view;
  let pos = 0;
  for (let i = 0; i < head; i++) pos += state.doc.child(i).nodeSize;
  const tr = state.tr.setMeta(key, { anchor, head });
  if (NodeSelection.isSelectable(state.doc.child(head))) tr.setSelection(NodeSelection.create(state.doc, pos));
  view.dispatch(tr.scrollIntoView());
}

function nodesIn(state, b) {
  const nodes = [];
  for (let i = b.lo; i <= b.hi; i++) nodes.push(state.doc.child(i));
  return nodes;
}

function deleteRange(view, b) {
  const { state } = view;
  const tr = state.tr.setMeta(key, null);
  if (b.lo === 0 && b.hi === state.doc.childCount - 1) tr.replaceWith(b.from, b.to, state.schema.nodes.paragraph.create());
  else tr.delete(b.from, b.to);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(b.from, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
}

function moveRange(view, b, dir) {
  const { state } = view;
  const nodes = nodesIn(state, b);
  const neighbour = state.doc.maybeChild(dir < 0 ? b.lo - 1 : b.hi + 1);
  if (!neighbour) return;
  const tr = state.tr.delete(b.from, b.to);
  const at = dir < 0 ? b.from - neighbour.nodeSize : b.from + neighbour.nodeSize;
  tr.insert(at, nodes);
  const r = range(state);
  tr.setMeta(key, { anchor: r.anchor + dir, head: r.head + dir });
  view.dispatch(tr.scrollIntoView());
}

function duplicateRange(view, b) {
  const nodes = nodesIn(view.state, b);
  const count = b.hi - b.lo + 1;
  const tr = view.state.tr.insert(b.to, nodes).setMeta(key, { anchor: b.hi + 1, head: b.hi + count });
  view.dispatch(tr.scrollIntoView());
}

export const blockSelectPlugin = $prose(
  (ctx) =>
    new Plugin({
      key,
      state: {
        init: () => null,
        apply(tr, prev) {
          const meta = tr.getMeta(key);
          if (meta !== undefined) return meta;
          // Anything else that changes the document or the selection ends the range.
          if (tr.docChanged || tr.selectionSet) return null;
          return prev;
        },
      },
      view(view) {
        const onExtend = (e) => {
          const target = view.state.doc.resolve(e.detail).index(0);
          const r = range(view.state);
          const sel = view.state.selection;
          const anchor = r ? r.anchor : sel instanceof NodeSelection && sel.$from.depth === 0 ? sel.$from.index(0) : indexAt(view.state);
          setRange(view, anchor, target);
        };
        view.dom.addEventListener(EXTEND_SELECTION, onExtend);
        return { destroy: () => view.dom.removeEventListener(EXTEND_SELECTION, onExtend) };
      },
      props: {
        decorations(state) {
          const b = bounds(state);
          if (!b) return null;
          const decos = [];
          let pos = b.from;
          for (let i = b.lo; i <= b.hi; i++) {
            const n = state.doc.child(i);
            decos.push(Decoration.node(pos, pos + n.nodeSize, { class: 'bmd-block-selected' }));
            pos += n.nodeSize;
          }
          return DecorationSet.create(state.doc, decos);
        },
        handleKeyDown(view, e) {
          const { state } = view;
          const mod = e.ctrlKey || e.metaKey;
          const sel = state.selection;
          const blockSelected = sel instanceof NodeSelection && sel.$from.depth === 0;

          // Shift+↑/↓ from a selected block (Esc) starts or grows the range.
          if (e.shiftKey && !mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && (range(state) || blockSelected)) {
            const r = range(state) ?? { anchor: indexAt(state), head: indexAt(state) };
            const head = Math.max(0, Math.min(state.doc.childCount - 1, r.head + (e.key === 'ArrowUp' ? -1 : 1)));
            setRange(view, r.anchor, head);
            return true;
          }

          const b = bounds(state);
          if (!b) return false;
          if (e.key === 'Escape') { clear(view); return true; }
          if (e.key === 'Backspace' || e.key === 'Delete') { deleteRange(view, b); return true; }
          if (mod && e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) { moveRange(view, b, e.code === 'ArrowUp' ? -1 : 1); return true; }
          if (mod && !e.shiftKey && e.code === 'KeyD') { duplicateRange(view, b); return true; }
          return false;
        },
        handleDOMEvents: {
          mousedown(view) { if (range(view.state)) clear(view); return false; },
          copy(view, e) { return copyRange(view, e, ctx, false); },
          cut(view, e) { return copyRange(view, e, ctx, true); },
        },
      },
    }),
);

function copyRange(view, e, ctx, cut) {
  const b = bounds(view.state);
  if (!b || !e.clipboardData) return false;
  const nodes = nodesIn(view.state, b);
  const slice = new Slice(Fragment.from(nodes), 0, 0);
  const { dom } = view.serializeForClipboard(slice);
  const markdown = ctx.get(serializerCtx)(view.state.schema.topNodeType.create(null, nodes));
  e.clipboardData.setData('text/html', dom.innerHTML);
  e.clipboardData.setData('text/plain', markdown);
  e.preventDefault();
  if (cut) deleteRange(view, b);
  return true;
}
