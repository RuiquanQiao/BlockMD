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
import remarkMath from 'remark-math';
import { FRONTMATTER_KINDS } from './remark-config.js';
import { groupContainers, containersToMarkdown } from './containers.js';

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

/**
 * Math: `$…$` / `$$…$$` (remark-math), matching micromark-extension-math on the splice
 * side. A top-level `$$` block is mdast `math` → `math_block`; `$…$` inside a
 * paragraph is `inlineMath` → `math_inline`.
 *
 * Both are atoms holding the TeX source in `value`: the editor shows them typeset
 * (app/editor/math.js) and edits the source in a small popover, never as loose text
 * that could be half-deleted. Rendering lives in the app, not here, so this module
 * stays free of KaTeX and loads in the tests.
 */
export const mathRemark = $remark('bmdMath', () => remarkMath);

export const mathInlineNode = $nodeSchema('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [{ tag: 'span[data-bmd="math-inline"]', getAttrs: (dom) => ({ value: dom.dataset.value ?? '' }) }],
  toDOM: (node) => ['span', { 'data-bmd': 'math-inline', 'data-value': node.attrs.value }, node.attrs.value],
  parseMarkdown: {
    match: ({ type }) => type === 'inlineMath',
    runner: (state, node, type) => { state.addNode(type, { value: node.value ?? '' }); },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => { state.addNode('inlineMath', undefined, node.attrs.value); },
  },
}));

export const mathBlockNode = $nodeSchema('math_block', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  attrs: { value: { default: '' } },
  parseDOM: [{ tag: 'div[data-bmd="math-block"]', getAttrs: (dom) => ({ value: dom.dataset.value ?? '' }) }],
  toDOM: (node) => ['div', { 'data-bmd': 'math-block', 'data-value': node.attrs.value }, node.attrs.value],
  parseMarkdown: {
    match: ({ type }) => type === 'math',
    runner: (state, node, type) => { state.addNode(type, { value: node.value ?? '' }); },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => { state.addNode('math', undefined, node.attrs.value); },
  },
}));

/**
 * Toggles and columns (containers.js): regroup their sibling nodes exactly as the
 * splice layer does, and teach remark-stringify to write them back.
 *
 * Both are atoms whose parts are kept as raw Markdown text — `body` for a toggle,
 * `columns` for a row. The app edits each part in a nested editor
 * (app/editor/containers.js) and writes back only the part that changed, so the
 * other parts keep their bytes.
 */
export const containersRemark = $remark('bmdContainers', () => function attacher() {
  const data = this.data();
  (data.toMarkdownExtensions ??= []).push(containersToMarkdown);
  return (tree, file) => { groupContainers(tree, String(file)); };
});

export const toggleNode = $nodeSchema('toggle', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  attrs: { summary: { default: '' }, body: { default: '' }, open: { default: false } },
  parseDOM: [{ tag: 'div[data-bmd="toggle"]', getAttrs: (d) => ({ summary: d.dataset.summary ?? '', body: d.dataset.body ?? '' }) }],
  toDOM: (n) => ['div', { 'data-bmd': 'toggle', 'data-summary': n.attrs.summary, 'data-body': n.attrs.body }],
  parseMarkdown: {
    match: ({ type }) => type === 'bmdToggle',
    runner: (state, node, type) => { state.addNode(type, { summary: node.summary, body: node.body, open: node.open }); },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'toggle',
    runner: (state, node) => { state.addNode('bmdToggle', undefined, undefined, { ...node.attrs }); },
  },
}));

export const columnRowNode = $nodeSchema('column_row', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  attrs: { columns: { default: ['', ''] } },
  parseDOM: [{ tag: 'div[data-bmd="columns"]', getAttrs: (d) => ({ columns: JSON.parse(d.dataset.columns ?? '["",""]') }) }],
  toDOM: (n) => ['div', { 'data-bmd': 'columns', 'data-columns': JSON.stringify(n.attrs.columns) }],
  parseMarkdown: {
    match: ({ type }) => type === 'bmdRow',
    runner: (state, node, type) => { state.addNode(type, { columns: node.columns }); },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'column_row',
    runner: (state, node) => { state.addNode('bmdRow', undefined, undefined, { columns: node.attrs.columns }); },
  },
}));

/** Everything needed to keep both remark instances in sync. All of it is required. */
export const alignmentPlugins = [
  frontmatterRemark, frontmatterNode, mathRemark, mathInlineNode, mathBlockNode,
  containersRemark, toggleNode, columnRowNode,
].flat();

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
