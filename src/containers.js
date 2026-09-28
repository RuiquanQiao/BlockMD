/**
 * Container blocks: toggles and columns.
 *
 * Markdown has neither, but both have a portable spelling that every renderer shows
 * sensibly, because CommonMark ends an HTML block at a blank line and parses what
 * follows as ordinary Markdown:
 *
 *   <details>                         <div class="bmd-row">
 *   <summary>Title</summary>          <div class="bmd-col">
 *
 *   Body, any **Markdown**.           Left column
 *
 *   </details>                        </div>
 *                                     <div class="bmd-col">
 *
 *                                     Right column
 *
 *                                     </div>
 *                                     </div>
 *
 * GitHub renders the first as a real toggle; everywhere else columns degrade to
 * stacked content (ADR-004). In mdast, though, each is several *sibling* nodes — html,
 * content, html — so an editor that showed them as one block would have one top-level
 * node where the splice layer has several, and the mapping would skew (iron rule 2).
 *
 * `groupContainers` therefore regroups those siblings into a single `bmdToggle` or
 * `bmdRow` node spanning the same source range, and it runs on **both** sides: the
 * splice layer (via remark-config's parseMarkdown) and the editor (via the remark
 * plugin in milkdown-adapter.js). Each part's content is kept as its raw source text,
 * so an untouched part is written back byte for byte even when its sibling changed.
 *
 * Anything that doesn't match exactly — an unclosed <details>, a stray bmd-col — is
 * left alone as the HTML it is.
 */

const ROW_OPEN = /^<div\s+class=["']bmd-row["']\s*>\s*<div\s+class=["']bmd-col["']\s*>$/;
const COL_SEP = /^<\/div>\s*<div\s+class=["']bmd-col["']\s*>$/;
const ROW_CLOSE = /^<\/div>\s*<\/div>$/;
const TOGGLE_OPEN = /^<details(\s+open)?\s*>\s*<summary>([\s\S]*?)<\/summary>$/;
const TOGGLE_CLOSE = /^<\/details>$/;

/**
 * The raw HTML of a top-level html node, or null. Milkdown's commonmark preset
 * (remarkHtmlTransformer) runs first on the editor side and wraps every top-level
 * html node in a paragraph, keeping its position — so accept that shape too.
 */
function htmlValue(node) {
  if (node?.type === 'html') return node.value;
  if (node?.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'html') return node.children[0].value;
  return null;
}
const html = (node, re) => { const v = htmlValue(node); return v != null && re.test(v.trim()); };

/** The text between two nodes, without the blank lines that frame it. */
function between(source, a, b) {
  return source
    .slice(a.position.end.offset, b.position.start.offset)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '');
}

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
export const decodeSummary = (s) => s.trim().replace(/&(?:lt|gt|quot|#39|amp);/g, (e) => ENTITIES[e]);
export const encodeSummary = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Regroup container siblings among a root's top-level children, in place.
 * @param {{children: any[]}} tree mdast root
 * @param {string} source The exact text the tree was parsed from
 */
export function groupContainers(tree, source) {
  const kids = tree.children;
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    const grouped = html(node, ROW_OPEN) ? row(kids, i, source) : html(node, TOGGLE_OPEN) ? toggle(kids, i, source) : null;
    if (grouped) {
      out.push(grouped.node);
      i = grouped.end;
    } else {
      out.push(node);
    }
  }
  tree.children = out;
  return tree;
}

function span(first, last) {
  return { start: first.position.start, end: last.position.end };
}

function row(kids, start, source) {
  const seps = [];
  let depth = 0;
  for (let j = start + 1; j < kids.length; j++) {
    const k = kids[j];
    if (html(k, ROW_OPEN)) depth++;
    else if (depth === 0 && html(k, COL_SEP)) seps.push(j);
    else if (html(k, ROW_CLOSE)) {
      if (depth > 0) { depth--; continue; }
      const bounds = [start, ...seps, j];
      const columns = bounds.slice(0, -1).map((b, n) => between(source, kids[b], kids[bounds[n + 1]]));
      return { end: j, node: { type: 'bmdRow', columns, position: span(kids[start], k) } };
    }
  }
  return null;
}

function toggle(kids, start, source) {
  let depth = 0;
  for (let j = start + 1; j < kids.length; j++) {
    const k = kids[j];
    if (html(k, TOGGLE_OPEN)) depth++;
    else if (html(k, TOGGLE_CLOSE)) {
      if (depth > 0) { depth--; continue; }
      const m = TOGGLE_OPEN.exec(htmlValue(kids[start]).trim());
      return {
        end: j,
        node: {
          type: 'bmdToggle',
          summary: decodeSummary(m[2]),
          open: Boolean(m[1]),
          body: between(source, kids[start], k),
          position: span(kids[start], k),
        },
      };
    }
  }
  return null;
}

/** Serialize a column row (the ADR-004 form; inner tags are never indented). */
export function rowToMarkdown(columns) {
  const cols = columns.map((c) => `<div class="bmd-col">\n\n${c ? `${c}\n\n` : ''}</div>`);
  return `<div class="bmd-row">\n${cols.join('\n')}\n</div>`;
}

/** Serialize a toggle. */
export function toggleToMarkdown({ summary, body, open }) {
  return `<details${open ? ' open' : ''}>\n<summary>${encodeSummary(summary)}</summary>\n\n${body ? `${body}\n\n` : ''}</details>`;
}

/** mdast-util-to-markdown extension for both container types. */
export const containersToMarkdown = {
  handlers: {
    bmdRow: (node) => rowToMarkdown(node.columns),
    bmdToggle: (node) => toggleToMarkdown(node),
  },
};
