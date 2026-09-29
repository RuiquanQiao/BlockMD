/**
 * Callouts — GitHub / Obsidian alert syntax, rendered like Notion's callout block.
 *
 *   > [!NOTE]
 *   > Body text
 *
 * Why this syntax: it is the only callout notation with wide support (GitHub,
 * Obsidian, GitLab, many static site generators), and to every other Markdown
 * parser it is simply a blockquote. That second property is what makes it safe here:
 * no remark plugin, no new node type, so the splice layer and the editor still
 * tokenize identically (iron rule 2 is untouched). A callout is a *view* of a
 * blockquote, applied with decorations; the document model never changes.
 *
 * One trap on the save path: Milkdown's serializer escapes the opening bracket
 * (`> \[!NOTE]`), which GitHub no longer recognises as an alert. Only freshly
 * serialized blocks are affected — existing callouts keep their original bytes — and
 * `restoreCalloutMarkers` undoes exactly that escape.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration } from '@milkdown/prose/view';
import { blockwise } from './blockwise.js';

/** `[!TYPE]` plus Obsidian's optional fold sign, at the very start of the first line. */
export const CALLOUT_MARKER = /^\[!([A-Za-z][\w-]*)\]([-+]?)/;

/** The type new callouts get. GitHub's five are NOTE, TIP, IMPORTANT, WARNING, CAUTION. */
export const DEFAULT_CALLOUT = 'NOTE';

/**
 * @param {import('@milkdown/prose/model').Node} node
 * @returns {{type:string, length:number}|null} Marker type and its length in characters
 */
export function calloutInfo(node) {
  if (node.type.name !== 'blockquote') return null;
  const first = node.firstChild;
  if (!first || first.type.name !== 'paragraph') return null;
  const text = first.firstChild;
  if (!text?.isText) return null;
  const m = CALLOUT_MARKER.exec(text.text);
  return m ? { type: m[1], length: m[0].length } : null;
}

/**
 * Undo the serializer's escape of a callout marker. Applied to freshly serialized
 * blocks only. Unescaping is harmless even outside a callout: `[!NOTE]` with no
 * matching link definition is literal text either way.
 * @param {string} md
 */
export function restoreCalloutMarkers(md) {
  return md.replace(/^((?:[ \t]*>[ \t]?)+)\\\[!([A-Za-z][\w-]*)\]/gm, '$1[!$2]');
}

const key = new PluginKey('bmdCallout');

/**
 * Callout decorations in one top-level block (a callout can also sit inside a list).
 * @param {import('@milkdown/prose/model').Node} block
 * @param {number} blockPos
 */
function decorateBlock(block, blockPos) {
  const decos = [];
  visit(block, blockPos);
  block.descendants((node, pos) => visit(node, blockPos + 1 + pos));
  return decos;

  function visit(node, pos) {
    const info = calloutInfo(node);
    if (!info) return true;

    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'bmd-callout',
        'data-callout': info.type.toLowerCase(),
      }),
    );

    // pos → blockquote, +1 → paragraph, +2 → first character of the marker.
    const start = pos + 2;
    const typeEnd = start + 2 + info.type.length;
    decos.push(
      Decoration.inline(start, start + info.length, { class: 'bmd-callout-marker' }),
      Decoration.inline(start, start + 2, { class: 'bmd-callout-punct' }),
      Decoration.inline(typeEnd, start + info.length, { class: 'bmd-callout-punct' }),
    );

    // The line break after the marker line is a soft break in the source, which
    // Milkdown renders as a space. Inside a callout it has to read as a real break,
    // or the title and the body run together on one line.
    const para = node.firstChild;
    let offset = pos + 2;
    for (let i = 0; i < para.childCount; i++) {
      const child = para.child(i);
      if (child.type.name === 'hardbreak') {
        decos.push(Decoration.node(offset, offset + 1, { class: 'bmd-callout-break' }));
        break;
      }
      offset += child.nodeSize;
    }
    return true;
  }
}

const decorations = blockwise(decorateBlock);
/** Every callout decoration in `doc` (tests compare the incremental set to this). */
export const buildDecorations = decorations.all;

export const calloutPlugin = $prose(
  () =>
    new Plugin({
      key,
      state: { init: decorations.init, apply: decorations.apply },
      props: {
        decorations: (state) => key.getState(state),
      },
    }),
);
