/**
 * Single source of truth for the remark configuration.
 *
 * The splice layer and the editor MUST use the exact same set of remark extensions.
 * The moment their tokenization diverges, mdast top-level nodes stop lining up with
 * ProseMirror top-level nodes — and a skewed mapping means the splice layer writes
 * block A's original bytes into block B's position. Silent data corruption.
 *
 * A real example that was measured: with frontmatter enabled on the splice side but
 * not in the editor, `---\ntitle: x\n---` is one `yaml` node here and three nodes
 * (`hr + heading + heading`) over there.
 *
 * Therefore: **adding a remark plugin means editing this file and only this file**,
 * plus registering the mdast types it produces in `mapping.js`.
 */

import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { groupContainers, containersToMarkdown } from './containers.js';

/** Front matter fence kinds. Must match on both sides. */
export const FRONTMATTER_KINDS = ['yaml'];

/** Options passed to `fromMarkdown`. */
export const parseOptions = () => ({
  extensions: [gfm(), frontmatter(FRONTMATTER_KINDS), math()],
  mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(FRONTMATTER_KINDS), mathFromMarkdown()],
});

/**
 * Parse Markdown exactly as the editor does: the micromark/mdast extensions above,
 * then the container regrouping (toggles, columns — see containers.js), which the
 * editor applies through its remark plugin. Use this, never bare `fromMarkdown`.
 * @param {string} text
 */
export const parseMarkdown = (text) => groupContainers(fromMarkdown(text, parseOptions()), text);

/** Extensions passed to `toMarkdown`; callers merge in style-inference options. */
export const serializeExtensions = () => [
  gfmToMarkdown(),
  frontmatterToMarkdown(FRONTMATTER_KINDS),
  mathToMarkdown(),
  containersToMarkdown,
];

/**
 * Remark plugins the editor has to mount on top of its presets.
 *
 * Milkdown's commonmark + gfm presets already cover GFM but **not** front matter,
 * so `src/milkdown-adapter.js` adds it via `$remark`. Without that, the two sides
 * tokenize differently.
 */
export const EDITOR_REQUIRED_REMARK_PLUGINS = [
  { id: 'bmdFrontmatter', pkg: 'remark-frontmatter', options: FRONTMATTER_KINDS },
  // `$…$` / `$$…$$`, as GitHub renders them. Top-level `$$` blocks are mdast `math`.
  { id: 'bmdMath', pkg: 'remark-math', options: undefined },
  // Not a package: groupContainers from containers.js, as a remark transform.
  { id: 'bmdContainers', pkg: null, options: undefined },
];
