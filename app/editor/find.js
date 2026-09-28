/**
 * Find in page (Ctrl+F): a bar in the top-right corner, matches highlighted with
 * decorations. Enter / Shift+Enter step through them, Escape closes. Case-insensitive.
 * Decorations never touch the document, so finding can't affect what is saved.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

const key = new PluginKey('bmdFind');

/** @returns {{from:number,to:number}[]} */
function matches(doc, query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const text = node.text.toLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push({ from: pos + i, to: pos + i + q.length });
  });
  return out;
}

class FindBar {
  constructor(view) {
    this.view = view;
    this.el = document.createElement('div');
    this.el.className = 'bmd-find';
    this.el.dataset.show = 'false';
    this.el.innerHTML =
      '<input type="text" placeholder="Find in page" spellcheck="false" aria-label="Find in page">' +
      '<span class="bmd-find-count"></span>' +
      '<button type="button" data-dir="-1" title="Previous (Shift+Enter)" aria-label="Previous match">↑</button>' +
      '<button type="button" data-dir="1" title="Next (Enter)" aria-label="Next match">↓</button>' +
      '<button type="button" data-close title="Close (Esc)" aria-label="Close">✕</button>';
    this.input = this.el.querySelector('input');
    this.count = this.el.querySelector('.bmd-find-count');
    document.body.append(this.el);

    this.input.addEventListener('input', () => this.search(0));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if ('close' in b.dataset) this.close(); else this.step(Number(b.dataset.dir));
    });
    this.onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') { e.preventDefault(); this.open(); }
    };
    window.addEventListener('keydown', this.onKey, true);
  }

  open() {
    const { state } = this.view;
    const { from, to, empty } = state.selection;
    if (!empty && to - from < 100) this.input.value = state.doc.textBetween(from, to);
    this.el.dataset.show = 'true';
    this.input.focus();
    this.input.select();
    this.search(0);
  }

  close() {
    this.el.dataset.show = 'false';
    this.apply('', 0);
    this.view.focus();
  }

  search(current) { this.apply(this.input.value, current); }

  step(dir) {
    const s = key.getState(this.view.state);
    if (!s.results.length) return;
    this.apply(s.query, (s.current + dir + s.results.length) % s.results.length);
  }

  apply(query, current) {
    const { view } = this;
    view.dispatch(view.state.tr.setMeta(key, { query, current }));
    const s = key.getState(view.state);
    this.count.textContent = query ? (s.results.length ? `${s.current + 1}/${s.results.length}` : 'No results') : '';
    const hit = s.results[s.current];
    if (hit) {
      const dom = view.domAtPos(hit.from).node;
      (dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ block: 'center' });
    }
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
  }
}

export const findPlugin = $prose(
  () =>
    new Plugin({
      key,
      state: {
        init: () => ({ query: '', current: 0, results: [] }),
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(key);
          if (meta) return { ...meta, results: matches(state.doc, meta.query) };
          if (tr.docChanged && prev.query) {
            const results = matches(state.doc, prev.query);
            return { ...prev, results, current: Math.min(prev.current, Math.max(0, results.length - 1)) };
          }
          return prev;
        },
      },
      props: {
        decorations(state) {
          const s = key.getState(state);
          if (!s.results.length) return null;
          return DecorationSet.create(state.doc, s.results.map((r, i) =>
            Decoration.inline(r.from, r.to, { class: i === s.current ? 'bmd-find-match bmd-find-current' : 'bmd-find-match' })));
        },
      },
      view: (view) => new FindBar(view),
    }),
);

