/**
 * Notion's Markdown-style shortcuts that CommonMark/GFM input rules don't cover.
 *
 *   `[] `  → to-do            (GFM's own rule only knows `[ ] ` inside a list item)
 *   `" `   → quote            (Notion; `> ` keeps working as in Markdown)
 *   ```    → code block       (at once, as in Notion; the language is picked on the block)
 */

import { $inputRule } from '@milkdown/kit/utils';
import { InputRule, wrappingInputRule, textblockTypeInputRule } from '@milkdown/prose/inputrules';
import { findWrapping } from '@milkdown/prose/transform';
import { blockquoteSchema, codeBlockSchema } from '@milkdown/kit/preset/commonmark';

const todo = $inputRule(
  () =>
    new InputRule(/^\[\s?\]\s$/, (state, _match, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type.name !== 'paragraph') return null;
      const tr = state.tr.delete(start, end);
      const item = $start.depth >= 2 ? $start.node($start.depth - 1) : null;
      if (item?.type.name === 'list_item' && $start.index($start.depth - 1) === 0) {
        return tr.setNodeMarkup($start.before($start.depth - 1), undefined, { ...item.attrs, checked: false });
      }
      const range = tr.doc.resolve(start).blockRange();
      const wrap = range && findWrapping(range, state.schema.nodes.bullet_list);
      if (!wrap) return null;
      const last = wrap[wrap.length - 1];
      wrap[wrap.length - 1] = { ...last, attrs: { ...last.attrs, checked: false } };
      return tr.wrap(range, wrap);
    }),
);

const quote = $inputRule((ctx) => wrappingInputRule(/^"\s$/, blockquoteSchema.type(ctx)));

const codeFence = $inputRule((ctx) =>
  textblockTypeInputRule(/^```$/, codeBlockSchema.type(ctx), { language: '' }));

export const inputRules = [todo, quote, codeFence];
