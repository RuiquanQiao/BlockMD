/**
 * Block types and the commands that act on a whole block.
 *
 * Shared by the slash menu (convert the block being typed in) and the block menu
 * behind the drag handle (Turn into / Duplicate / Delete on the hovered block), so
 * that both produce exactly the same document for the same choice.
 *
 * A deliberate constraint: every type here maps losslessly onto standard Markdown.
 * No database views, no synced blocks — they have no Markdown representation, and
 * listing them would promise something the format cannot keep.
 *
 * Fidelity note: converting, duplicating or deleting never touches any *other*
 * block. The converted block is a new node and gets serialized fresh; a duplicate is
 * the same node object inserted twice, so identity reconciliation keeps the original's
 * bytes and serializes only the copy.
 */

import { NodeSelection, TextSelection } from '@milkdown/prose/state';
import { Fragment } from '@milkdown/prose/model';
import { liftListItem } from '@milkdown/prose/schema-list';
import { calloutInfo, DEFAULT_CALLOUT } from './callout.js';

/** Types a block can be turned into. Order is the order both menus show. */
export const BLOCK_TYPES = [
  { id: 'text', label: 'Text', hint: 'Plain paragraph', keys: ['text', 'p', 'paragraph', 'plain'] },
  { id: 'h1', label: 'Heading 1', hint: '# Heading', keys: ['h1', 'heading1', 'title'] },
  { id: 'h2', label: 'Heading 2', hint: '## Heading', keys: ['h2', 'heading2'] },
  { id: 'h3', label: 'Heading 3', hint: '### Heading', keys: ['h3', 'heading3'] },
  { id: 'ul', label: 'Bulleted list', hint: '- item', keys: ['ul', 'list', 'bullet', 'unordered'] },
  { id: 'ol', label: 'Numbered list', hint: '1. item', keys: ['ol', 'ordered', 'number'] },
  { id: 'todo', label: 'Task list', hint: '- [ ] task', keys: ['todo', 'task', 'check', 'checkbox'] },
  { id: 'quote', label: 'Quote', hint: '> quoted text', keys: ['quote', 'blockquote', 'cite', 'reference'] },
  { id: 'callout', label: 'Callout', hint: '> [!NOTE]', keys: ['callout', 'note', 'tip', 'warning', 'alert', 'admonition'] },
  { id: 'code', label: 'Code block', hint: '``` fenced code', keys: ['code', 'pre', 'fence'] },
];

/** Nodes whose text can be carried into another type. Tables, images, rules can't. */
const CONVERTIBLE = new Set([
  'paragraph', 'heading', 'code_block', 'blockquote', 'bullet_list', 'ordered_list', 'list_item',
]);

/**
 * @typedef {{pos:number, node:import('@milkdown/prose/model').Node}} Target
 *   A block, identified by the position just before it.
 */

/**
 * The block the cursor is "in", in the sense a user means it. For the first paragraph
 * of a list item that is the item; for the only paragraph of a quote (or the marker
 * paragraph of a callout) it is the quote. Otherwise it is the text block itself.
 * @param {import('@milkdown/prose/state').EditorState} state
 * @returns {Target}
 */
export function blockAtSelection(state) {
  const { $from } = state.selection;
  const depth = $from.depth;
  if (depth >= 2) {
    const parent = $from.node(depth - 1);
    const first = $from.index(depth - 1) === 0;
    if (first && parent.type.name === 'list_item') {
      return { pos: $from.before(depth - 1), node: parent };
    }
    if (parent.type.name === 'blockquote' && (parent.childCount === 1 || (first && calloutInfo(parent)))) {
      return { pos: $from.before(depth - 1), node: parent };
    }
  }
  return { pos: $from.before(), node: $from.parent };
}

/**
 * Which of BLOCK_TYPES a block currently is, or null if none.
 * @param {import('@milkdown/prose/state').EditorState} state
 * @param {Target} target
 */
