/**
 * mdast ↔ ProseMirror top-level mapping.
 *
 * Why this exists: the two sides are **not** one-to-one. Measured across 14 real-world
 * READMEs:
 *   - `definition` (link definitions, `[ref]: url`) does not exist on the PM side at
 *     all — 79 occurrences
 *   - `html` blocks are folded into `paragraph` — 49 occurrences
 * Aligning by index would make the splice layer write block A's bytes into block B's
 * position. Silent data corruption.
 *
 * Two lines of defence:
 *   1. Count check — visible mdast blocks must equal PM top-level nodes
 *   2. **Per-position type check** — types must be compatible
 * Counting alone is not enough: two skews can cancel out, leaving the totals equal
 * while every correspondence is wrong.
 */

/**
 * mdast top-level type → permitted ProseMirror node type names.
 *
 * Every entry here was measured, not assumed (22 fixtures + 14 real-world READMEs).
 * **Adding a remark plugin requires registering its types here**, otherwise
 * `unknown-mdast-type` will reject the mapping.
 */
export const MDAST_TO_PM = Object.freeze({
  paragraph: ['paragraph'],
  heading: ['heading'],
  list: ['bullet_list', 'ordered_list'],
  code: ['code_block'],
  blockquote: ['blockquote'],
  table: ['table'],
  thematicBreak: ['hr', 'horizontal_rule'],
  footnoteDefinition: ['footnote_definition'],
  yaml: ['frontmatter'],
  // Milkdown has no HTML block node; raw HTML is carried by a paragraph
  // (the bytes still round-trip intact).
  html: ['paragraph', 'html', 'html_block'],
});

/**
 * mdast top-level types the editor never renders; the splice layer owns them.
 *
 * Note: you cannot handle these by "mounting the plugin and letting the editor drop
 * them". Milkdown throws `Cannot match target parser for node` for any mdast type
 * without a parser — it does not silently ignore them.
 */
export const HIDDEN_MDAST_TYPES = Object.freeze(['definition']);

/** @typedef {{ok:true, pmToBlock:number[], blockToPm:(number|null)[]}} MappingOk */
/** @typedef {{ok:false, reason:string, detail:string}} MappingErr */

/**
 * Build the bidirectional mapping between mdast blocks and PM top-level nodes.
 *
 * @param {{node:{type:string}, hidden:boolean}[]} blocks MdDoc.blocks
 * @param {string[]} pmTypeNames PM top-level `type.name`, in document order
 * @returns {MappingOk|MappingErr}
 */
export function buildMapping(blocks, pmTypeNames) {
  /** @type {number[]} */
  const pmToBlock = [];
  /** @type {(number|null)[]} */
  const blockToPm = new Array(blocks.length).fill(null);

  // Reject unregistered types first: their behaviour has never been measured, so we
  // cannot assume they are either visible or hidden.
  for (let i = 0; i < blocks.length; i++) {
    const type = blocks[i].node.type;
    if (blocks[i].hidden) continue;
    if (!(type in MDAST_TO_PM)) {
      return {
        ok: false,
        reason: 'unknown-mdast-type',
        detail:
          `Block #${i} has type "${type}", which is not registered in MDAST_TO_PM. ` +
          `After adding a remark plugin, register its types here and verify the ` +
          `ProseMirror types it maps to.`,
      };
    }
  }

  const visible = [];
  for (let i = 0; i < blocks.length; i++) if (!blocks[i].hidden) visible.push(i);

  if (visible.length !== pmTypeNames.length) {
    return {
      ok: false,
      reason: 'count-skew',
      detail:
        `${visible.length} visible mdast blocks vs ${pmTypeNames.length} ProseMirror ` +
        `top-level nodes. This usually means the two remark configurations have ` +
        `drifted apart (see src/remark-config.js).\n` +
        `  mdast: ${visible.map((i) => blocks[i].node.type).join(', ')}\n` +
        `  pm   : ${pmTypeNames.join(', ')}`,
    };
  }

  for (let k = 0; k < visible.length; k++) {
    const blockIndex = visible[k];
    const mdType = blocks[blockIndex].node.type;
    const pmType = pmTypeNames[k];
    if (!MDAST_TO_PM[mdType].includes(pmType)) {
      return {
        ok: false,
        reason: 'type-mismatch',
        detail:
          `Visible block ${k} does not match: mdast "${mdType}" (block #${blockIndex}) ` +
          `vs ProseMirror "${pmType}". Permitted: [${MDAST_TO_PM[mdType].join(', ')}].`,
      };
    }
    pmToBlock.push(blockIndex);
    blockToPm[blockIndex] = k;
  }

  return { ok: true, pmToBlock, blockToPm };
}

/**
 * Safety gate, evaluated before every save.
 *
 * When the mapping is unusable we must **never** keep writing bytes by position —
 * that puts content in the wrong place. The correct degradation is to abandon
 * incremental splicing and re-serialize the whole document: formatting gets
 * normalized (acceptable), but content stays where it belongs (the part that isn't).
 *
 * @param {MappingOk|MappingErr} mapping
 * @returns {{safe:boolean, strategy:'splice'|'full-reserialize', message?:string}}
 */
export function guardSave(mapping) {
  if (mapping.ok) return { safe: true, strategy: 'splice' };
  return {
    safe: false,
    strategy: 'full-reserialize',
    message:
      `Mapping validation failed (${mapping.reason}); falling back to full ` +
      `re-serialization to avoid misplacing content.\n${mapping.detail}`,
  };
}
