/**
 * Decorations updated block by block (app/editor/blockwise.js) must always equal a
 * full rebuild. The incremental version is what makes typing in a big file fast; the
 * risk it brings is a stale highlight or a callout that stops rendering after some
 * particular edit. So: hundreds of random edits of every kind, in a real Milkdown, and
 * after each one the three plugins' sets are compared with a from-scratch build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
for (const k of ['DOMParser', 'Node', 'Element', 'HTMLElement', 'Text', 'MutationObserver', 'getComputedStyle', 'Event', 'CustomEvent']) globalThis[k] = dom.window[k];
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { Editor, rootCtx, defaultValueCtx, editorViewCtx } = await import('@milkdown/kit/core');
const { commonmark } = await import('@milkdown/kit/preset/commonmark');
const { gfm } = await import('@milkdown/kit/preset/gfm');
const { alignmentPlugins } = await import('../src/milkdown-adapter.js');
const { calloutPlugin, buildDecorations } = await import('../app/editor/callout.js');
const { highlightPlugin, buildHighlights } = await import('../app/editor/highlight.js');
const { mediaPlugin, buildPreviews } = await import('../app/editor/media.js');
const { touchedBlocks } = await import('../app/editor/blockwise.js');
const { TextSelection } = await import('@milkdown/prose/state');

const START = [
  '# Title', '',
  '> [!NOTE]', '> A callout', '> second line', '',
  'Plain paragraph with **bold** text.', '',
  '```js', 'const x = 1;', 'console.log(x);', '```', '',
  '- item one', '- item two', '',
  '  ```python', '  print("nested")', '  ```', '',
  '[A bookmark](https://example.com/page)', '',
  '> just a quote', '',
  '1. first', '2. second', '',
  '```', 'plain code', '```', '',
  'Last paragraph.', '',
].join('\n');

async function editor(md) {
  const root = document.createElement('div');
  document.body.append(root);
  const ed = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, md); })
    .use(commonmark).use(gfm).use(alignmentPlugins).use(calloutPlugin).use(highlightPlugin).use(mediaPlugin)
    .create();
  let view;
  ed.action((ctx) => { view = ctx.get(editorViewCtx); });
  return { view, async dispose() { await ed.destroy(); root.remove(); } };
}

/** A decoration set as comparable strings. */
function flat(set) {
  return set.find().map((d) => `${d.from}-${d.to} ${JSON.stringify(d.type.attrs ?? null)} ${d.spec?.key ?? ''}`).sort();
}
const pluginState = (state, name) => state.plugins.find((p) => p.key.startsWith(name + '$')).getState(state);

function check(state, label) {
  assert.deepEqual(flat(pluginState(state, 'bmdCallout')), flat(buildDecorations(state.doc)), `callouts after ${label}`);
  assert.deepEqual(flat(pluginState(state, 'bmdHighlight')), flat(buildHighlights(state.doc)), `highlighting after ${label}`);
  assert.deepEqual(flat(pluginState(state, 'bmdMedia')), flat(buildPreviews(state.doc)), `previews after ${label}`);
}

/** Small seeded PRNG so a failure can be replayed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function textPositions(doc) {
  const out = [];
  doc.descendants((node, pos) => { if (node.isTextblock) for (let i = 0; i <= node.content.size; i++) out.push(pos + 1 + i); });
  return out;
}

/** One random edit of the kinds a person makes. Returns [label, transaction] or null. */
function randomEdit(state, rand) {
  const { doc, schema } = state;
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const positions = textPositions(doc);
  const p = pick(positions);
  const tr = state.tr;
  switch (Math.floor(rand() * 11)) {
    case 0: return ['type', tr.insertText(pick(['a', ' ', 'x = 2;', '[!TIP] ', 'const ', '\n']), p)];
    case 1: { const q = Math.min(doc.content.size - 1, p + 1 + Math.floor(rand() * 12)); return ['delete (maybe across blocks)', tr.delete(Math.min(p, q), Math.max(p, q))]; }
    case 2: { const $p = doc.resolve(p); if (!$p.parent.isTextblock || $p.parent.type.spec.code) return null; return ['split block', tr.split(p)]; }
    case 3: { const q = Math.min(doc.content.size, p + 3); if (q <= p) return null; return ['add link', tr.addMark(p, q, schema.marks.link.create({ href: pick(['https://example.com/x', 'clip.mp4', 'note.pdf']) }))]; }
    case 4: return ['remove marks', tr.removeMark(0, doc.content.size, schema.marks.link)];
    case 5: {
      let at = null; doc.descendants((n, pos) => { if (at === null && n.type.name === 'code_block' && rand() < 0.5) at = pos; });
      if (at === null) return null;
      return ['change code language', tr.setNodeMarkup(at, undefined, { ...doc.nodeAt(at).attrs, language: pick(['js', 'python', '', 'rust']) })];
    }
    case 6: { const $p = doc.resolve(p); if ($p.depth !== 1) return null; return ['turn into code block', tr.setBlockType($p.before(1) + 1, $p.before(1) + 1, schema.nodes.code_block)]; }
    case 7: { const $p = doc.resolve(p); if ($p.depth !== 1 || !$p.parent.isTextblock) return null; const r = $p.blockRange(); return r ? ['wrap in quote', tr.wrap(r, [{ type: schema.nodes.blockquote }])] : null; }
    case 8: { const at = pick([0, doc.content.size]); return ['new bookmark paragraph', tr.insert(at, schema.nodes.paragraph.create(null, schema.text('site', [schema.marks.link.create({ href: 'https://example.org' })])))]; }
    case 9: { const $p = doc.resolve(p); if ($p.depth < 1 || $p.index(0) === 0) return null; const start = $p.before(1); return ['join with block above', tr.delete(start - 1, start + 1)]; }
    default: { const a = Math.floor(rand() * doc.childCount); let pos = 0; for (let i = 0; i < a; i++) pos += doc.child(i).nodeSize; return ['delete a whole block', tr.delete(pos, pos + doc.child(a).nodeSize)]; }
  }
}

test('incremental decorations equal a full rebuild after every random edit', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { view, dispose } = await editor(START);
    const rand = rng(seed);
    check(view.state, 'opening');
    let applied = 0;
    for (let i = 0; i < 400 && applied < 120; i++) {
      let step;
      try { step = randomEdit(view.state, rand); } catch { continue; } // an edit that doesn't fit here
      if (!step || !step[1].docChanged) continue;
      const [label, tr] = step;
      if (rand() < 0.3) tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, 1))));
      view.dispatch(tr);
      applied++;
      check(view.state, `${label} (seed ${seed}, edit ${applied})`);
    }
    assert.ok(applied >= 60, `seed ${seed}: only ${applied} edits applied`);
    await dispose();
  }
});

test('changes with no position (document attributes) fall back to a full rebuild', () => {
  // A fake transaction with one step of an unknown kind.
  const tr = { steps: [{}], mapping: { maps: [{ forEach() {}, map: (p) => p }] }, doc: null };
  assert.throws(() => touchedBlocks(tr), (e) => e === touchedBlocks.unknown);
});
