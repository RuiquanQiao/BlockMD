/**
 * Toggles and columns in the editor: node views with a nested editor per part.
 *
 * The document model (src/containers.js, src/milkdown-adapter.js) keeps each part —
 * a toggle's body, each column — as raw Markdown text on an atom node. Here every
 * part gets its own small ProseMirror editor, and its own DocumentSession over that
 * raw text: when you edit one paragraph in a column, the column's other blocks keep
 * their bytes exactly as the whole document's do. Only the changed part's text is
 * written back into the node, and only that node is re-serialized on save.
 *
 * The nested editors share the main editor's schema and every plugin that has no
 * view of its own — keymaps, input rules, history, node views, highlighting — so
 * typing works the same inside a toggle or a column. Plugins that draw UI (the drag
 * handle, slash menu, toolbar, find bar) stay with the main editor.
 */

import { $prose } from '@milkdown/kit/utils';
import { parserCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey, EditorState, NodeSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { DocumentSession } from '../session.js';
import { blockAtSelection } from './block-types.js';

/**
 * A nested editor over one part's Markdown.
 * @param {any} ctx Milkdown ctx
 * @param {EditorView} outer The main editor view
 * @param {HTMLElement} host
 * @param {string} markdown
 * @param {(text: string) => void} onChange Receives the part's new Markdown
 */
function nestedEditor(ctx, outer, host, markdown, onChange) {
  const schema = outer.state.schema;
  let doc = markdown.trim() ? ctx.get(parserCtx)(markdown) : null;
  if (!doc || doc.childCount === 0) doc = schema.topNodeType.createAndFill();
  const plugins = outer.state.plugins.filter((p) => !p.spec.view);
  const session = new DocumentSession(markdown);

  const view = new EditorView(host, {
    state: EditorState.create({ doc, plugins }),
    attributes: { class: 'bmd-nested' },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      if (!tr.docChanged) return;
      // Same save path as the whole document. If the part's blocks can't be mapped
      // (an empty part has none), fall back to serializing just this part.
      const text = session.mapping?.ok ? session.save() : session.serializeAll();
      onChange(text.replace(/\n+$/, ''));
    },
  });
  session.attach(ctx, () => view);
  return { view, text: markdown };
}

class ToggleView {
  constructor(node, view, getPos, ctx) {
    Object.assign(this, { node, outer: view, getPos, ctx });
    this.dom = document.createElement('div');
    this.dom.className = 'bmd-toggle';
    this.dom.dataset.bmd = 'toggle';
    this.dom.dataset.open = String(Boolean(node.attrs.open));
    this.dom.innerHTML =
      '<div class="bmd-toggle-head"><button type="button" class="bmd-toggle-arrow" aria-label="Open toggle"></button>' +
      '<div class="bmd-toggle-summary" contenteditable="true" spellcheck="false"></div></div>' +
      '<div class="bmd-toggle-body"></div>';
    this.arrow = this.dom.querySelector('.bmd-toggle-arrow');
    this.summary = this.dom.querySelector('.bmd-toggle-summary');
    this.bodyHost = this.dom.querySelector('.bmd-toggle-body');
    this.summary.textContent = node.attrs.summary;
    this.summary.dataset.placeholder = 'Toggle';

    this.arrow.addEventListener('mousedown', (e) => e.preventDefault());
    this.arrow.addEventListener('click', () => this.setOpen(this.dom.dataset.open !== 'true'));
    this.summary.addEventListener('input', () => this.commit({ summary: this.summary.textContent }));
    this.summary.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.setOpen(true);
        this.body.view.focus();
      }
    });
    if (this.dom.dataset.open === 'true') this.mountBody();
  }

  mountBody() {
    if (this.body) return;
    this.body = nestedEditor(this.ctx, this.outer, this.bodyHost, this.node.attrs.body, (text) => {
      this.body.text = text;
      this.commit({ body: text });
    });
  }

  setOpen(open) {
    this.dom.dataset.open = String(open);
    this.arrow.setAttribute('aria-label', open ? 'Close toggle' : 'Open toggle');
    if (open) this.mountBody();
  }

  commit(attrs) {
    const pos = this.getPos();
    if (pos == null) return;
    const tr = this.outer.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs });
    this.outer.dispatch(tr);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (document.activeElement !== this.summary && this.summary.textContent !== node.attrs.summary) {
      this.summary.textContent = node.attrs.summary;
    }
    // Changed from outside (undo in the main editor): rebuild the body.
    if (this.body && this.body.text !== node.attrs.body) {
      this.body.view.destroy();
      this.body = null;
      this.bodyHost.textContent = '';
      if (this.dom.dataset.open === 'true') this.mountBody();
    }
    return true;
  }

  // Everything inside is ours (arrow, title, nested editor); the outer editor only sees drags.
  stopEvent(e) { return e.type !== 'dragstart' && this.dom.contains(e.target); }
  ignoreMutation() { return true; }
  destroy() { this.body?.view.destroy(); }
}

