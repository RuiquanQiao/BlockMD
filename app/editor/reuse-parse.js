/**
 * Build the editor's first document from the tree the splice layer already parsed,
 * instead of parsing the same text a second time.
 *
 * Opening a file used to parse it twice: once for MdDoc (src/splice.js), once inside
 * Milkdown. On a 1 MB file each parse is most of a second (parity/feel.json:
 * large-file). Iron rule 2 says the two must tokenize identically; reusing the tree
 * makes that true by construction rather than by keeping two parsers in step.
 *
 * Milkdown's own remark transformers still run over it (they rewrite parts of the
 * tree in place, which is why they get a copy: MdDoc keeps references into its tree).
 * Everything else — nested editors, pasting — parses as before.
 * test/reuse-parse.test.js checks the document comes out equal to a fresh parse.
 */

import { ParserReady, editorStateTimerCtx, parserCtx, remarkCtx, schemaCtx } from '@milkdown/kit/core';
import { createTimer } from '@milkdown/kit/ctx';
import { ParserState } from '@milkdown/kit/transformer';

/**
 * @param {{text: string, tree: object} | undefined} seed The exact text the editor
 *   opens with, and the mdast MdDoc parsed from it. Used once.
 */
export function reuseParse(seed) {
  const Ready = createTimer('BmdReuseParseReady');
  return (ctx) => {
    ctx.record(Ready);
    ctx.update(editorStateTimerCtx, (timers) => timers.concat(Ready));
    return async () => {
      await ctx.wait(ParserReady);
      if (seed?.tree) {
        const remark = ctx.get(remarkCtx);
        const schema = ctx.get(schemaCtx);
        ctx.update(parserCtx, (parse) => (text) => {
          if (!seed.tree || text !== seed.text) return parse(text);
          const tree = remark.runSync(structuredClone(seed.tree), text);
          seed.tree = null; // the first document only
          seed.used = true;
          const state = new ParserState(schema);
          state.next(tree);
          return state.toDoc();
        });
      }
      ctx.done(Ready);
      return () => ctx.clearTimer(Ready);
    };
  };
}
