/**
 * The editor's first document, built from the splice layer's tree (app/editor/
 * reuse-parse.js), must be the same document Milkdown gets by parsing the text itself —
 * over every fixture and every real-world README. If this ever fails, the two parsers
 * disagree about some input: exactly what iron rule 2 forbids, found here instead of by
 * a user.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
const { reuseParse } = await import('../app/editor/reuse-parse.js');
const { MdDoc } = await import('../src/splice.js');
const { fixtures } = await import('./fixtures.js');

async function docOf(body, seed) {
  const root = document.createElement('div');
  document.body.append(root);
  let ed = Editor.make()
    .config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, body); })
    .use(commonmark).use(gfm).use(alignmentPlugins);
  if (seed) ed = ed.use(reuseParse(seed));
  ed = await ed.create();
  let doc;
  ed.action((ctx) => { doc = ctx.get(editorViewCtx).state.doc; });
  await ed.destroy();
  root.remove();
  return doc;
}

const CORPUS = join(import.meta.dirname, 'corpus');
const inputs = [
  ...fixtures.map((f) => [f.name, f.src]),
  ...(existsSync(CORPUS) ? readdirSync(CORPUS).filter((n) => n.endsWith('.md')).map((n) => [n, readFileSync(join(CORPUS, n), 'utf8')]) : []),
];

test('the reused tree gives the same editor document as a second parse', async () => {
  for (const [name, src] of inputs) {
    const md = new MdDoc(src);
    const seed = { text: md.body, tree: md.tree, used: false };
    const reused = await docOf(md.body, seed);
    assert.ok(seed.used, `${name}: the reused tree was not used`);
    const parsed = await docOf(md.body);
    // As JSON: each editor has its own schema, so Node.eq would never match.
    const A = reused.toJSON().content ?? [], B = parsed.toJSON().content ?? [];
    if (JSON.stringify(A) !== JSON.stringify(B)) {
      // Name the first block that differs, not just "not equal".
      let i = 0;
      while (i < Math.min(A.length, B.length) && JSON.stringify(A[i]) === JSON.stringify(B[i])) i++;
      assert.fail(`${name}: block ${i} of ${B.length} differs\n reused: ${JSON.stringify(A[i])?.slice(0, 400)}\n parsed: ${JSON.stringify(B[i])?.slice(0, 400)}`);
    }
  }
});

test('the splice layer\'s tree is left untouched (it keeps references into it)', async () => {
  const src = '# Title\n\nline one\nline two\n\n<div>html</div>\n\n1. a\n2. b\n';
  const md = new MdDoc(src);
  const before = JSON.stringify(md.tree);
  await docOf(md.body, { text: md.body, tree: md.tree, used: false });
  assert.equal(JSON.stringify(md.tree), before);
});
