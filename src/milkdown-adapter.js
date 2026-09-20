/**
 * Editor-side alignment layer for Milkdown.
 *
 * Sole responsibility: make the editor's remark tokenization match
 * `src/remark-config.js` exactly. Any divergence skews the mdast ↔ ProseMirror
 * block mapping, which makes the splice layer write bytes into the wrong position.
 *
 * Usage:
 *   import { alignmentPlugins } from './milkdown-adapter.js';
 *   Editor.make().use(commonmark).use(gfm).use(alignmentPlugins).create();
 */

import { $remark, $nodeSchema } from '@milkdown/kit/utils';
import { editorViewCtx } from '@milkdown/kit/core';
import remarkFrontmatter from 'remark-frontmatter';
import { FRONTMATTER_KINDS } from './remark-config.js';

/**
 * Mount remark-frontmatter into Milkdown's remark instance.
 *
 * Without it, `---\ntitle: x\n---` parses as three nodes on the editor side
 * (`hr + heading + heading`) while the splice layer sees a single `yaml` node —
 * an immediate mapping skew.
 */
export const frontmatterRemark = $remark(
  'bmdFrontmatter',
  () => remarkFrontmatter,
  FRONTMATTER_KINDS,
);

/**
 * ProseMirror node for front matter.
 *
 * Required, not optional: Milkdown throws `Cannot match target parser for node` for
 * any mdast type lacking a parser — it does not silently ignore them. So "mount the
 * remark plugin and let the editor drop it" is not a workable approach.
 *
 * Currently rendered as a plain text block (`code: true` keeps its contents out of
 * Markdown parsing). This can become a proper properties UI later, but the node name
 * `frontmatter` must keep matching the entry registered in mapping.js.
 */
export const frontmatterNode = $nodeSchema('frontmatter', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  code: true,
  defining: true,
  parseDOM: [{ tag: 'div[data-bmd="frontmatter"]', preserveWhitespace: 'full' }],
  toDOM: () => ['div', { 'data-bmd': 'frontmatter' }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'yaml',
    runner: (state, node, type) => {
      state.openNode(type);
      if (node.value) state.addText(node.value);
      state.closeNode();
    },
  },
  toMarkdown: {
    // Present only to satisfy Milkdown's completeness requirement; real saves go
    // through the splice layer and never take this path.
    match: (node) => node.type.name === 'frontmatter',
    runner: (state, node) => {
      state.addNode('yaml', undefined, node.textContent);
    },
  },
}));

/** Everything needed to keep both remark instances in sync. All of it is required. */
export const alignmentPlugins = [frontmatterRemark, frontmatterNode].flat();

/**
 * Read the editor document's top-level node type names, for `buildMapping`.
 * @param {object} ctx Milkdown ctx
 * @returns {string[]}
 */
export function readTopLevelTypes(ctx) {
  const types = [];
  ctx.get(editorViewCtx).state.doc.forEach((n) => types.push(n.type.name));
  return types;
}

/**
 * Read the editor document's top-level nodes, for identity reconciliation.
 * @param {object} ctx Milkdown ctx
 * @returns {object[]}
 */
export function readTopLevelNodes(ctx) {
  const nodes = [];
  ctx.get(editorViewCtx).state.doc.forEach((n) => nodes.push(n));
  return nodes;
}
