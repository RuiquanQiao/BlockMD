/**
 * Block commands (Turn into / Duplicate / Delete) and callouts, run in a real Milkdown.
 *
 * What these lock down is fidelity, not UI: a block command must leave every *other*
 * block's original bytes alone, and a new callout must save as `> [!NOTE]`, which
 * GitHub and Obsidian recognise — not the serializer's escaped `> \[!NOTE]`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

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
const { alignmentPlugins } = await import('../src/milkdown-adapter.js');
const { calloutPlugin, calloutInfo, restoreCalloutMarkers } = await import('../app/editor/callout.js');
const { turnInto, duplicateBlock, deleteBlock, blockAtSelection, currentType } =
  await import('../app/editor/block-types.js');
const { DocumentSession } = await import('../app/session.js');
const { TextSelection } = await import('@milkdown/prose/state');

/** Open `src` the way the app does: editor + session over the same bytes. */
async function open(src) {
  const session = new DocumentSession(src);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, session.doc.body); })
    .use(commonmark).use(gfm).use(alignmentPlugins).use(calloutPlugin)
    .create();
  let view;
  editor.action((ctx) => {
    view = ctx.get(editorViewCtx);
    session.attach(ctx);
  });
  /** Top-level block `i` as a command target. */
  const block = (i) => {
    let pos = 0;
    for (let k = 0; k < i; k++) pos += view.state.doc.child(k).nodeSize;
    return { pos, node: view.state.doc.child(i) };
  };
  return {
    view, session, block,
    async dispose() { await editor.destroy(); root.remove(); },
  };
}

test('callout · a new callout saves as GitHub alert syntax, unescaped', async () => {
  const ed = await open('Intro\n\nImportant thing\n');
  try {
    turnInto(ed.view, ed.block(1), 'callout');
    assert.equal(ed.session.save(), 'Intro\n\n> [!NOTE]\n> Important thing\n');
    assert.equal(calloutInfo(ed.view.state.doc.child(1))?.type, 'NOTE');
  } finally {
    await ed.dispose();
  }
});

test('callout · an existing callout keeps its bytes and is recognised', async () => {
  const src = '> [!WARNING]\r\n> Mind the gap\r\n\r\nAfter\r\n';
  const ed = await open(src);
  try {
    assert.equal(calloutInfo(ed.view.state.doc.child(0))?.type, 'WARNING');
    assert.equal(ed.session.save(), src);
  } finally {
    await ed.dispose();
  }
});

test('callout · turning a callout back into text drops the marker', async () => {
  const ed = await open('> [!TIP]\n> Use the handle\n');
  try {
    turnInto(ed.view, ed.block(0), 'text');
    assert.equal(ed.session.save(), 'Use the handle\n');
  } finally {
    await ed.dispose();
  }
});

test('callout · restoreCalloutMarkers only touches quoted markers', () => {
  assert.equal(restoreCalloutMarkers('> \\[!NOTE]\n> x\n'), '> [!NOTE]\n> x\n');
  assert.equal(restoreCalloutMarkers('> > \\[!tip]\n'), '> > [!tip]\n');
  assert.equal(restoreCalloutMarkers('\\[!NOTE] not quoted\n'), '\\[!NOTE] not quoted\n');
});

test('turn into · other blocks keep their original bytes', async () => {
  // `*` bullets and `__strong__` would both be normalized if re-serialized.
  const src = '* one\n* two\n\nturn me\n\n__keep__ me\n';
  const ed = await open(src);
  try {
    turnInto(ed.view, ed.block(1), 'h2');
    assert.equal(ed.session.save(), '* one\n* two\n\n## turn me\n\n__keep__ me\n');
  } finally {
    await ed.dispose();
  }
});

test('turn into · a list item lifts out of its list', async () => {
  const ed = await open('- a\n- b\n- c\n');
  try {
    const list = ed.block(0);
    const second = { pos: list.pos + 1 + list.node.child(0).nodeSize, node: list.node.child(1) };
    turnInto(ed.view, second, 'h1');
    const types = [];
    ed.view.state.doc.forEach((n) => types.push(n.type.name));
    assert.deepEqual(types, ['bullet_list', 'heading', 'bullet_list']);
    assert.equal(ed.view.state.doc.child(1).textContent, 'b');
  } finally {
    await ed.dispose();
  }
});

test('turn into · bullet item toggles to a task in place', async () => {
  const ed = await open('- a\n- b\n');
  try {
    const list = ed.block(0);
    const first = { pos: list.pos + 1, node: list.node.child(0) };
    turnInto(ed.view, first, 'todo');
    assert.equal(ed.view.state.doc.childCount, 1);
    assert.equal(ed.view.state.doc.child(0).child(0).attrs.checked, false);
    assert.equal(ed.view.state.doc.child(0).child(1).attrs.checked, null);
  } finally {
    await ed.dispose();
  }
});

