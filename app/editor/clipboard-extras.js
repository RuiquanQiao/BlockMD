/**
 * Typora's clipboard extras and Ctrl+click on links.
 *
 *   Ctrl+Shift+C  Copy as Markdown — the selection as Markdown source text.
 *   Ctrl+Shift+V  Paste as plain text — lines become paragraphs, nothing is parsed.
 *   Ctrl+click    Open a link: web links in the browser, a link to another .md file in
 *                 BlockMD. A plain click keeps placing the caret, as in any editor.
 */

import { $prose } from '@milkdown/kit/utils';
import { serializerCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Fragment, Slice } from '@milkdown/prose/model';
import { openExternal } from '../platform.js';
import { currentDocumentPath } from './image.js';

let serialize = null;

/** Copy the selection as Markdown source text. */
export function copyAsMarkdown(view) {
  const { from, to, empty } = view.state.selection;
  if (empty || !serialize) return;
  const slice = view.state.doc.slice(from, to);
  const doc = view.state.schema.topNodeType.createAndFill(null, slice.content) ??
    view.state.schema.topNodeType.create(null, view.state.schema.nodes.paragraph.create(null, slice.content));
  const markdown = serialize(doc).replace(/\n+$/, '');
  // Through a copy event rather than navigator.clipboard: no permission involved.
  const onCopy = (e) => { e.clipboardData.setData('text/plain', markdown); e.preventDefault(); };
  document.addEventListener('copy', onCopy, { once: true });
  document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  window.dispatchEvent(new CustomEvent('bmd-flash', { detail: 'Copied as Markdown' }));
}

/** The link under a click position, if any. */
function linkAt(view, pos) {
  const $pos = view.state.doc.resolve(pos);
  const marks = [...($pos.nodeAfter?.marks ?? []), ...($pos.nodeBefore?.marks ?? [])];
  return marks.find((m) => m.type.name === 'link')?.attrs.href ?? null;
}

function openLink(href) {
  if (/^(https?:|mailto:)/i.test(href)) { openExternal(href).catch(() => {}); return; }
  if (/^#/.test(href)) return;
  // A relative link to another Markdown file: open it here, next to this one.
  const doc = currentDocumentPath();
  const path = decodeURI(href.replace(/[?#].*$/, ''));
  if (!doc || !/\.(md|markdown|mdx)$/i.test(path)) return;
  const dir = doc.slice(0, Math.max(doc.lastIndexOf('/'), doc.lastIndexOf('\\')));
  const full = /^([a-zA-Z]:[\\/]|[\\/])/.test(path) ? path : `${dir}/${path.replace(/^\.[\\/]/, '')}`;
  window.dispatchEvent(new CustomEvent('bmd-open-path', { detail: full }));
}

let plainPaste = false;

export const clipboardExtrasPlugin = $prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey('bmdClipboardExtras'),
      view: () => {
        serialize = (doc) => ctx.get(serializerCtx)(doc);
        return {};
      },
      props: {
        handleKeyDown(view, e) {
          const mod = e.ctrlKey || e.metaKey;
          if (mod && e.shiftKey && !e.altKey && e.code === 'KeyC') { copyAsMarkdown(view); return true; }
          // The paste itself is the browser's (it needs no clipboard permission);
          // remember that this one should stay plain text.
          if (mod && e.shiftKey && !e.altKey && e.code === 'KeyV') { plainPaste = true; setTimeout(() => { plainPaste = false; }, 500); }
          return false;
        },
        handlePaste(view, e) {
          if (!plainPaste) return false;
          plainPaste = false;
          const text = e.clipboardData?.getData('text/plain');
          if (!text) return false;
          const { schema } = view.state;
          const paras = text.replace(/\r\n?/g, '\n').split('\n').map((line) =>
            schema.nodes.paragraph.create(null, line ? schema.text(line) : null));
          view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(paras), 1, 1)).scrollIntoView());
          return true;
        },
        handleClick(view, pos, e) {
          if (!(e.ctrlKey || e.metaKey)) return false;
          const href = linkAt(view, pos);
          if (!href) return false;
          openLink(href);
          return true;
        },
      },
    }),
);
