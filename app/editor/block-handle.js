/**
 * Drag handle — the view layer for plugin-block.
 *
 * plugin-block handles positioning, hit-testing the hovered block, and native drag
 * behaviour. This file only supplies the appearance and the "add block" button.
 *
 * Note that reordering by drag triggers **no** re-serialization on save: the moved
 * block carries its original bytes along (see identity reconciliation). That is the
 * core difference between this editor and the alternatives.
 */

import { BlockProvider } from '@milkdown/kit/plugin/block';
import { editorViewCtx } from '@milkdown/kit/core';
import { NodeSelection, TextSelection } from '@milkdown/prose/state';
import { openSlashMenuAt } from './slash-menu.js';

const GRIP = `<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>`;
const PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`;

/**
 * @param {any} ctx Milkdown ctx
 * @param {import('@milkdown/prose/view').EditorView} _view
 */
export function createBlockHandle(ctx, _view) {
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
  grip.title = 'Drag to move, click to select';
  grip.setAttribute('aria-label', 'Drag to move this block');
  // Do not set draggable here: BlockProvider sets it on the whole handle element and
  // binds dragstart to it. Setting it again on a child creates a nested drag source.

  content.append(add, grip);

  const provider = new BlockProvider({
    ctx,
    content,
    getOffset: () => ({ mainAxis: 8 }),
  });

  // Careful: BlockProvider.#init() — which mounts the handle and binds the service —
  // only runs inside update(), and update() waits for the editor's first change. If a
  // user opens a document and never types, the handle would never appear. Do not call
  // provider.update() from here either: editorViewCtx is not ready yet and #init()
  // throws, which it swallows with an empty catch block — extremely hard to diagnose.
  // The real nudge lives in create-editor.js, after the editor is fully built.

  // Add button: insert an empty paragraph after the current block, then open the menu.
  add.addEventListener('click', (e) => {
    e.preventDefault();
    const active = provider.active;
    if (!active) return;
    const view = ctx.get(editorViewCtx);
    const { state, dispatch } = view;
    const insertPos = active.$pos.pos + active.node.nodeSize;
    const para = state.schema.nodes.paragraph.create();
    const tr = state.tr.insert(insertPos, para);
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
    dispatch(tr.scrollIntoView());
    view.focus();
    openSlashMenuAt(ctx);
  });

  // Clicking the grip selects the whole block, which makes keyboard use and deletion
  // straightforward.
  grip.addEventListener('click', (e) => {
    e.preventDefault();
    const active = provider.active;
    if (!active) return;
    const view = ctx.get(editorViewCtx);
    const { state, dispatch } = view;
    try {
      const sel = NodeSelection.create(state.doc, active.$pos.pos);
      dispatch(state.tr.setSelection(sel));
      view.focus();
    } catch {
      /* Some block types cannot be a NodeSelection target; ignore. */
    }
  });

  if (import.meta.env?.DEV) {
    window.__bmdHandle = { content, provider, ctx };
  }

  return {
    update: (updatedView, prevState) => provider.update(updatedView, prevState),
    destroy: () => provider.destroy(),
  };
}