class ColumnsView {
  constructor(node, view, getPos, ctx) {
    Object.assign(this, { node, outer: view, getPos, ctx });
    this.dom = document.createElement('div');
    this.dom.className = 'bmd-columns';
    this.dom.dataset.bmd = 'columns';
    this.build();
  }

  build() {
    this.parts?.forEach((p) => p.view.destroy());
    this.dom.textContent = '';
    const columns = this.node.attrs.columns;
    this.dom.style.setProperty('--cols', String(columns.length));
    this.parts = columns.map((text, i) => {
      const host = document.createElement('div');
      host.className = 'bmd-column';
      this.dom.append(host);
      const part = nestedEditor(this.ctx, this.outer, host, text, (next) => {
        part.text = next;
        const pos = this.getPos();
        if (pos == null) return;
        const cols = [...this.node.attrs.columns];
        cols[i] = next;
        this.outer.dispatch(this.outer.state.tr.setNodeMarkup(pos, undefined, { columns: cols }));
      });
      return part;
    });
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const cols = node.attrs.columns;
    if (cols.length !== this.parts.length || cols.some((c, i) => c !== this.parts[i].text)) this.build();
    return true;
  }

  stopEvent(e) { return this.dom.contains(e.target) && e.type !== 'dragstart'; }
  ignoreMutation() { return true; }
  destroy() { this.parts.forEach((p) => p.view.destroy()); }
}

/** Put a new container in place of the (empty or `/`) block at the cursor. */
function insertContainer(view, node) {
  const { state } = view;
  const { $from } = state.selection;
  const empty = $from.parent.textContent.trim() === '' && $from.depth === 1;
  const at = empty ? $from.before() : $from.after(1);
  const tr = empty ? state.tr.replaceWith(at, $from.after(), node) : state.tr.insert(at, node);
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView());
  return at;
}

export function insertToggle(view) {
  const at = insertContainer(view, view.state.schema.nodes.toggle.create({ summary: '', body: '' }));
  requestAnimationFrame(() => view.nodeDOM(at)?.querySelector('.bmd-toggle-summary')?.focus());
}

export function insertColumns(view, count) {
  const at = insertContainer(view, view.state.schema.nodes.column_row.create({ columns: Array(count).fill('') }));
  requestAnimationFrame(() => view.nodeDOM(at)?.querySelector('.bmd-column .ProseMirror')?.focus());
}

/** Ctrl+Shift+7: the block at the cursor becomes a toggle titled with its text. */
export function turnIntoToggle(view) {
  const target = blockAtSelection(view.state);
  if (target.node.type.name === 'toggle') return;
  const summary = target.node.textContent;
  const toggle = view.state.schema.nodes.toggle.create({ summary, body: '' });
  const tr = view.state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, toggle);
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, target.pos)));
  requestAnimationFrame(() => {
    const el = view.nodeDOM(target.pos)?.querySelector('.bmd-toggle-summary');
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
}

export const containerViewsPlugin = $prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey('bmdContainers'),
      props: {
        nodeViews: {
          toggle: (node, view, getPos) => new ToggleView(node, view, getPos, ctx),
          column_row: (node, view, getPos) => new ColumnsView(node, view, getPos, ctx),
        },
      },
    }),
);

