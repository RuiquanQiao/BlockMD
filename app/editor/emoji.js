/**
 * Emoji picker: type `:` and a word (`:smile`), or choose /emoji.
 *
 * The file stores the emoji character itself, which every editor shows, so this is
 * purely an input aid. ↑/↓ or ←/→ move, Enter or Tab inserts, Escape closes.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { EMOJI } from './emoji-data.js';
import { isImeKey } from './ime.js';

const key = new PluginKey('bmdEmoji');
/** `:word` right before the cursor, at the start of the text or after a space. */
const TRIGGER = /(?:^|[\s(])(:([a-z0-9_+-]{2,}))$/i;

function search(query) {
  const q = query.toLowerCase();
  if (!q) return EMOJI.slice(0, 64);
  const starts = [], contains = [];
  for (const e of EMOJI) {
    const words = e[1].split(' ');
    if (words.some((w) => w.startsWith(q))) starts.push(e);
    else if (e[1].includes(q)) contains.push(e);
  }
  return [...starts, ...contains].slice(0, 64);
}

class Picker {
  constructor(view) {
    this.view = view;
    this.el = document.createElement('div');
    this.el.className = 'bmd-emoji';
    this.el.dataset.show = 'false';
    this.el.setAttribute('role', 'listbox');
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(this.el);
    this.items = [];
    this.cursor = 0;
    this.range = null;   // {from, to} of the `:query` text to replace
    this.forced = false; // opened by /emoji: stays open without a query
  }

  open(range, query) {
    this.range = range;
    this.items = search(query);
    this.cursor = Math.min(this.cursor, Math.max(0, this.items.length - 1));
    if (!this.items.length) { this.close(); return; }
    this.el.innerHTML = '';
    this.items.forEach(([emoji, words], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bmd-emoji-item' + (i === this.cursor ? ' is-active' : '');
      b.textContent = emoji;
      b.title = `:${words.split(' ')[0]}:`;
      b.addEventListener('click', () => this.pick(i));
      this.el.append(b);
    });
    const c = this.view.coordsAtPos(range.from);
    this.el.style.left = `${Math.max(8, Math.min(c.left, window.innerWidth - 344))}px`;
    this.el.style.top = `${c.bottom + 6}px`;
    this.el.dataset.show = 'true';
  }

  close() { this.el.dataset.show = 'false'; this.range = null; this.forced = false; this.cursor = 0; }
  get isOpen() { return this.el.dataset.show === 'true'; }

  pick(i) {
    const item = this.items[i];
    if (!item || !this.range) return;
    const { from, to } = this.range;
    this.close();
    this.view.dispatch(this.view.state.tr.insertText(item[0], from, to).scrollIntoView());
    this.view.focus();
  }

  move(d) {
    if (!this.items.length) return;
    this.cursor = (this.cursor + d + this.items.length) % this.items.length;
    [...this.el.children].forEach((b, i) => b.classList.toggle('is-active', i === this.cursor));
    this.el.children[this.cursor]?.scrollIntoView({ block: 'nearest' });
  }

  update(view) {
    const { state } = view;
    const sel = state.selection;
    if (!sel.empty || !view.hasFocus()) { this.close(); return; }
    const $from = sel.$from;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
    if (this.forced) {
      const at = this.range?.from ?? sel.from;
      const typed = sel.from >= at ? state.doc.textBetween(at, sel.from) : null;
      if (typed === null || /\s/.test(typed)) { this.close(); return; }
      this.open({ from: at, to: sel.from }, typed.replace(/^:/, ''));
      return;
    }
    const m = TRIGGER.exec(before);
    if (!m || $from.parent.type.spec.code) { this.close(); return; }
    this.open({ from: sel.from - m[1].length, to: sel.from }, m[2]);
  }

  destroy() { this.el.remove(); }
}

let current = null;

/** /emoji: open the picker at the cursor with every emoji listed. */
export function openEmojiPicker(view) {
  if (!current) return;
  current.forced = true;
  current.open({ from: view.state.selection.from, to: view.state.selection.from }, '');
}

export const emojiPlugin = $prose(
  () =>
    new Plugin({
      key,
      view(view) {
        const picker = new Picker(view);
        current = picker;
        return { update: (v) => picker.update(v), destroy: () => { picker.destroy(); if (current === picker) current = null; } };
      },
      props: {
        handleKeyDown(view, e) {
          const p = current;
          if (!p?.isOpen || isImeKey(e)) return false;
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { p.move(e.key === 'ArrowDown' ? 8 : 1); return true; }
          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { p.move(e.key === 'ArrowUp' ? -8 : -1); return true; }
          if (e.key === 'Enter' || e.key === 'Tab') { p.pick(p.cursor); return true; }
          if (e.key === 'Escape') { p.close(); return true; }
          return false;
        },
      },
    }),
);
