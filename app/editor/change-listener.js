/**
 * "The document changed" — called 200 ms after the last change, like Milkdown's
 * listener plugin's `updated`, which is all BlockMD used of it.
 *
 * Why not that plugin: when the editor starts it serializes the whole document to
 * Markdown (for a `markdownUpdated` nobody here listens to). On a 1 MB file that was a
 * noticeable part of opening it (parity/feel.json: large-file).
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';

const DELAY = 200;

/** @param {((ctx: any) => void) | undefined} onChange */
export function changeListener(onChange) {
  return $prose((ctx) => {
    let timer = null;
    let since = null; // the document as of the last call
    return new Plugin({
      key: new PluginKey('bmdChange'),
      view: (view) => {
        since = view.state.doc;
        return {
          update(v, prev) {
            if (!onChange || v.state.doc === prev.doc) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
              const doc = v.state.doc;
              if (since && since.eq(doc)) return; // changed and changed back
              since = doc;
              onChange(ctx);
            }, DELAY);
          },
          destroy() { clearTimeout(timer); },
        };
      },
    });
  });
}
