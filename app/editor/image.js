/**
 * Images — a node view that shows local pictures.
 *
 * The preset renders `![alt](src)` as `<img src="src">`, which works for web images
 * only: inside the app a relative path resolves against the app itself. This view
 * asks platform.imageUrl() for something displayable instead. The node's `src`
 * attribute is never changed, so the document — and the saved bytes — stay as written.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { imageUrl, saveAsset } from '../platform.js';

/** Absolute path of the open document; relative image paths resolve against its folder. */
let documentPath = null;

/** @param {string|null} path */
export function setImageBase(path) {
  documentPath = path;
}

/** The open document's path, for other views that load local files (media.js). */
export const currentDocumentPath = () => documentPath;

class ImageView {
  constructor(node) {
    this.dom = document.createElement('img');
    this.dom.className = 'bmd-image';
    this.render(node);
  }

  render(node) {
    this.node = node;
    const { src, alt, title } = node.attrs;
    this.dom.alt = alt ?? '';
    if (title) this.dom.title = title; else this.dom.removeAttribute('title');
    // Kept for inspection and for the parity check: what the document says.
    this.dom.dataset.src = src ?? '';
    this.dom.classList.remove('bmd-image-missing');
    const ticket = (this.ticket = {});
    imageUrl(src, documentPath).then(
      (url) => { if (this.ticket === ticket) this.dom.src = url; },
      () => { if (this.ticket === ticket) this.dom.classList.add('bmd-image-missing'); },
    );
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.src !== this.node.attrs.src || node.attrs.alt !== this.node.attrs.alt ||
        node.attrs.title !== this.node.attrs.title) this.render(node);
    else this.node = node;
    return true;
  }
}

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

/**
 * Save image files next to the document and insert them as image blocks — after the
 * block at `at` (a drop point) or at the cursor (a paste). Notion copies a dropped
 * image into the page; the Markdown equivalent is a file beside the .md and a
 * relative link to it, which every other editor and GitHub show too.
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {{name: string, bytes: () => Promise<Uint8Array>}[]} files
 * @param {{x: number, y: number}} [at]
 */
export async function insertImages(view, files, at) {
  if (!documentPath) throw new Error('Save this document first: pasted and dropped images are stored next to it.');
  const paths = [];
  for (const f of files) paths.push(await saveAsset(documentPath, f.name, await f.bytes()));

  const { state } = view;
  const { schema } = state;
  const blocks = paths.map((src) => schema.nodes.paragraph.create(null, schema.nodes.image.create({ src, alt: '' })));
  const hit = at && view.posAtCoords({ left: at.x, top: at.y });
  const $pos = state.doc.resolve(hit ? hit.pos : state.selection.from);
  const para = $pos.depth >= 1 ? $pos.node(1) : null;
  const tr = para && para.type.name === 'paragraph' && para.content.size === 0
    ? state.tr.replaceWith($pos.before(1), $pos.after(1), blocks)
    : state.tr.insert($pos.depth >= 1 ? $pos.after(1) : $pos.pos, blocks);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Clipboard images have no name; give them a dated one, like a screenshot tool. */
function pastedName(type) {
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[type] ?? 'png';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `image-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

export const imagePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('bmdImage'),
      props: {
        nodeViews: { image: (node) => new ImageView(node) },
        handlePaste(view, event) {
          const files = [...(event.clipboardData?.items ?? [])]
            .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
            .map((i) => i.getAsFile())
            .filter(Boolean);
          if (!files.length) return false;
          insertImages(view, files.map((f) => ({
            name: f.name && f.name !== 'image.png' ? f.name : pastedName(f.type),
            bytes: async () => new Uint8Array(await f.arrayBuffer()),
          }))).catch((err) => window.dispatchEvent(new CustomEvent('bmd-flash', { detail: String(err.message ?? err) })));
          return true;
        },
      },
    }),
);
