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
import { imageUrl } from '../platform.js';

/** Absolute path of the open document; relative image paths resolve against its folder. */
let documentPath = null;

/** @param {string|null} path */
export function setImageBase(path) {
  documentPath = path;
}

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

export const imagePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('bmdImage'),
      props: { nodeViews: { image: (node) => new ImageView(node) } },
    }),
);
