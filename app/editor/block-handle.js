/**
 * Drag handle — the view layer for plugin-block.
 *
 * plugin-block handles positioning, hit-testing the hovered block, and native drag
 * behaviour. This file supplies the appearance, the "add block" button and the block
 * menu behind the grip (see block-menu.js).
 *
 * Note that reordering by drag triggers **no** re-serialization on save: the moved
 * block carries its original bytes along (see identity reconciliation). That is the
 * core difference between this editor and the alternatives.
 */

import { BlockProvider } from '@milkdown/kit/plugin/block';
import { editorViewCtx } from '@milkdown/kit/core';
import { NodeSelection, TextSelection } from '@milkdown/prose/state';
import { offset } from '@floating-ui/dom';
import { createBlockMenu } from './block-menu.js';
import { guardHandlePosition } from './handle-guard.js';
import { OPEN_BLOCK_MENU } from './keymap.js';
import { EXTEND_SELECTION } from './select.js';
import { TEST_HOOKS } from '../test-hooks.js';

/** Gap between the handle's right edge and the left edge of the text column. */
const HANDLE_GAP = 8;

/**
 * Height of the box the handle is centred against, for blocks taller than one line.
 * Aligning to the whole block would float the handle down the middle of a long code
 * block; aligning to roughly the first line keeps it beside the block's first row.
 */
const FIRST_LINE = 30;

const GRIP = `<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>`;
const PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`;

/**
 * @param {any} ctx Milkdown ctx
 * @param {import('@milkdown/prose/view').EditorView} view
 */
export function createBlockHandle(ctx, view) {
  const content = document.createElement('div');
  content.className = 'bmd-handle';
  content.setAttribute('role', 'toolbar');
  content.setAttribute('aria-label', 'Block actions');

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'bmd-handle-btn bmd-handle-add';
  add.innerHTML = PLUS;
  add.title = 'Insert block below';
  add.setAttribute('aria-label', 'Insert block below');

  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'bmd-handle-btn bmd-handle-grip';
  grip.innerHTML = GRIP;
  grip.title = 'Drag to move, click for options';
  grip.setAttribute('aria-label', 'Drag to move this block');
  // Do not set draggable here: BlockProvider sets it on the whole handle element and
  // binds dragstart to it. Setting it again on a child creates a nested drag source.

  content.append(add, grip);

  const provider = new BlockProvider({
    ctx,
    content,

    // Anchor to the text column, never to the resolved node's own box.
    //
    // plugin-block's selectRootNodeByDom only walks up to the parent when the hovered
    // node is its parent's first child, so hovering the *second* list item anchors to
    // the `li`. An `li`'s left edge is where its text starts, which puts a handle
    // placed to its left straight on top of the bullet. Every block, at any nesting
    // depth, therefore reports the same left edge: the column's.
    getPosition: ({ active, editorDom }) => {
      const block = active.el.getBoundingClientRect();
      const column = editorDom.getBoundingClientRect();
      return new DOMRect(column.left, block.top, 0, Math.min(block.height, FIRST_LINE));
    },

    // Replaces the plugin's default middleware, which includes flip(). Flipping would
    // move the handle to the *right* of the reference when the left gutter is tight —
    // i.e. on top of the text. The gutter is guaranteed wide enough in styles.css
    // (--gutter is never smaller than the handle), so left placement always fits.
    floatingUIOptions: { middleware: [offset({ mainAxis: HANDLE_GAP })] },
  });

  // Careful: BlockProvider.#init() — which mounts the handle and binds the service —
  // only runs inside update(), and update() waits for the editor's first change. If a
  // user opens a document and never types, the handle would never appear. Do not call
  // provider.update() from here either: editorViewCtx is not ready yet and #init()
  // throws, which it swallows with an empty catch block — extremely hard to diagnose.
  // The real nudge lives in create-editor.js, after the editor is fully built.

  // Add button: insert a paragraph holding just `/` after the current block, which is
  // what Notion does — the slash menu then opens by its ordinary rule, so choosing a
  // type, filtering by typing and Escape all behave exactly as when typing `/`.
  //
  // Showing the menu directly on an empty paragraph does not work: plugin-slash
  // re-evaluates shouldShow 200 ms after every transaction, finds no `/`, and hides
  // it again. That was the old behaviour — the menu flashed and vanished.
  add.addEventListener('click', (e) => {
    e.preventDefault();
    const active = provider.active;
    if (!active) return;
    const view = ctx.get(editorViewCtx);
    const { state, dispatch } = view;
    const insertPos = active.$pos.pos + active.node.nodeSize;
    const para = state.schema.nodes.paragraph.create(null, state.schema.text('/'));
    const tr = state.tr.insert(insertPos, para);
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
    dispatch(tr.scrollIntoView());
    view.focus();
  });

  // Clicking the grip selects the block and opens the block menu (Turn into /
  // Duplicate / Delete). The selection itself comes from plugin-block's mousedown;
  // this only adds the menu. Dragging never produces a click, so drags are unaffected.
  const menu = createBlockMenu({ getView: () => ctx.get(editorViewCtx) });
  grip.addEventListener('click', (e) => {
    e.preventDefault();
    const active = provider.active;
    if (!active) return;
    // Shift+click: extend a block selection to this block instead (select.js).
    if (e.shiftKey && active.$pos.depth === 0) {
      ctx.get(editorViewCtx).dom.dispatchEvent(new CustomEvent(EXTEND_SELECTION, { detail: active.$pos.pos }));
      return;
    }
    const view = ctx.get(editorViewCtx);
    if (NodeSelection.isSelectable(active.node)) {
      const { state } = view;
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, active.$pos.pos)));
    }
    menu.open(grip, { pos: active.$pos.pos, node: active.node });
  });

  // Nothing is drawn until the position has been checked against the active block.
  // See handle-guard.js for why: the plugin reveals the handle from an async callback
  // that can carry a stale position.
  // Ctrl+/ (keymap.js): the same menu, for the block the cursor is in.
  const openFromKeyboard = (e) => {
    const { pos, node } = e.detail;
    const anchor = view.nodeDOM(pos);
    menu.open(anchor instanceof HTMLElement ? anchor : view.dom, { pos, node });
  };
  view.dom.addEventListener(OPEN_BLOCK_MENU, openFromKeyboard);

  const unguard = guardHandlePosition({
    element: content,
    getActive: () => provider.active,
    getColumn: () => ctx.get(editorViewCtx).dom,
    onReject: import.meta.env?.DEV
      ? (msg, detail) => console.error('[BlockMD] ' + msg, detail)
      : undefined,
  });

  if (TEST_HOOKS) {
    window.__bmdHandle = { content, provider, ctx };
  }

  return {
    update: (updatedView, prevState) => provider.update(updatedView, prevState),
    destroy: () => {
      view.dom.removeEventListener(OPEN_BLOCK_MENU, openFromKeyboard);
      unguard();
      menu.destroy();
      provider.destroy();
    },
  };
}
