/**
 * Task list checkboxes — click to tick `- [ ]` / `- [x]`.
 *
 * The GFM preset already models task items (a list_item with a boolean `checked`
 * attribute) and renders them as `<li data-item-type="task" data-checked="…">`, but it
 * draws no checkbox. The box itself is a ::before pseudo-element in styles.css, so no
 * node view is needed and the rendered DOM stays exactly what the preset produces.
 *
 * A click on a pseudo-element is reported on its owner, so a mousedown whose target is
 * the `li` itself, left of its text, is a click on the box. Toggling is an attribute
 * change on one item: only the list containing it is re-serialized on save.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';

const key = new PluginKey('bmdTaskList');

/**
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {MouseEvent} event
 */
function toggleFromClick(view, event) {
  const li = event.target;
  if (!(li instanceof HTMLElement) || li.tagName !== 'LI' || li.dataset.itemType !== 'task') return false;
  const text = li.firstElementChild;
  if (text && event.clientX >= text.getBoundingClientRect().left) return false;

  // posAtDOM(li, 0) is the first position inside the item; the item starts one before.
  const pos = view.posAtDOM(li, 0) - 1;
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'list_item' || node.attrs.checked == null) return false;

  event.preventDefault();
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
  return true;
}

export const taskListPlugin = $prose(
  () =>
    new Plugin({
      key,
      props: {
        handleDOMEvents: {
          mousedown: (view, event) => event.button === 0 && toggleFromClick(view, event),
        },
      },
    }),
);
