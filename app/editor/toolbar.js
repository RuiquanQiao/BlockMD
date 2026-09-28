/**
 * Formatting toolbar: appears above selected text, like Notion's.
 *
 * Only the marks Markdown can store are offered — bold, italic, strikethrough, inline
 * code, link. Notion's colour and underline buttons have no Markdown equivalent
 * (see parity/notion.json), so they would promise something the file can't keep.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { toggleMark } from '@milkdown/prose/commands';
import { openLinkEditor } from './link.js';

const BUTTONS = [
  { mark: 'strong', label: 'B', title: 'Bold (Ctrl+B)', style: 'font-weight:700' },
  { mark: 'emphasis', label: 'i', title: 'Italic (Ctrl+I)', style: 'font-style:italic;font-family:Georgia,serif' },
  { mark: 'strike_through', label: 'S', title: 'Strikethrough (Ctrl+Shift+S)', style: 'text-decoration:line-through' },
  { mark: 'inlineCode', label: '&lt;/&gt;', title: 'Code (Ctrl+E)', style: 'font-family:var(--font-mono);font-size:12px' },
  { mark: 'link', label: 'Link', title: 'Link (Ctrl+K)', style: '' },
];

function markActive(state, type) {
  const { from, to } = state.selection;
  return state.doc.rangeHasMark(from, to, type);
}

class Toolbar {
  constructor(view) {
    this.view = view;
    this.el = document.createElement('div');
    this.el.className = 'bmd-toolbar';
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', 'Text formatting');
    this.buttons = BUTTONS.map((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<span style="${b.style}">${b.label}</span>`;
      btn.title = b.title;
      btn.dataset.mark = b.mark;
      // Keep the selection: a normal mousedown would move focus out of the editor.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.run(b.mark));
      this.el.append(btn);
      return btn;
    });
    document.body.append(this.el);
    this.onScroll = () => this.update(this.view);
    window.addEventListener('scroll', this.onScroll, true);
    this.update(view);
  }

  run(markName) {
    const { view } = this;
    if (markName === 'link') { openLinkEditor(view); this.hide(); return; }
    const type = view.state.schema.marks[markName];
    if (type) toggleMark(type)(view.state, view.dispatch);
    view.focus();
  }

  hide() { this.el.dataset.show = 'false'; }

  update(view) {
    const { state } = view;
    const sel = state.selection;
    const show =
      sel instanceof TextSelection && !sel.empty && view.hasFocus() &&
      sel.$from.parent.inlineContent && sel.$from.parent.type.name !== 'code_block' &&
      document.querySelector('.bmd-link-editor') === null;
    if (!show) { this.hide(); return; }

    for (const btn of this.buttons) {
      const type = state.schema.marks[btn.dataset.mark];
      btn.classList.toggle('is-active', Boolean(type && markActive(state, type)));
    }
    const start = view.coordsAtPos(sel.from);
    const end = view.coordsAtPos(sel.to);
    this.el.dataset.show = 'true';
    const w = this.el.offsetWidth;
    const mid = start.top === end.top ? (start.left + end.left) / 2 : start.left + w / 2;
    this.el.style.left = `${Math.max(8, Math.min(mid - w / 2, window.innerWidth - w - 8))}px`;
    this.el.style.top = `${Math.max(8, start.top - this.el.offsetHeight - 8)}px`;
  }

  destroy() {
    window.removeEventListener('scroll', this.onScroll, true);
    this.el.remove();
  }
}

export const toolbarPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('bmdToolbar'),
      view: (view) => {
        const bar = new Toolbar(view);
        // Focus changes don't produce a transaction, so listen for them directly.
        const refresh = () => setTimeout(() => bar.update(view), 0);
        view.dom.addEventListener('focus', refresh);
        view.dom.addEventListener('blur', refresh);
        return {
          update: (v) => bar.update(v),
          destroy: () => {
            view.dom.removeEventListener('focus', refresh);
            view.dom.removeEventListener('blur', refresh);
            bar.destroy();
          },
        };
      },
    }),
);
