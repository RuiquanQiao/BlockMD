/**
 * Decorations kept up to date block by block, instead of rebuilt for the whole document
 * on every keystroke.
 *
 * Callouts, code highlighting and media previews each used to walk the whole document
 * and hand ProseMirror a brand-new DecorationSet per transaction; ProseMirror then
 * compared every node's decorations to redraw. In a 3,000-block file that was most of
 * the time a keystroke took (parity/feel.json: typing-latency). Here the previous set
 * is mapped through the change and only the top-level blocks the transaction touched
 * are rebuilt. test/blockwise.test.js checks, over random edits, that the result is
 * always the same as a full rebuild.
 */

import { DecorationSet } from '@milkdown/prose/view';

/**
 * The top-level blocks a transaction changed, as [from, to] ranges of the new document
 * on block boundaries — or null when that can't be told (then rebuild everything).
 * @param {import('@milkdown/prose/state').Transaction} tr
 */
export function touchedBlocks(tr) {
  // Mapping every range through every later step is quadratic in the step count; a
  // transaction with many steps (one per heading, say) is cheaper to rebuild whole.
  if (tr.steps.length > 32) throw touchedBlocks.unknown;
  let ranges = [];
  tr.steps.forEach((step, i) => {
    const map = tr.mapping.maps[i];
    ranges = ranges.map(([a, b]) => [map.map(a, -1), map.map(b, 1)]);
    map.forEach((_oldStart, _oldEnd, start, end) => ranges.push([start, end]));
    // Steps that change content without moving it have an empty map: marks (a link
    // added makes a media preview) and node attributes (a code block's language).
    if (typeof step.from === 'number' && typeof step.to === 'number') ranges.push([map.map(step.from, -1), map.map(step.to, 1)]);
    else if (typeof step.pos === 'number') ranges.push([map.map(step.pos, 1), map.map(step.pos, 1) + 1]);
    else throw touchedBlocks.unknown; // e.g. a document attribute: no position to go by
  });
  const { doc } = tr;
  const size = doc.content.size;
  const clamp = (p) => Math.max(0, Math.min(p, size));
  // Widen to whole top-level blocks; between two blocks, take both neighbours.
  const start = (p) => {
    const $p = doc.resolve(clamp(p));
    if ($p.depth > 0) return $p.before(1);
    return $p.nodeBefore ? $p.pos - $p.nodeBefore.nodeSize : $p.pos;
  };
  const end = (p) => {
    const $p = doc.resolve(clamp(p));
    if ($p.depth > 0) return $p.after(1);
    return $p.nodeAfter ? $p.pos + $p.nodeAfter.nodeSize : $p.pos;
  };
  const wide = ranges.map(([a, b]) => [start(Math.min(a, b)), end(Math.max(a, b))]).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of wide) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
touchedBlocks.unknown = Symbol('unknown change');

/**
 * Plugin state for decorations computed per top-level block.
 * @param {(node: import('@milkdown/prose/model').Node, pos: number) => import('@milkdown/prose/view').Decoration[]} decorate
 *   Decorations for one top-level block at `pos` (including anything nested in it).
 */
export function blockwise(decorate) {
  const all = (doc) => {
    const decos = [];
    doc.forEach((node, pos) => { decos.push(...decorate(node, pos)); });
    return DecorationSet.create(doc, decos);
  };
  return {
    init: (_config, state) => all(state.doc),
    apply(tr, set) {
      if (!tr.docChanged) return set;
      let blocks;
      try { blocks = touchedBlocks(tr); } catch (e) { if (e === touchedBlocks.unknown) return all(tr.doc); throw e; }
      set = set.map(tr.mapping, tr.doc);
      for (const [from, to] of blocks) {
        // What these blocks own: everything inside them, but not a widget sitting on the
        // boundary at `from` — that one ends the block before (media previews).
        const stale = set.find(from, to).filter((d) => d.from >= from && d.to <= to && !(d.from === d.to && d.from === from && from > 0));
        const fresh = [];
        tr.doc.nodesBetween(from, to, (node, pos) => {
          if (pos >= from && pos + node.nodeSize <= to) fresh.push(...decorate(node, pos));
          return false;
        });
        set = set.remove(stale).add(tr.doc, fresh);
      }
      return set;
    },
    all,
  };
}
