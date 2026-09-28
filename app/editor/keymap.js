/**
 * Notion's block and formatting shortcuts (notion.com/help/keyboard-shortcuts).
 *
 * Matched on `event.code`, not `event.key`: with Shift held, the key for Digit1 is "!"
 * on a US layout and something else on others, while the physical key is stable.
 *
 * Moving a block re-inserts the *same* node object, so identity reconciliation keeps
 * its original bytes — like dragging, moving with the keyboard re-serializes nothing.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@milkdown/prose/state';
import { toggleMark } from '@milkdown/prose/commands';
import { blockAtSelection, turnInto, duplicateBlock } from './block-types.js';
import { openLinkEditor } from './link.js';
import { turnIntoToggle } from './containers.js';

/** Ctrl+Shift+digit → block type, as in Notion. 7 (toggle) is handled separately. */
const TURN_INTO = { 0: 'text', 1: 'h1', 2: 'h2', 3: 'h3', 4: 'todo', 5: 'ul', 6: 'ol', 8: 'code' };

/** Event the block handle listens for, to open its menu on the current block. */
export const OPEN_BLOCK_MENU = 'bmd-open-block-menu';

/**
 * Swap the block at the cursor with its previous or next sibling.
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {-1|1} dir
 */
export function moveBlock(view, dir) {
  const { state } = view;
  const { pos, node } = state.selection instanceof NodeSelection
    ? { pos: state.selection.from, node: state.selection.node }
    : blockAtSelection(state);
  const $pos = state.doc.resolve(pos);
  const index = $pos.index();
  const sibling = $pos.parent.maybeChild(index + dir);
  if (!sibling) return true; // already first / last: consume the key anyway

  const wasNode = state.selection instanceof NodeSelection;
  const offset = state.selection.from - pos;
  const tr = state.tr;
  let at;
  if (dir < 0) {
    at = pos - sibling.nodeSize;
    tr.delete(pos, pos + node.nodeSize).insert(at, node);
  } else {
    tr.insert(pos + node.nodeSize + sibling.nodeSize, node).delete(pos, pos + node.nodeSize);
    at = pos + sibling.nodeSize;
  }
  tr.setSelection(wasNode ? NodeSelection.create(tr.doc, at) : TextSelection.near(tr.doc.resolve(at + offset)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function menuOpen() {
  return [...document.querySelectorAll('.bmd-slash, .bmd-menu')].some(
    (el) => getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none' && el.offsetWidth > 0,
  );
}

/**
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {KeyboardEvent} e
 */
function handleKeyDown(view, e) {
  const mod = e.ctrlKey || e.metaKey;
  const { state } = view;

  if (mod && e.shiftKey && !e.altKey) {
    if (e.code === 'KeyS') {
      return toggleMark(state.schema.marks.strike_through)(state, view.dispatch);
    }
    const digit = /^Digit(\d)$/.exec(e.code)?.[1];
    if (digit === '7') { turnIntoToggle(view); return true; }
    if (digit && TURN_INTO[digit]) {
      turnInto(view, blockAtSelection(state), TURN_INTO[digit]);
      return true;
    }
    if (e.code === 'ArrowUp') return moveBlock(view, -1);
    if (e.code === 'ArrowDown') return moveBlock(view, 1);
  }

  if (mod && !e.shiftKey && !e.altKey) {
    if (e.code === 'KeyK') return openLinkEditor(view);
    if (e.code === 'KeyD') {
      duplicateBlock(view, state.selection instanceof NodeSelection
        ? { pos: state.selection.from, node: state.selection.node }
        : blockAtSelection(state));
      return true;
    }
    // Not from a toggle body or column: the block menu belongs to the main editor.
    if (e.code === 'Slash' && !view.dom.classList.contains('bmd-nested')) {
      view.dom.dispatchEvent(new CustomEvent(OPEN_BLOCK_MENU, { detail: blockAtSelection(state) }));
      return true;
    }
  }

  // Esc selects the block the cursor is in (Notion); Backspace then deletes it.
  if (e.key === 'Escape' && !mod && !e.shiftKey && !menuOpen() && !(state.selection instanceof NodeSelection)) {
    const target = blockAtSelection(state);
    if (NodeSelection.isSelectable(target.node)) {
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, target.pos)));
      return true;
    }
  }
  return false;
}

export const keymapPlugin = $prose(
  () => new Plugin({ key: new PluginKey('bmdKeymap'), props: { handleKeyDown } }),
);