export function currentType(state, { pos, node }) {
  switch (node.type.name) {
    case 'paragraph': return 'text';
    case 'heading': return node.attrs.level <= 3 ? `h${node.attrs.level}` : null;
    case 'code_block': return 'code';
    case 'blockquote': return calloutInfo(node) ? 'callout' : 'quote';
    case 'ordered_list': return 'ol';
    case 'bullet_list': {
      let tasks = true;
      node.forEach((item) => { if (item.attrs.checked == null) tasks = false; });
      return tasks ? 'todo' : 'ul';
    }
    case 'list_item': {
      const list = state.doc.resolve(pos).parent;
      if (list.type.name === 'ordered_list') return 'ol';
      return node.attrs.checked != null ? 'todo' : 'ul';
    }
    default: return null;
  }
}

/** @param {Target} target */
export function canConvert({ node }) {
  return CONVERTIBLE.has(node.type.name);
}

/**
 * Turn a block into another type, keeping its text.
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {Target} target
 * @param {string} typeId One of BLOCK_TYPES' ids
 * @returns {boolean} Whether anything changed
 */
export function turnInto(view, target, typeId) {
  if (!canConvert(target)) return false;
  if (currentType(view.state, target) === typeId) {
    placeCursorIn(view, target.pos);
    return false;
  }
  if (target.node.type.name === 'list_item') {
    const next = convertListItem(view, target, typeId);
    if (!next) return true; // handled in place
    target = next;
    if (currentType(view.state, target) === typeId) {
      placeCursorIn(view, target.pos);
      return true;
    }
  }

  const { state } = view;
  const lines = collectLines(target.node);
  const nodes = build(state.schema, typeId, lines);
  if (!nodes) return false;
  const tr = state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, nodes);
  view.dispatch(withCursorAtEnd(tr, target.pos).scrollIntoView());
  return true;
}

/**
 * Insert a copy of the block right after it.
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {Target} target
 */
export function duplicateBlock(view, { pos, node }) {
  const at = pos + node.nodeSize;
  const tr = view.state.tr.insert(at, node);
  if (NodeSelection.isSelectable(node)) tr.setSelection(NodeSelection.create(tr.doc, at));
  view.dispatch(tr.scrollIntoView());
}

/**
 * Remove the block. A container left empty by that (a list's last item, a quote's
 * only paragraph) goes with it, and deleting the last block leaves an empty paragraph.
 * @param {import('@milkdown/prose/view').EditorView} view
 * @param {Target} target
 */
export function deleteBlock(view, { pos, node }) {
  const { state } = view;
  const $pos = state.doc.resolve(pos);
  let from = pos;
  let to = pos + node.nodeSize;
  let depth = $pos.depth;
  while (depth > 0 && $pos.node(depth).childCount === 1) {
    from = $pos.before(depth);
    to = $pos.after(depth);
    depth--;
  }
  const tr = state.tr;
  if (depth === 0 && state.doc.childCount === 1) {
    tr.replaceWith(from, to, state.schema.nodes.paragraph.create());
  } else {
    tr.delete(from, to);
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
}

/**
 * Replace the (empty or `/`-only) block at the cursor with a divider.
 * @param {import('@milkdown/prose/view').EditorView} view
 */
export function insertDivider(view) {
  const { state, dispatch } = view;
  const hr = state.schema.nodes.hr ?? state.schema.nodes.horizontal_rule;
  if (!hr) return;
  const { $from } = state.selection;
  const tr = state.tr.replaceWith($from.before(), $from.after(), hr.create());
  const after = tr.mapping.map($from.after());
  if (after >= tr.doc.content.size) tr.insert(after, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size))));
  dispatch(tr.scrollIntoView());
}

// ——— internals ———

/**
 * A list item is special: Markdown has no way to make one item of a list a heading.
 * Toggling between bullet and task is an attribute change on the item. Anything else
 * lifts the item out of its list first — the list splits around it, as in Notion —
 * and returns the lifted paragraph for the ordinary conversion to finish.
 * @returns {Target|null} null when the change was completed in place
 */
function convertListItem(view, { pos, node }, typeId) {
  const list = view.state.doc.resolve(pos).parent;
  const hasChecked = node.type.spec.attrs && 'checked' in node.type.spec.attrs;
  if (list.type.name === 'bullet_list' && hasChecked && (typeId === 'ul' || typeId === 'todo')) {
    const tr = view.state.tr.setNodeMarkup(pos, null, {
      ...node.attrs,
      checked: typeId === 'todo' ? false : null,
    });
    view.dispatch(withCursorAtEnd(tr, pos));
    return null;
  }

  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
  const itemType = node.type;
  // Nested items lift one level per call; the bound only guards against a command
  // that reports success without making progress.
  for (let i = 0; i < 16 && inListItem(view.state.selection.$from); i++) {
    if (!liftListItem(itemType)(view.state, view.dispatch)) break;
  }
  const { $from } = view.state.selection;
  return { pos: $from.before(), node: $from.parent };
}

