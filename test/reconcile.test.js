/**
 * Identity reconciliation and hidden-block placement.
 *
 * Placement rule — **stay at the original relative position**: each hidden block
 * remembers how many visible blocks preceded it (N) and is re-inserted after the Nth
 * visible block. It does not follow any particular block around.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MdDoc, placeHidden } from '../src/splice.js';
import { reconcileByIdentity, toSavePlan } from '../src/reconcile.js';
import { byName } from './fixtures.js';

test('reconciliation · pairs by object reference', async (t) => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };

  await t.test('unchanged: everything pairs up', () => {
    const plan = reconcileByIdentity([a, b, c], [a, b, c]);
    assert.deepEqual(plan.map((p) => p.fromOld), [0, 1, 2]);
  });

  await t.test('pure reorder: everything reused, nothing to serialize', () => {
    const plan = reconcileByIdentity([a, b, c], [c, a, b]);
    assert.deepEqual(plan.map((p) => p.fromOld), [2, 0, 1]);
    assert.equal(plan.filter((p) => p.fromOld === null).length, 0);
  });

  await t.test('one deleted: the rest are still reused', () => {
    const plan = reconcileByIdentity([a, b, c], [a, c]);
    assert.deepEqual(plan.map((p) => p.fromOld), [0, 2]);
  });

  await t.test('one inserted: only the new block needs serializing', () => {
    const d = { id: 'd' };
    const plan = reconcileByIdentity([a, b], [a, d, b]);
    assert.deepEqual(plan.map((p) => p.fromOld), [0, null, 1]);
  });

  await t.test('equal content but different reference counts as dirty (never a false clean)', () => {
    const a2 = { id: 'a' };
    const plan = reconcileByIdentity([a], [a2]);
    assert.equal(plan[0].fromOld, null);
  });

  await t.test('a repeated reference is not consumed twice', () => {
    const plan = reconcileByIdentity([a, a], [a, a]);
    assert.deepEqual(plan.map((p) => p.fromOld), [0, 1]);
  });
});

test('placeHidden · hidden blocks stay at their original relative position', async (t) => {
  // Source shape: [p0, def1, p2, def3, p4]
  const blocks = [
    { hidden: false, precedingVisible: 0 },
    { hidden: true, precedingVisible: 1 },
    { hidden: false, precedingVisible: 1 },
    { hidden: true, precedingVisible: 2 },
    { hidden: false, precedingVisible: 2 },
  ];

  await t.test('identity permutation reproduces the source order exactly', () => {
    assert.deepEqual(placeHidden([0, 2, 4], blocks), [0, 1, 2, 3, 4]);
  });

  await t.test('reordering visible blocks leaves definitions in their slots', () => {
    // Visible order becomes [p4, p0, p2]
    assert.deepEqual(placeHidden([4, 0, 2], blocks), [4, 1, 0, 3, 2]);
  });

  await t.test('deleting a visible block still places definitions after the Nth visible', () => {
    assert.deepEqual(placeHidden([0, 4], blocks), [0, 1, 4, 3]);
  });

  await t.test('deleting every visible block still retains the definitions', () => {
    const out = placeHidden([], blocks);
    assert.deepEqual(out.sort((x, y) => x - y), [1, 3]);
  });

  await t.test('trailing definitions are not dragged along', () => {
    // [p0, p1, p2, def3, def4] — the common README shape
    const b = [
      { hidden: false, precedingVisible: 0 },
      { hidden: false, precedingVisible: 1 },
      { hidden: false, precedingVisible: 2 },
      { hidden: true, precedingVisible: 3 },
      { hidden: true, precedingVisible: 3 },
    ];
    // Drag the last visible block to the front
    const out = placeHidden([2, 0, 1], b);
    assert.deepEqual(out, [2, 0, 1, 3, 4], 'definitions should stay after every visible block');
  });
});

test('end to end · reordering keeps link definitions present and stable', async (t) => {
  await t.test('definitions interleaved with prose', () => {
    const { src } = byName('21-definitions-interleaved');
    const doc = new MdDoc(src);

    const visible = doc.visibleIndices();
    const hidden = doc.hiddenIndices();
    assert.equal(hidden.length, 2, 'should detect 2 link definitions as hidden blocks');

    // No reorder: byte-identical
    assert.equal(doc.save({ visibleOrder: visible }), src);

    // Move the first visible block to the end
    const reordered = [...visible.slice(1), visible[0]];
    const out = doc.save({ visibleOrder: reordered });

    for (const def of ['[one]: https://example.com/1', '[two]: https://example.com/2']) {
      assert.ok(out.includes(def), `link definition lost: ${def}`);
    }
  });

  await t.test('definitions stacked at the end', () => {
    const { src } = byName('22-definitions-trailing');
    const doc = new MdDoc(src);
    const visible = doc.visibleIndices();

    assert.equal(doc.save({ visibleOrder: visible }), src, 'should be identical without a reorder');

    const out = doc.save({ visibleOrder: [...visible].reverse() });
    assert.ok(out.includes('[a]: https://example.com/a'));
    assert.ok(out.includes('[b]: https://example.com/b'));
  });
});

test('reordering · a moved block carries its bytes verbatim (zero normalization)', () => {
  // Every spelling below is non-canonical: any normalization shows up immediately.
  const src = [
    'A setext heading',
    '================',
    '',
    'A paragraph using _underscores_ for emphasis.',
    '',
    '- dash bullet one',
    '- dash bullet two',
    '',
    '~~~python',
    'x = 1',
    '~~~',
    '',
  ].join('\n');

  const doc = new MdDoc(src);
  const visible = doc.visibleIndices();
  assert.equal(visible.length, 4);

  // Move block 1 (the paragraph) to the end
  const out = doc.save({ visibleOrder: [visible[0], visible[2], visible[3], visible[1]] });

  assert.match(out, /A setext heading\n=+/, 'setext heading was rewritten');
  assert.match(out, /_underscores_/, 'underscore emphasis was rewritten');
  assert.match(out, /^- dash bullet one$/m, 'bullet character was rewritten');
  assert.match(out, /~~~python/, 'tilde fence was rewritten');

  // Same set of blocks, different order.
  const norm = (s) => s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).sort().join(' ');
  assert.equal(norm(out), norm(src), 'reordering changed block contents');
});

test('toSavePlan · translates a reconciliation result into a save plan', () => {
  const a = {}, b = {}, c = {}, fresh = {};
  // Visible blocks sit at MdDoc.blocks indices 0, 2, 4
  const visibleBlockIndices = [0, 2, 4];
  const plan = reconcileByIdentity([a, b, c], [c, fresh, a]);
  const { visibleOrder, newSlots } = toSavePlan(plan, visibleBlockIndices);

  assert.deepEqual(visibleOrder, [4, 0], 'c maps to block 4, a maps to block 0');
  assert.deepEqual(newSlots, [1], 'brand new content occupies slot 1');
});
