/**
 * Milkdown editor factory.
 *
 * The only place allowed to assemble the editor. `alignmentPlugins` must always be
 * present, otherwise the two remark instances tokenize differently and the splice
 * layer writes bytes into the wrong position.
 */

import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark, syncHeadingIdPlugin } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { block } from '@milkdown/kit/plugin/block';
import { clipboard } from '@milkdown/kit/plugin/clipboard';

import { alignmentPlugins } from '../../src/milkdown-adapter.js';
import { createBlockHandle } from './block-handle.js';
import { createSlashMenu, slash } from './slash-menu.js';
import { calloutPlugin } from './callout.js';
import { taskListPlugin } from './task-list.js';
import { imagePlugin } from './image.js';
import { keymapPlugin } from './keymap.js';
import { inputRules } from './input-rules.js';
import { toolbarPlugin } from './toolbar.js';
import { findPlugin } from './find.js';
import { dropPlugin } from './drop.js';
import { codeBlockPlugin } from './code-block.js';
import { highlightPlugin } from './highlight.js';
import { mathPlugins } from './math.js';
import { containerViewsPlugin } from './containers.js';
import { mediaPlugin } from './media.js';
import { emojiPlugin } from './emoji.js';
import { blockSelectPlugin } from './select.js';
import { clipboardExtrasPlugin } from './clipboard-extras.js';
import { changeListener } from './change-listener.js';
import { reuseParse } from './reuse-parse.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root Mount point
 * @param {string} opts.value Initial Markdown
 * @param {(ctx:any)=>void} [opts.onChange] Called after each document-changing transaction
 * @param {object} [opts.tree] The mdast MdDoc parsed from `value`, reused instead of a
 *   second parse (reuse-parse.js)
 * @returns {Promise<import('@milkdown/kit/core').Editor>}
 */
export async function createEditor({ root, value, onChange, tree }) {
  const seed = tree ? { text: value, tree, used: false } : undefined;
  const editor = await buildEditor({ root, value, onChange, seed });
  editor.parseReused = Boolean(seed?.used);

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

function buildEditor({ root, value, onChange, seed }) {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, value);

      // Drag handle: plugin-block owns positioning and drag behaviour, we own the look.
      ctx.set(block.key, {
        view: (view) => createBlockHandle(ctx, view),
      });

      ctx.set(slash.key, createSlashMenu(ctx));

    })
    // Without the heading-id plugin: it gives every heading an `id` (nothing here uses
    // one; they never reach the file) with one step per heading on open, then rescans
    // the whole document on every keystroke (parity/feel.json: large-file).
    .use(commonmark.filter((p) => p !== syncHeadingIdPlugin))
    .use(gfm)
    .use(changeListener(onChange))
    .use(reuseParse(seed))
    .use(history)
    .use(alignmentPlugins)
    .use(calloutPlugin)
    .use(taskListPlugin)
    .use(imagePlugin)
    // Pasted text is parsed as Markdown, so pasting a README gives blocks, not one paragraph.
    // Before clipboard: Paste as Plain Text must see the paste before it is parsed.
    .use(clipboardExtrasPlugin)
    .use(clipboard)
    // Before keymapPlugin: while open, the picker and a block range own the keys they use.
    .use(emojiPlugin)
    .use(blockSelectPlugin)
    .use(keymapPlugin)
    .use(inputRules)
    .use(toolbarPlugin)
    .use(findPlugin)
    // Before `block`: this plugin's handleDrop must see a handle drag first.
    .use(dropPlugin)
    .use(codeBlockPlugin)
    .use(highlightPlugin)
    .use(mathPlugins)
    .use(containerViewsPlugin)
    .use(mediaPlugin)
    .use(block)
    .use(slash)
    .create();
}

export { editorViewCtx };
