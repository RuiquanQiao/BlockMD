/**
 * Milkdown editor factory.
 *
 * The only place allowed to assemble the editor. `alignmentPlugins` must always be
 * present, otherwise the two remark instances tokenize differently and the splice
 * layer writes bytes into the wrong position.
 */

import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { history } from '@milkdown/kit/plugin/history';
import { block } from '@milkdown/kit/plugin/block';

import { alignmentPlugins } from '../../src/milkdown-adapter.js';
import { createBlockHandle } from './block-handle.js';
import { createSlashMenu, slash } from './slash-menu.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root Mount point
 * @param {string} opts.value Initial Markdown
 * @param {(ctx:any)=>void} [opts.onChange] Called after each document-changing transaction
 * @returns {Promise<import('@milkdown/kit/core').Editor>}
 */
export async function createEditor({ root, value, onChange }) {
  const editor = await buildEditor({ root, value, onChange });

  const kick = () => {
    editor.action((ctx) => {
      try {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr);
      } catch (err) {
        console.error('[BlockMD] failed to trigger initial plugin view update', err);
      }
    });
  };

  // Dispatch an empty transaction to trigger each plugin view's first update.
  // plugin-block only mounts its drag handle inside update(), so without this nudge
  // the handle never appears for a user who opens a document and does not type.
  // An empty transaction has docChanged === false, so it cannot affect fidelity state.
  kick();

  // BlockProvider mounts inside requestAnimationFrame, and hidden tabs do not fire
  // rAF. If the app is opened in a background tab the nudge above is lost, and once
  // the user returns there is no further transaction to retry it. Recover here.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      kick();
    };
    document.addEventListener('visibilitychange', onVisible);
  }

  return editor;
}

function buildEditor({ root, value, onChange }) {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, value);

      // Drag handle: plugin-block owns positioning and drag behaviour, we own the look.
      ctx.set(block.key, {
        view: (view) => createBlockHandle(ctx, view),
      });

      ctx.set(slash.key, createSlashMenu(ctx));

      if (onChange) {
        ctx.get(listenerCtx).updated((_ctx, doc, prevDoc) => {
          if (doc === prevDoc) return;
          onChange(_ctx);
        });
      }
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(history)
    .use(alignmentPlugins)
    .use(block)
    .use(slash)
    .create();
}

export { editorViewCtx };