test('turn into · slash target for a list item is the item, for a lone quote the quote', async () => {
  const ed = await open('- item\n\n> quoted\n');
  try {
    const { view } = ed;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    assert.equal(blockAtSelection(view.state).node.type.name, 'list_item');
    const quote = ed.block(1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, quote.pos + 3)));
    const target = blockAtSelection(view.state);
    assert.equal(target.node.type.name, 'blockquote');
    assert.equal(currentType(view.state, target), 'quote');
  } finally {
    await ed.dispose();
  }
});

test('duplicate · the original keeps its bytes, only the copy is new', async () => {
  const src = '* x\n* y\n\nend\n';
  const ed = await open(src);
  try {
    duplicateBlock(ed.view, ed.block(0));
    const plan = ed.session.plan();
    assert.equal(plan.reused, 2);
    assert.equal(plan.fresh, 1);
    assert.ok(ed.session.save().startsWith('* x\n* y\n'));
  } finally {
    await ed.dispose();
  }
});

test('delete · removes exactly that block', async () => {
  const src = 'a\r\n\r\nb\r\n\r\nc\r\n';
  const ed = await open(src);
  try {
    deleteBlock(ed.view, ed.block(1));
    assert.equal(ed.session.save(), 'a\r\n\r\nc\r\n');
  } finally {
    await ed.dispose();
  }
});

test('delete · the last list item takes its list along; the last block leaves a paragraph', async () => {
  const ed = await open('- only\n');
  try {
    const list = ed.block(0);
    deleteBlock(ed.view, { pos: list.pos + 1, node: list.node.child(0) });
    assert.equal(ed.view.state.doc.childCount, 1);
    assert.equal(ed.view.state.doc.child(0).type.name, 'paragraph');
  } finally {
    await ed.dispose();
  }
});

// ——— An edited block is rewritten, but in the author's style ———
// Milkdown's serializer always writes `*` bullets. Before this was fixed, ticking one
// checkbox (or fixing a typo) in a `-` list rewrote every bullet in that list.

test('edit · ticking a task keeps the list\'s `-` bullets', async () => {
  const ed = await open('# T\n\n- [ ] a\n- [x] b\n\nend\n');
  try {
    const list = ed.block(1);
    const item = list.node.child(0);
    ed.view.dispatch(ed.view.state.tr.setNodeMarkup(list.pos + 1, undefined, { ...item.attrs, checked: true }));
    assert.equal(ed.session.save(), '# T\n\n- [x] a\n- [x] b\n\nend\n');
  } finally {
    await ed.dispose();
  }
});

test('edit · typing in a `-` list keeps `-`; typing in a `+` list keeps `+`', async () => {
  for (const bullet of ['-', '+']) {
    const ed = await open(`${bullet} one\n${bullet} two\n`);
    try {
      ed.view.dispatch(ed.view.state.tr.insertText('!', 6)); // after "one"
      assert.equal(ed.session.save(), `${bullet} one!\n${bullet} two\n`);
    } finally {
      await ed.dispose();
    }
  }
});

test('edit · a brand-new list follows the document\'s bullet style', async () => {
  const ed = await open('- a\n\ntext\n');
  try {
    const { schema } = ed.view.state;
    const list = schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(null, [schema.nodes.paragraph.create(null, schema.text('new'))]),
    ]);
    ed.view.dispatch(ed.view.state.tr.insert(ed.view.state.doc.content.size, list));
    assert.equal(ed.session.save(), '- a\n\ntext\n\n- new\n');
  } finally {
    await ed.dispose();
  }
});

// ——— Math: `$…$` and `$$…$$` are math nodes, and keep their bytes ———

test('math · parsed as math nodes on the editor side', async () => {
  const ed = await open('Inline $E=mc^2$ here.\n\n$$\na^2 + b^2 = c^2\n$$\n');
  try {
    const types = [];
    ed.view.state.doc.descendants((n) => { types.push(n.type.name); });
    assert.ok(types.includes('math_inline'), 'no math_inline in ' + types.join(','));
    assert.ok(types.includes('math_block'), 'no math_block in ' + types.join(','));
    assert.equal(ed.session.status().identical, true);
  } finally {
    await ed.dispose();
  }
});

test('math · editing text beside math keeps the math bytes', async () => {
  const src = 'Inline $E=mc^2$ here.\n\n$$\na^2 + b^2 = c^2\n$$\n';
  const ed = await open(src);
  try {
    ed.view.dispatch(ed.view.state.tr.insertText('!', 'Inline'.length + 1));
    assert.equal(ed.session.save(), src.replace('Inline', 'Inline!'));
  } finally {
    await ed.dispose();
  }
});

test('math · a new equation saves as $…$ and $$…$$', async () => {
  const ed = await open('text\n');
  try {
    const { schema } = ed.view.state;
    const para = schema.nodes.paragraph.create(null, [schema.text('see '), schema.nodes.math_inline.create({ value: 'x^2' })]);
    const block = schema.nodes.math_block.create({ value: '\int_0^1 x\,dx' });
    ed.view.dispatch(ed.view.state.tr.insert(ed.view.state.doc.content.size, [para, block]));
    assert.equal(ed.session.save(), 'text\n\nsee $x^2$\n\n$$\n\int_0^1 x\,dx\n$$\n');
  } finally {
    await ed.dispose();
  }
});
