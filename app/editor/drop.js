/**
 * Dropping a dragged block: where it lands, and the blue line that says so.
 *
 * ProseMirror's own drop logic works from the position under the pointer, and for a
 * block dragged by its handle that gave two problems: nothing showed where the block
 * would go, and dropping on the top half of the first block put it *after* that block
 * — a block could never be moved to the top of the page.
 *
 * For top-level blocks this plugin decides instead, the way Notion does: the drop
 * slot is the gap nearest the pointer (above a block's middle → before it), and a line
 * is drawn in that gap while dragging. The move re-inserts the same node object, so
 * the block keeps its original bytes (identity reconciliation). Nested drags — a list
 * item within its list — still use ProseMirror's handling.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, NodeSelection } from '@milkdown/prose/state';

/** The NodeSelection plugin-block hands over in `view.dragging.node`, if top-level. */
function draggedBlock(view) {
  const sel = view.dragging?.node;
  return sel instanceof NodeSelection && sel.$from.depth === 0 ? sel : null;
}

/** Index of the gap (0 = before the first block) nearest to `y`. */
function gapAt(view, y) {
  const { doc } = view.state;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const dom = view.nodeDOM(pos);
    if (dom?.getBoundingClientRect) {
      const r = dom.getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    pos += doc.child(i).nodeSize;
  }
  return doc.childCount;
}

function gapY(view, gap) {
  const { doc } = view.state;
  let pos = 0;
  for (let i = 0; i < Math.min(gap, doc.childCount); i++) pos += doc.child(i).nodeSize;
  if (gap < doc.childCount) return view.nodeDOM(pos).getBoundingClientRect().top - 2;
  const lastPos = pos - doc.lastChild.nodeSize;
  return view.nodeDOM(lastPos).getBoundingClientRect().bottom + 1;
}

export const dropPlugin = $prose(() => {
  const line = document.createElement('div');
  line.className = 'bmd-drop-indicator';
  line.hidden = true;
  const hide = () => { line.hidden = true; };

  return new Plugin({
    key: new PluginKey('bmdDrop'),
    view() {
      document.body.append(line);
      return { destroy: () => line.remove() };
    },
    props: {
      handleDOMEvents: {
        dragover(view, event) {
          if (!draggedBlock(view)) { hide(); return false; }
          const col = view.dom.getBoundingClientRect();
          line.style.left = `${col.left}px`;
          line.style.width = `${col.width}px`;
          line.style.top = `${gapY(view, gapAt(view, event.clientY))}px`;
          line.hidden = false;
          return false;
        },
        dragleave(view, event) {
          if (!view.dom.contains(event.relatedTarget)) hide();
          return false;
        },
        dragend() { hide(); return false; },
      },
      handleDrop(view, event, _slice, moved) {
        hide();
        const sel = draggedBlock(view);
        if (!moved || !sel) return false;
        const { doc } = view.state;
        const gap = gapAt(view, event.clientY);
        const index = sel.$from.index(0);
        if (gap === index || gap === index + 1) return true; // dropped where it was

        let insertAt = 0;
        for (let i = 0; i < gap; i++) insertAt += doc.child(i).nodeSize;
        const tr = view.state.tr.delete(sel.from, sel.to);
        const at = tr.mapping.map(insertAt);
        tr.insert(at, sel.node).setSelection(NodeSelection.create(tr.doc, at));
        view.dispatch(tr.scrollIntoView());
        view.dragging = null;
        return true;
      },
    },
  });
});
