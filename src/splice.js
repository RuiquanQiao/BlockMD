/**
 * Surgical splice layer.
 *
 * Core principle: the AST is used to **locate** blocks, never to **produce** output.
 * Untouched blocks are copied byte-for-byte from the source; only edited blocks are
 * re-serialized.
 *
 * This module has no ProseMirror dependency and can be tested standalone.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { parseOptions, serializeExtensions } from './remark-config.js';
import { HIDDEN_MDAST_TYPES } from './mapping.js';

const BOM = '﻿';

/**
 * mdast top-level types the editor does not render.
 * Canonical definition lives in `mapping.js`; re-exported here for convenience.
 */
export const DEFAULT_HIDDEN_TYPES = HIDDEN_MDAST_TYPES;

/**
 * Infer serializer options from a block's original bytes so that re-serializing it
 * stays as close to the author's style as possible.
 *
 * Measured effect: raises the share of blocks that survive re-serialization
 * byte-identical from 37/54 to 46/54.
 *
 * @param {string} raw The block's original text in the source document
 */
export function inferOptions(raw) {
  const o = {};

  // Bullet style: search the whole block, so nested lists inside blockquotes count.
  const bullet = raw.match(/(?:^|\n)\s*(?:>\s*)*([-*+])\s/);
  if (bullet) o.bullet = bullet[1];
  const ordered = raw.match(/(?:^|\n)\s*(?:>\s*)*\d+([.)])\s/);
  if (ordered) o.bulletOrdered = ordered[1];
  o.listItemIndent = 'one';

  // Heading style
  if (/[^\n]\n\s*(=+|-+)\s*$/.test(raw)) o.setext = true;
  else if (/^#{1,6}\s.*#\s*$/m.test(raw)) o.closeAtx = true;

  // Code fences
  if (/^~~~/m.test(raw)) o.fence = '~';
  if (/^(?: {4}|\t)/.test(raw) && !/^(```|~~~)/m.test(raw)) o.fences = false;

  // Thematic breaks
  const rule = raw.match(/^\s*([-*_])(?:\s*\1){2,}\s*$/m);
  if (rule) {
    o.rule = rule[1];
    o.ruleRepetition = Math.max(3, (raw.match(/[-*_]/g) || []).length);
    o.ruleSpaces = /[-*_]\s+[-*_]/.test(raw);
  }

  // Emphasis markers: whichever form is more frequent within this block wins.
  const uEm = (raw.match(/(?<![\w_])_(?!_)[^_\n]+_(?![\w_])/g) || []).length;
  const sEm = (raw.match(/(?<![\w*])\*(?!\*)[^*\n]+\*(?![\w*])/g) || []).length;
  if (uEm > sEm) o.emphasis = '_';
  const uSt = (raw.match(/__[^_\n]+__/g) || []).length;
  const sSt = (raw.match(/\*\*[^*\n]+\*\*/g) || []).length;
  if (uSt > sSt) o.strong = '_';

  return o;
}

/**
 * A Markdown document as seen by the splice layer.
 *
 * Three details carry the byte safety:
 *   1. The BOM must be stripped before parsing — otherwise every offset shifts by one
 *      and node boundaries silently cut off the last character.
 *   2. Parsing happens on LF; the original EOL style is restored on output.
 *   3. Inter-block gaps are keyed by **position**, not carried by the blocks.
 *      Carrying them would let `C\n` + `A\n\n` glue two blocks into one.
 */
export class MdDoc {
  /**
   * @param {string} source Raw file contents
   * @param {{hiddenTypes?: string[]}} [opts]
   */
  constructor(source, opts = {}) {
    this.hiddenTypes = opts.hiddenTypes ?? DEFAULT_HIDDEN_TYPES;

    this.bom = source.startsWith(BOM) ? BOM : '';
    const raw = this.bom ? source.slice(1) : source;

    // If CRLF appears anywhere, restore CRLF on save.
    this.eol = raw.includes('\r\n') ? '\r\n' : '\n';
    this.body = raw.replace(/\r\n/g, '\n');

    this.tree = fromMarkdown(this.body, parseOptions());

    /** @type {{node:object,start:number,end:number,hidden:boolean,precedingVisible:number}[]} */
    this.blocks = [];
    let visibleSeen = 0;
    for (const node of this.tree.children) {
      if (node.position?.start?.offset === undefined) continue;
      const hidden = this.hiddenTypes.includes(node.type);
      this.blocks.push({
        node,
        start: node.position.start.offset,
        end: node.position.end.offset,
        hidden,
        // Hidden blocks remember how many visible blocks preceded them (see placeHidden).
        precedingVisible: visibleSeen,
      });
      if (!hidden) visibleSeen++;
    }

    // gaps[i] is the text before block i; gaps[n] is the trailing remainder.
    this.gaps = [];
    let cursor = 0;
    for (const b of this.blocks) {
      this.gaps.push(this.body.slice(cursor, b.start));
      cursor = b.end;
    }
    this.gaps.push(this.body.slice(cursor));
  }

  /** Original bytes of block i. */
  sourceOf(i) {
    const b = this.blocks[i];
    return this.body.slice(b.start, b.end);
  }

  /** Indices of blocks the editor can see. */
  visibleIndices() {
    return this.blocks.map((b, i) => (b.hidden ? -1 : i)).filter((i) => i >= 0);
  }

  /** Indices of blocks the editor never renders. */
  hiddenIndices() {
    return this.blocks.map((b, i) => (b.hidden ? i : -1)).filter((i) => i >= 0);
  }

  /**
   * Produce the final file contents.
   *
   * @param {object} [plan]
   * @param {(number|{text:string})[]} [plan.visibleOrder] New sequence of visible
   *   blocks. A number reuses that block's original bytes; `{text}` inserts brand new
   *   content (a block the user just created has no original bytes to reuse, so only
   *   the editor can supply it). Omitted means the original order. Hidden blocks are
   *   woven back in by `placeHidden`.
   * @param {Iterable<number>} [plan.dirty] Block indices to re-serialize
   * @param {Map<number, object>} [plan.nodes] Replacement mdast nodes, keyed by index
   * @returns {string}
   */
  save(plan = {}) {
    const dirty = new Set(plan.dirty ?? []);
    const nodes = plan.nodes ?? new Map();

    const order = plan.visibleOrder
      ? placeHidden(plan.visibleOrder, this.blocks)
      : this.blocks.map((_, i) => i);

    const unchangedOrder = order.length === this.blocks.length && order.every((v, i) => v === i);

    // Fast path: nothing moved and nothing is dirty, so return the source untouched.
    // Byte identity here is guaranteed by construction.
    if (unchangedOrder && dirty.size === 0) {
      return this.bom + this.restoreEol(this.body);
    }

    let out = '';
    for (let slot = 0; slot < order.length; slot++) {
      // Gaps are taken by output position; beyond the original count, use a blank line.
      out += slot < this.gaps.length - 1 ? this.gaps[slot] : slot === 0 ? '' : '\n\n';

      const entry = order[slot];

      // Brand new content: no original bytes exist, so take the editor's text.
      if (entry !== null && typeof entry === 'object') {
        out += String(entry.text ?? '').replace(/\n+$/, '');
        continue;
      }

      const i = entry;
      if (dirty.has(i)) {
        const node = nodes.get(i) ?? this.blocks[i].node;
        out += toMarkdown(node, {
          extensions: serializeExtensions(),
          ...inferOptions(this.sourceOf(i)),
        }).replace(/\n$/, '');
      } else {
        out += this.sourceOf(i);
      }
    }
    out += this.gaps[this.gaps.length - 1];

    return this.bom + this.restoreEol(out);
  }

  /** @param {string} s */
  restoreEol(s) {
    return this.eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s;
  }
}

/**
 * Weave hidden blocks back into a reordered sequence of visible blocks.
 *
 * Rule — **stay at the original relative position**: each hidden block remembers how
 * many visible blocks preceded it in the source (N) and is re-inserted after the Nth
 * visible block. It does not follow any particular block around.
 *
 * Why not "anchor to the preceding visible block": READMEs commonly stack every link
 * definition at the end of the file. Anchoring would attach them all to the last
 * visible block, so dragging that one paragraph to the top would drag every link
 * definition with it.
 *
 * @param {(number|{text:string})[]} visibleOrder New order of visible blocks
 * @param {{hidden:boolean,precedingVisible:number}[]} blocks All blocks
 * @returns {(number|{text:string})[]} Full output order
 */
export function placeHidden(visibleOrder, blocks) {
  const hidden = blocks
    .map((b, i) => ({ i, ...b }))
    .filter((b) => b.hidden)
    .sort((a, b) => a.precedingVisible - b.precedingVisible || a.i - b.i);

  const out = [];
  let vi = 0;
  let hi = 0;
  while (vi < visibleOrder.length || hi < hidden.length) {
    if (hi < hidden.length && hidden[hi].precedingVisible <= vi) {
      out.push(hidden[hi++].i);
    } else if (vi < visibleOrder.length) {
      out.push(visibleOrder[vi++]);
    } else {
      out.push(hidden[hi++].i);
    }
  }
  return out;
}
