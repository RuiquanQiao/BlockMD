/**
 * Syntax highlighting for code blocks, as decorations.
 *
 * lowlight (highlight.js, its ~35 common languages) turns the code into a token tree;
 * each token becomes an inline decoration with highlight.js's class names, coloured in
 * styles.css. Decorations are view-only, so highlighting can never change what is
 * saved. Blocks are cached by node identity: typing in one block re-highlights only it.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);
/** @type {WeakMap<object, {from:number,to:number,cls:string}[]>} */
const cache = new WeakMap();

function tokens(node) {
  let out = cache.get(node);
  if (out) return out;
  out = [];
  const lang = (node.attrs.language ?? '').toLowerCase();
  if (lang && lowlight.registered(lang)) {
    let offset = 0;
    const walk = (n, classes) => {
      if (n.type === 'text') {
        if (classes.length) out.push({ from: offset, to: offset + n.value.length, cls: classes.join(' ') });
        offset += n.value.length;
        return;
      }
      const own = n.properties?.className ?? [];
      for (const child of n.children ?? []) walk(child, own.length ? [...classes, ...own] : classes);
    };
    walk(lowlight.highlight(lang, node.textContent), []);
  }
  cache.set(node, out);
  return out;
}

function build(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true;
    for (const t of tokens(node)) decos.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.to, { class: t.cls }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey('bmdHighlight');

export const highlightPlugin = $prose(
  () =>
    new Plugin({
      key,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (tr, prev) => (tr.docChanged ? build(tr.doc) : prev),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
);
