/**
 * Integration tests: run Milkdown for real and check the alignment invariant.
 *
 * The unit tests above use hand-built type sequences; these use sequences produced by
 * an actual editor. Both matter — unit tests prove the logic is right, integration
 * tests prove our **assumptions about Milkdown** still hold. If a Milkdown upgrade
 * renames a node type, it has to surface here rather than in a user's files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { MdDoc } from '../src/splice.js';
import { buildMapping, guardSave } from '../src/mapping.js';
import { reconcileByIdentity, toSavePlan } from '../src/reconcile.js';
import { fixtures } from './fixtures.js';

// ——— jsdom environment ———
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, writable: true, configurable: true,
});
for (const k of ['DOMParser','Node','Element','HTMLElement','Text','MutationObserver','getComputedStyle','Event','CustomEvent']) {
  globalThis[k] = dom.window[k];
}
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { Editor, rootCtx, defaultValueCtx, editorViewCtx } = await import('@milkdown/kit/core');
const { commonmark } = await import('@milkdown/kit/preset/commonmark');
const { gfm } = await import('@milkdown/kit/preset/gfm');
const { alignmentPlugins, readTopLevelTypes, readTopLevelNodes } =
  await import('../src/milkdown-adapter.js');

/** Load markdown into an editor and read back what it produced. */
async function load(body) {
  const root = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, body); })
    .use(commonmark).use(gfm).use(alignmentPlugins)
    .create();
  let types = [], nodes = [];
  editor.action((ctx) => { types = readTopLevelTypes(ctx); nodes = readTopLevelNodes(ctx); });
  return {
    editor, types, nodes,
    async dispose() { await editor.destroy(); root.remove(); },
  };
}

test('integration · alignment invariant across fixtures', async (t) => {
  for (const { name, src, why } of fixtures) {
    await t.test(`${name} — ${why}`, async () => {
      const doc = new MdDoc(src);
      const ed = await load(doc.body);
      try {
        const mapping = buildMapping(doc.blocks, ed.types);
        assert.equal(mapping.ok, true, mapping.ok ? '' : `${mapping.reason}: ${mapping.detail}`);
        assert.equal(mapping.pmToBlock.length, ed.types.length);
      } finally {
        await ed.dispose();
      }
    });
  }
});

test('integration · front matter tokenizes identically on both sides', async () => {
  // Regression lock: without remark-frontmatter the editor reads `---` as a thematic
  // break and skews against the splice layer's single yaml node.
  const src = '---\ntitle: Test\ntags: [a, b]\n---\n\n# Body\n\nSome text.\n';
  const doc = new MdDoc(src);
  const ed = await load(doc.body);
  try {
    assert.deepEqual(ed.types, ['frontmatter', 'heading', 'paragraph']);
    const mapping = buildMapping(doc.blocks, ed.types);
    assert.equal(mapping.ok, true, mapping.ok ? '' : mapping.detail);
  } finally {
    await ed.dispose();
  }
});

test('integration · the safety gate actually fires (deliberate skew)', async () => {
  // The most important assertion in the whole suite: not that aligned input works,
  // but that misaligned input is stopped. Omit alignmentPlugins on purpose.
  const src = '---\ntitle: Test\n---\n\n# Body\n';
  const doc = new MdDoc(src);

  const root = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, doc.body); })
    .use(commonmark).use(gfm)   // ← alignmentPlugins deliberately omitted
    .create();
  try {
    let types = [];
    editor.action((ctx) => { types = readTopLevelTypes(ctx); });

    const mapping = buildMapping(doc.blocks, types);
    assert.equal(mapping.ok, false, 'skew went undetected — the safety gate is broken');
    assert.ok(
      mapping.reason === 'count-skew' || mapping.reason === 'type-mismatch',
      `expected count-skew or type-mismatch, got ${mapping.reason}`,
    );

    const g = guardSave(mapping);
    assert.equal(g.safe, false);
    assert.equal(g.strategy, 'full-reserialize', 'must degrade, never keep writing by position');
  } finally {
    await editor.destroy();
    root.remove();
  }
});

test('integration · link definitions are absent from PM but never lost', async () => {
  const src = 'Para with [x][a].\n\n[a]: https://example.com/a\n\nAnother para.\n';
  const doc = new MdDoc(src);
  const ed = await load(doc.body);
  try {
    assert.equal(ed.types.length, 2, 'the editor should see only two paragraphs');
    assert.equal(doc.blocks.length, 3, 'the splice layer should see three blocks');

    const mapping = buildMapping(doc.blocks, ed.types);
    assert.equal(mapping.ok, true);
    assert.deepEqual(mapping.pmToBlock, [0, 2]);

    // Saving without edits keeps the definition and the bytes.
    assert.equal(doc.save(), src);
  } finally {
    await ed.dispose();
  }
});

test('integration · alignment across the real-world corpus', async (t) => {
  const dir = join(process.cwd(), 'test', 'corpus');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  if (files.length === 0) {
    t.skip('corpus not fetched — run npm run corpus');
    return;
  }
  for (const f of files) {
    await t.test(f, async () => {
      const doc = new MdDoc(readFileSync(join(dir, f), 'utf8'));
      const ed = await load(doc.body);
      try {
        const mapping = buildMapping(doc.blocks, ed.types);
        assert.equal(mapping.ok, true, mapping.ok ? '' : `${mapping.reason}\n${mapping.detail}`);
      } finally {
        await ed.dispose();
      }
    });
  }
});

test('integration · end-to-end drag: mapping, reconciliation and splicing', async () => {
  // Non-canonical spellings throughout, so any normalization is immediately visible.
  const src = [
    'A setext heading', '================', '',
    'A paragraph using _underscores_ for emphasis.', '',
    '[ref]: https://example.com/ref', '',
    '- dash bullet one', '- dash bullet two', '',
    '~~~python', 'x = 1', '~~~', '',
  ].join('\n');

  const doc = new MdDoc(src);
  const ed = await load(doc.body);
  try {
    const mapping = buildMapping(doc.blocks, ed.types);
    assert.equal(mapping.ok, true, mapping.ok ? '' : mapping.detail);

    const oldNodes = ed.nodes;
    // Drag the first visible paragraph to the end.
    let newNodes;
    ed.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const d = view.state.doc;
      const posOf = (i) => { let s = 0; for (let k = 0; k < i; k++) s += d.child(k).nodeSize; return s; };
      const node = d.child(1);
      const tr = view.state.tr;
      tr.delete(posOf(1), posOf(1) + node.nodeSize);
      tr.insert(tr.mapping.map(d.content.size), node);
      view.dispatch(tr);
      newNodes = [];
      view.state.doc.forEach((n) => newNodes.push(n));
    });

    const plan = reconcileByIdentity(oldNodes, newNodes);
    assert.equal(plan.filter((p) => p.fromOld === null).length, 0, 'a pure reorder creates no new content');

    const { visibleOrder } = toSavePlan(plan, mapping.pmToBlock);
    const out = doc.save({ visibleOrder });

    assert.match(out, /A setext heading\n=+/, 'setext heading was rewritten');
    assert.match(out, /_underscores_/, 'underscore emphasis was rewritten');
    assert.match(out, /^- dash bullet one$/m, 'bullet character was rewritten');
    assert.match(out, /~~~python/, 'tilde fence was rewritten');
    assert.match(out, /\[ref\]: https:\/\/example\.com\/ref/, 'link definition was lost');

    const norm = (s) => s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).sort().join('|');
    assert.equal(norm(out), norm(src), 'reordering changed block contents');
  } finally {
    await ed.dispose();
  }
});
