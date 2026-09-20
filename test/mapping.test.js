/**
 * mdast ↔ ProseMirror mapping table.
 *
 * The point is not that correct inputs map correctly — it is that **incorrect ones
 * are caught**. An undetected skew makes the splice layer write block A's bytes into
 * block B's position, which is the worst failure this project can have.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MDAST_TO_PM, HIDDEN_MDAST_TYPES, buildMapping, guardSave } from '../src/mapping.js';
import { MdDoc } from '../src/splice.js';
import { fixtures, byName } from './fixtures.js';

/** Minimal stand-in shaped like an MdDoc block. */
const B = (type, hidden = false) => ({ node: { type }, hidden });

test('mapping · well-formed input', async (t) => {
  await t.test('all visible, types compatible', () => {
    const blocks = [B('heading'), B('paragraph'), B('code')];
    const r = buildMapping(blocks, ['heading', 'paragraph', 'code_block']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.pmToBlock, [0, 1, 2]);
    assert.deepEqual(r.blockToPm, [0, 1, 2]);
  });

  await t.test('hidden blocks are skipped and recorded as null', () => {
    const blocks = [B('paragraph'), B('definition', true), B('paragraph')];
    const r = buildMapping(blocks, ['paragraph', 'paragraph']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.pmToBlock, [0, 2], 'PM node 1 should point at block #2');
    assert.deepEqual(r.blockToPm, [0, null, 1]);
  });

  await t.test('an html block mapping to paragraph is legitimate', () => {
    const r = buildMapping([B('html')], ['paragraph']);
    assert.equal(r.ok, true);
  });

  await t.test('a list may map to either ordered or bulleted', () => {
    assert.equal(buildMapping([B('list')], ['bullet_list']).ok, true);
    assert.equal(buildMapping([B('list')], ['ordered_list']).ok, true);
  });

  await t.test('yaml maps to the frontmatter node', () => {
    assert.equal(buildMapping([B('yaml')], ['frontmatter']).ok, true);
  });
});

test('mapping · failures that must be caught', async (t) => {
  await t.test('count mismatch reports count-skew', () => {
    const r = buildMapping([B('paragraph'), B('paragraph')], ['paragraph']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'count-skew');
    assert.match(r.detail, /remark configurations/);
  });

  await t.test('equal counts but swapped types reports type-mismatch', () => {
    // Counting alone cannot catch this: two skews cancel out and the totals match.
    const blocks = [B('heading'), B('code')];
    const r = buildMapping(blocks, ['code_block', 'heading']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'type-mismatch');
  });

  await t.test('an unregistered mdast type reports unknown-mdast-type', () => {
    const r = buildMapping([B('math')], ['math_block']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-mdast-type');
    assert.match(r.detail, /MDAST_TO_PM/);
  });

  await t.test('hidden types are exempt from the unknown-type check', () => {
    const r = buildMapping([B('definition', true), B('paragraph')], ['paragraph']);
    assert.equal(r.ok, true);
  });
});

test('mapping · guardSave degradation', async (t) => {
  await t.test('usable mapping keeps splicing', () => {
    const g = guardSave(buildMapping([B('paragraph')], ['paragraph']));
    assert.deepEqual(g, { safe: true, strategy: 'splice' });
  });

  await t.test('unusable mapping falls back instead of writing by position', () => {
    const g = guardSave(buildMapping([B('paragraph'), B('paragraph')], ['paragraph']));
    assert.equal(g.safe, false);
    assert.equal(g.strategy, 'full-reserialize', 'must degrade rather than keep splicing');
    assert.match(g.message, /misplacing content/);
  });
});

test('mapping · table self-consistency', async (t) => {
  await t.test('hidden types must not also appear in MDAST_TO_PM', () => {
    for (const type of HIDDEN_MDAST_TYPES) {
      assert.ok(
        !(type in MDAST_TO_PM),
        `"${type}" is registered as both hidden and mapped, which is contradictory`,
      );
    }
  });

  await t.test('every mdast top-level type present in the corpus is registered', () => {
    const seen = new Set();
    for (const { src } of fixtures) {
      for (const b of new MdDoc(src).blocks) seen.add(b.node.type);
    }
    for (const type of seen) {
      const known = type in MDAST_TO_PM || HIDDEN_MDAST_TYPES.includes(type);
      assert.ok(known, `fixtures contain an unregistered type "${type}"`);
    }
  });
});

test('mapping · interaction with MdDoc', async (t) => {
  await t.test('visibleIndices agrees with pmToBlock', () => {
    const doc = new MdDoc(byName('21-definitions-interleaved').src);
    const visible = doc.visibleIndices();
    const pmTypes = visible.map((i) => MDAST_TO_PM[doc.blocks[i].node.type][0]);
    const r = buildMapping(doc.blocks, pmTypes);
    assert.equal(r.ok, true);
    assert.deepEqual(r.pmToBlock, visible);
  });

  await t.test('front matter is a visible block, not a hidden one', () => {
    const doc = new MdDoc(byName('13-frontmatter').src);
    const yaml = doc.blocks.find((b) => b.node.type === 'yaml');
    assert.ok(yaml, 'should parse a yaml block');
    assert.equal(yaml.hidden, false, 'yaml has a ProseMirror counterpart, so it is not hidden');
  });
});
