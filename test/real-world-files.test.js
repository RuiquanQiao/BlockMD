/**
 * Real-world files: what people actually open, not what a Markdown spec example looks
 * like. A new file is empty; a .txt renamed to .md has CRLF and no Markdown at all; a
 * file may be only link definitions, only a BOM, or never closed its code fence.
 *
 * The first entry here is the bug that motivated the file: an empty .md failed the
 * block mapping (0 blocks on disk, 1 empty paragraph in the editor), and the app
 * refused to save — the most basic case of all had never been opened.
 *
 * Every case must (1) map, (2) save byte-identical when untouched, and (3) keep what
 * the user types. Like test/fixtures.js, sources are string literals so git cannot
 * normalise their line endings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
for (const k of ['DOMParser', 'Node', 'Element', 'HTMLElement', 'Text', 'MutationObserver', 'getComputedStyle', 'Event', 'CustomEvent']) {
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
const { DocumentSession } = await import('../app/session.js');
const { decodeFile } = await import('../app/platform.js');

const CASES = [
  ['empty file (a brand-new .md)', ''],
  ['one newline', '\n'],
  ['only blank lines', '\n\n\n'],
  ['only spaces and a tab', '   \n\t\n'],
  ['CRLF blank line', '\r\n'],
  ['only a BOM', '﻿'],
  ['BOM and CRLF', '﻿\r\n'],
  ['only link definitions', '[a]: https://example.com/a\n[b]: https://example.com/b\n'],
  ['only front matter', '---\ntitle: x\n---\n'],
  ['only an HTML comment', '<!-- nothing here -->\n'],
  ['a .txt renamed to .md (CRLF, no Markdown)', 'Meeting notes\r\nBring the laptop\r\nCall Anna at 3\r\n'],
  ['one line, no final newline', 'hello'],
  ['mixed line endings', 'a\r\nb\nc\r\n'],
  ['tab-indented text (becomes a code block)', '\tindented\n'],
  ['an unclosed code fence', '```js\nconst a = 1;\n'],
  ['an unclosed <details>', '<details>\n<summary>x</summary>\n\nbody\n'],
  ['a lone # and a lone -', '#\n\n-\n'],
  ['Chinese, emoji and full-width punctuation', '# 笔记\n\n今天很开心😀，明天见！\n'],
  ['trailing spaces (a hard break) and a NUL', 'line one  \nline two\n\nnul\u0000here\n'],
];

async function open(src) {
  const session = new DocumentSession(src);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, session.doc.body); })
    .use(commonmark).use(gfm).use(alignmentPlugins)
    .create();
  let view;
  editor.action((ctx) => { view = ctx.get(editorViewCtx); session.attach(ctx); });
  return { session, view, async dispose() { await editor.destroy(); root.remove(); } };
}

for (const [name, src] of CASES) {
  test(`real-world file · ${name}`, async () => {
    const ed = await open(src);
    try {
      const s = ed.session.status();
      assert.equal(s.ok, true, `mapping failed: ${s.message}`);
      assert.equal(s.identical, true, 'untouched file is not byte-identical');
      assert.equal(ed.session.save(), src);

      // Type at the very end: it must be kept, and the file must still map.
      const end = ed.view.state.doc.content.size - 1;
      ed.view.dispatch(ed.view.state.tr.insertText('XYZ', Math.max(1, end)));
      const out = ed.session.save();
      assert.ok(out.includes('XYZ'), 'typed text lost: ' + JSON.stringify(out));
      assert.equal(ed.session.status().ok, true);
    } finally {
      await ed.dispose();
    }
  });
}

test('real-world file · a large file (5,000 paragraphs) opens and saves quickly', async () => {
  const src = Array.from({ length: 5000 }, (_, i) => `Paragraph ${i} with some **bold** text.`).join('\n\n') + '\n';
  const t0 = performance.now();
  const ed = await open(src);
  try {
    assert.equal(ed.session.save(), src);
    const ms = performance.now() - t0;
    assert.ok(ms < 15000, `took ${Math.round(ms)} ms`);
  } finally {
    await ed.dispose();
  }
});

test('real-world file · invalid UTF-8 is refused with a clear message, not garbled', () => {
  const gbk = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]); // "你好" in GBK
  assert.throws(() => decodeFile(gbk), /not valid UTF-8/);
});
