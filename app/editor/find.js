/**
 * Find and replace (Ctrl+F / Ctrl+H): a bar in the top-right corner, matches
 * highlighted with decorations. Enter / F3 go to the next match, Shift+Enter /
 * Shift+F3 to the previous one, Escape closes. Case-insensitive.
 *
 * Finding uses decorations, which never touch the document. Replacing edits only the
 * text of the matches, so only the blocks containing them are re-serialized on save.
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

let current = null;
/** Open the find bar (menu: Edit ▸ Find…). */
export const openFind = () => current?.open(false);
/** Open the find bar with the replace row (menu: Edit ▸ Replace…). */
export const openReplace = () => current?.open(true);

class FindBar {
  constructor(view) {
    this.view = view;
    this.el = document.createElement('div');
    this.el.className = 'bmd-find';
    this.el.dataset.show = 'false';
    this.el.dataset.replace = 'false';
    this.el.innerHTML =
      '<div class="bmd-find-row">' +
      '<input type="text" class="bmd-find-input" placeholder="Find in page" spellcheck="false" aria-label="Find in page">' +
      '<span class="bmd-find-count"></span>' +
      '<button type="button" data-dir="-1" title="Previous (Shift+Enter, Shift+F3)" aria-label="Previous match">↑</button>' +
      '<button type="button" data-dir="1" title="Next (Enter, F3)" aria-label="Next match">↓</button>' +
      '<button type="button" data-close title="Close (Esc)" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="bmd-find-row bmd-replace-row">' +
      '<input type="text" class="bmd-replace-input" placeholder="Replace with" spellcheck="false" aria-label="Replace with">' +
      '<button type="button" class="bmd-replace-btn" data-replace="one" title="Replace this match">Replace</button>' +
      '<button type="button" class="bmd-replace-btn" data-replace="all" title="Replace every match">All</button>' +
      '</div>';
    this.input = this.el.querySelector('.bmd-find-input');
    this.replaceInput = this.el.querySelector('.bmd-replace-input');
    this.count = this.el.querySelector('.bmd-find-count');
    document.body.append(this.el);

    this.input.addEventListener('input', () => this.search(0));
    const keys = (e) => {
      if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    };
    this.input.addEventListener('keydown', keys);
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.replace(e.ctrlKey || e.metaKey ? 'all' : 'one'); return; }
      keys(e);
    });
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if ('close' in b.dataset) this.close();
      else if (b.dataset.replace) this.replace(b.dataset.replace);
      else this.step(Number(b.dataset.dir));
    });
    this.onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyF') { e.preventDefault(); this.open(false); }
      else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyH') { e.preventDefault(); this.open(true); }
      else if (e.key === 'F3' && this.el.dataset.show === 'true' && !this.el.contains(e.target)) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
    };
    window.addEventListener('keydown', this.onKey, true);
    current = this;
  }

  open(withReplace) {
    const { state } = this.view;
    const { from, to, empty } = state.selection;
    if (!empty && to - from < 100) this.input.value = state.doc.textBetween(from, to);
    this.el.dataset.show = 'true';
    this.el.dataset.replace = String(Boolean(withReplace));
    const target = withReplace && this.input.value ? this.replaceInput : this.input;
    target.focus();
    target.select();
    this.search(0);
  }

  close() {
    this.el.dataset.show = 'false';
    this.apply('', 0);
    this.view.focus();
  }

  search(at) { this.apply(this.input.value, at); }

  step(dir) {
    const s = key.getState(this.view.state);
    if (!s.results.length) return;
    this.apply(s.query, (s.current + dir + s.results.length) % s.results.length);
  }

  /** Replace the current match (then move to the next) or every match. */
  replace(which) {
    const { view } = this;
    const s = key.getState(view.state);
    if (!s.results.length) return;
    const text = this.replaceInput.value;
    const targets = which === 'all' ? [...s.results].reverse() : [s.results[s.current]];
    let tr = view.state.tr;
    for (const r of targets) tr = text ? tr.insertText(text, r.from, r.to) : tr.delete(r.from, r.to);
    view.dispatch(tr);
    this.apply(s.query, which === 'all' ? 0 : s.current);
    if (which === 'all') this.count.textContent = `Replaced ${targets.length}`;
  }

  apply(query, at) {
    const { view } = this;
    view.dispatch(view.state.tr.setMeta(key, { query, current: Math.max(0, at) }));
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
    if (current === this) current = null;
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
          if (meta) {
            const results = matches(state.doc, meta.query);
            return { ...meta, results, current: Math.min(meta.current, Math.max(0, results.length - 1)) };
          }
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
