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
import { Decoration, DecorationSet } from '@milkdown/prose/view';

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

/** @param {import('@milkdown/prose/model').Node} doc */
function buildDecorations(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
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
  });
  return DecorationSet.create(doc, decos);
}

export const calloutPlugin = $prose(
  () =>
    new Plugin({
      key,
      state: {
        init: (_config, state) => buildDecorations(state.doc),
        apply: (tr, prev) => (tr.docChanged ? buildDecorations(tr.doc) : prev),
      },
      props: {
        decorations: (state) => key.getState(state),
      },
    }),
);
