/**
 * Code blocks: a language button in the corner, like Notion's.
 *
 * The language is the fence's info string (```js), so it is ordinary Markdown.
 * Choosing one changes only that block; its fence style is kept on save (restyle).
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { isImeKey } from './ime.js';

export const LANGUAGES = [
  ['', 'Plain text'], ['bash', 'Bash'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['css', 'CSS'],
  ['diff', 'Diff'], ['go', 'Go'], ['html', 'HTML'], ['java', 'Java'], ['js', 'JavaScript'],
  ['json', 'JSON'], ['kotlin', 'Kotlin'], ['latex', 'LaTeX'], ['markdown', 'Markdown'], ['php', 'PHP'],
  ['powershell', 'PowerShell'], ['python', 'Python'], ['r', 'R'], ['ruby', 'Ruby'], ['rust', 'Rust'],
  ['sql', 'SQL'], ['swift', 'Swift'], ['ts', 'TypeScript'], ['xml', 'XML'], ['yaml', 'YAML'],
];
const ALIASES = { javascript: 'js', typescript: 'ts', py: 'python', sh: 'bash', shell: 'bash', 'c++': 'cpp', cs: 'csharp', yml: 'yaml', md: 'markdown', rs: 'rust' };

export function languageLabel(id) {
  const norm = ALIASES[id?.toLowerCase()] ?? id?.toLowerCase() ?? '';
  return LANGUAGES.find(([k]) => k === norm)?.[1] ?? id;
}

class CodeBlockView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('div');
    this.dom.className = 'bmd-code';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'bmd-code-lang';
    this.button.contentEditable = 'false';
    this.button.addEventListener('mousedown', (e) => e.preventDefault());
    this.button.addEventListener('click', () => this.pick());
    const pre = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    pre.append(this.contentDOM);
    this.dom.append(this.button, pre);
    this.render();
  }

  render() {
    const lang = this.node.attrs.language ?? '';
    this.button.textContent = lang ? languageLabel(lang) : 'Plain text';
    this.button.dataset.language = lang;
    this.dom.dataset.language = lang;
  }

  pick() {
    const menu = document.createElement('div');
    menu.className = 'bmd-menu bmd-lang-menu';
    menu.dataset.show = 'true';
    menu.setAttribute('role', 'listbox');
    const input = document.createElement('input');
    input.placeholder = 'Search language';
    input.className = 'bmd-lang-search';
    const list = document.createElement('div');
    menu.append(input, list);
    document.body.append(menu);
    const r = this.button.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, r.right - 220)}px`;

    let items = [];
    let cursor = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      items = LANGUAGES.filter(([id, label]) => !q || id.includes(q) || label.toLowerCase().includes(q));
      if (q && !items.some(([id]) => id === q)) items.push([q, `Use “${q}”`]);
      cursor = Math.min(cursor, Math.max(0, items.length - 1));
      list.innerHTML = '';
      items.forEach(([id, label], i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bmd-menu-item';
        b.setAttribute('role', 'option');
        b.tabIndex = -1;
        b.textContent = label;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => choose(id));
        // The pointer and the arrow keys move one highlight (as in the slash menu).
        b.addEventListener('pointermove', () => { if (cursor !== i) { cursor = i; mark(); } });
        list.append(b);
      });
      mark();
    };
    /** Move the highlight without rebuilding the list. */
    const mark = (scroll = false) => {
      [...list.children].forEach((b, i) => { b.classList.toggle('is-active', i === cursor); b.setAttribute('aria-selected', String(i === cursor)); });
      if (scroll) list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    };
    const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); };
    const choose = (id) => {
      close();
      const pos = this.getPos();
      if (pos == null) return;
      if ((this.node.attrs.language ?? '') !== id) {
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language: id }));
      }
      this.view.focus();
    };
    const outside = (e) => { if (!menu.contains(e.target)) close(); };
    input.addEventListener('input', () => { cursor = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (isImeKey(e)) return; // the key belongs to the input method (see ime.js)
      if (e.key === 'ArrowDown') { cursor = Math.min(items.length - 1, cursor + 1); mark(true); e.preventDefault(); }
      if (e.key === 'ArrowUp') { cursor = Math.max(0, cursor - 1); mark(true); e.preventDefault(); }
      if (e.key === 'Enter' && items[cursor]) { e.preventDefault(); choose(items[cursor][0]); }
      if (e.key === 'Escape') { e.preventDefault(); close(); this.view.focus(); }
    });
    document.addEventListener('mousedown', outside, true);
    draw();
    input.focus();
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  // The button is not part of the document: ignore its DOM changes and its events.
  ignoreMutation(m) { return !this.contentDOM.contains(m.target); }
  stopEvent(e) { return this.button.contains(e.target); }
}

export const codeBlockPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('bmdCodeBlock'),
      props: { nodeViews: { code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos) } },
    }),
);
