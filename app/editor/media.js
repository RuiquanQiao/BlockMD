/**
 * Media links: Notion's video, audio, PDF and bookmark blocks, for Markdown.
 *
 * Markdown can only store these as links, so that is what the file keeps. A paragraph
 * whose whole content is one link gets a preview under it — a player for video and
 * audio, the document for a PDF, a card for a web page — drawn as a widget
 * decoration, so the document and the saved bytes are exactly the link.
 *
 * Local files are read the same way images are (platform.imageUrl): relative to the
 * .md file, through the byte-level read command.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { imageUrl } from '../platform.js';
import { currentDocumentPath } from './image.js';

const VIDEO = /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)(?:[?#].*)?$/i;
const PDF = /\.pdf(?:[?#].*)?$/i;

export function mediaKind(href) {
  if (VIDEO.test(href)) return 'video';
  if (AUDIO.test(href)) return 'audio';
  if (PDF.test(href)) return 'pdf';
  if (/^https?:\/\//i.test(href)) return 'bookmark';
  return null;
}

/** The link a paragraph consists of, if it is nothing but one link. */
function soleLink(node) {
  if (node.type.name !== 'paragraph' || node.childCount === 0) return null;
  let href = null;
  let ok = true;
  node.forEach((child) => {
    const link = child.marks.find((m) => m.type.name === 'link');
    if (!child.isText || !link) { if (child.text?.trim() || !child.isText) ok = false; return; }
    if (href !== null && link.attrs.href !== href) ok = false;
    href = link.attrs.href;
  });
  return ok ? href : null;
}

function render(kind, href, label) {
  const box = document.createElement('div');
  box.className = `bmd-media bmd-media-${kind}`;
  box.contentEditable = 'false';
  box.dataset.href = href;
  if (kind === 'bookmark') {
    let host = href;
    try { host = new URL(href).host; } catch { /* keep as written */ }
    box.innerHTML = '<div class="bmd-bookmark-title"></div><div class="bmd-bookmark-url"></div>';
    box.firstChild.textContent = label && label !== href ? label : host;
    box.lastChild.textContent = href;
    return box;
  }
  const el = document.createElement(kind === 'pdf' ? 'iframe' : kind);
  if (kind !== 'pdf') el.controls = true;
  el.className = 'bmd-media-el';
  box.append(el);
  imageUrl(href, currentDocumentPath()).then(
    (url) => { el.src = url; },
    () => { box.classList.add('bmd-media-missing'); box.textContent = `Can't open ${href}`; },
  );
  return box;
}

function build(doc) {
  const decos = [];
  doc.forEach((node, pos) => {
    const href = soleLink(node);
    const kind = href && mediaKind(href);
    if (!kind) return;
    const end = pos + node.nodeSize;
    decos.push(Decoration.widget(end, () => render(kind, href, node.textContent), {
      side: -1, key: `${kind}:${href}:${node.textContent}`, ignoreSelection: true,
    }));
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey('bmdMedia');

export const mediaPlugin = $prose(
  () =>
    new Plugin({
      key,
      state: {
        init: (_c, state) => build(state.doc),
        apply: (tr, prev) => (tr.docChanged ? build(tr.doc) : prev.map(tr.mapping, tr.doc)),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
);