function inListItem($pos) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'list_item') return true;
  return false;
}

/**
 * The block's text, one Fragment of inline content per line. A callout's marker is
 * dropped; a code block contributes one line per source line.
 * @returns {Fragment[]}
 */
function collectLines(node) {
  const schema = node.type.schema;
  const lines = [];
  const add = (block) => {
    if (block.type.name === 'code_block') {
      for (const line of block.textContent.split('\n')) {
        lines.push(line ? Fragment.from(schema.text(line)) : Fragment.empty);
      }
    } else {
      lines.push(block.content);
    }
  };
  if (node.isTextblock) add(node);
  else node.descendants((child) => (child.isTextblock ? (add(child), false) : true));

  const callout = calloutInfo(node);
  if (callout && lines.length) lines[0] = stripMarker(lines[0], callout.length);
  return lines.length ? lines : [Fragment.empty];
}

function stripMarker(fragment, length) {
  let rest = fragment.cut(length);
  const first = rest.firstChild;
  if (first?.isText && first.text.startsWith(' ')) rest = rest.cut(1);
  if (rest.firstChild?.type.name === 'hardbreak') rest = rest.cut(rest.firstChild.nodeSize);
  return rest;
}

/** Plain text of inline content; line breaks become newlines. */
function plain(fragment) {
  let out = '';
  fragment.forEach((n) => { out += n.isText ? n.text : n.type.name === 'hardbreak' ? '\n' : n.textContent; });
  return out;
}

/** @returns {import('@milkdown/prose/model').Node[]|null} */
function build(schema, typeId, lines) {
  const { paragraph, heading, code_block, blockquote, bullet_list, ordered_list, list_item, hardbreak } = schema.nodes;
  const para = (content) => paragraph.create(null, content);

  switch (typeId) {
    case 'text':
      return lines.map(para);
    case 'h1': case 'h2': case 'h3': {
      const level = Number(typeId[1]);
      return lines.map((l) => heading.create({ level }, l));
    }
    case 'code': {
      const text = lines.map(plain).join('\n');
      return [code_block.create(null, text ? schema.text(text) : null)];
    }
    case 'ul': case 'ol': case 'todo': {
      const ordered = typeId === 'ol';
      const task = typeId === 'todo' && 'checked' in (list_item.spec.attrs ?? {});
      const items = lines.map((l, i) =>
        list_item.create(
          {
            listType: ordered ? 'ordered' : 'bullet',
            label: ordered ? `${i + 1}.` : '•',
            ...(task ? { checked: false } : {}),
          },
          para(l),
        ),
      );
      return [(ordered ? ordered_list : bullet_list).create(null, items)];
    }
    case 'quote':
      return [blockquote.create(null, lines.map(para))];
    case 'callout': {
      // `[!NOTE]` + soft break, exactly what the parser produces for
      // `> [!NOTE]\n> body`, so a new callout is indistinguishable from a loaded one.
      const head = Fragment.from([schema.text(`[!${DEFAULT_CALLOUT}]`), hardbreak.create({ isInline: true })])
        .append(lines[0]);
      return [blockquote.create(null, [para(head), ...lines.slice(1).map(para)])];
    }
    default:
      return null;
  }
}

/** Put the cursor at the end of the first text block at or after `pos`. */
function withCursorAtEnd(tr, pos) {
  let end = null;
  tr.doc.nodesBetween(pos, tr.doc.content.size, (node, at) => {
    if (end !== null) return false;
    if (node.isTextblock) {
      end = at + 1 + node.content.size;
      return false;
    }
    return true;
  });
  if (end !== null) tr.setSelection(TextSelection.create(tr.doc, end));
  return tr;
}

function placeCursorIn(view, pos) {
  view.dispatch(withCursorAtEnd(view.state.tr, pos));
}
