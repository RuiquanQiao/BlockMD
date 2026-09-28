/**
 * Layer 1 · open-then-save identity (the core assertion, a CI blocking check)
 * Layer 2 · edit locality
 * Layer 3 · style inference
 *
 * The project's promise is "the file is just plain .md". Its machine-checkable form
 * is a single sentence: open a file, change nothing, save — and the SHA-256 must be
 * unchanged. A failure here blocks the merge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MdDoc } from '../src/splice.js';
import { fixtures } from './fixtures.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Report the first differing offset, to make failures locatable. */
function firstDiff(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return `at ${i}\n  expected: ${JSON.stringify(a.slice(i, i + 50))}\n  actual:   ${JSON.stringify(b.slice(i, i + 50))}`;
}

test('Layer 1 · open-then-save is byte-identical', async (t) => {
  for (const { name, src, why } of fixtures) {
    await t.test(`${name} — ${why}`, () => {
      const out = new MdDoc(src).save();
      assert.equal(sha(out), sha(src), `bytes differ ${firstDiff(src, out)}`);
    });
  }
});

test('Layer 1 · byte-level details are preserved', async (t) => {
  await t.test('keeps a UTF-8 BOM without shifting offsets', () => {
    const src = '﻿# Doc with BOM\n\nBody text.\n';
    const doc = new MdDoc(src);
    assert.equal(doc.bom, '﻿');
    // With the BOM stripped, the first block must be intact — not missing its last char.
    assert.equal(doc.sourceOf(0), '# Doc with BOM');
    assert.equal(doc.save(), src);
  });

  await t.test('keeps CRLF line endings', () => {
    const src = '# A\r\n\r\n- x\r\n- y\r\n';
    const doc = new MdDoc(src);
    assert.equal(doc.eol, '\r\n');
    assert.equal(doc.save(), src);
  });

  await t.test('keeps a missing trailing newline missing', () => {
    const src = '# A\n\nno trailing newline';
    assert.equal(new MdDoc(src).save(), src);
    assert.ok(!new MdDoc(src).save().endsWith('\n'));
  });

  await t.test('keeps runs of blank lines', () => {
    const src = '# A\n\n\n\n\nB\n';
    assert.equal(new MdDoc(src).save(), src);
  });

  await t.test('handles empty and whitespace-only documents', () => {
    for (const src of ['', '\n', '\n\n\n', '   \n  \n']) {
      assert.equal(new MdDoc(src).save(), src, `failed on ${JSON.stringify(src)}`);
    }
  });
});

test('Layer 2 · dirtying one block must not touch bytes outside it', async (t) => {
  for (const { name, src } of fixtures) {
    await t.test(name, () => {
      const probe = new MdDoc(src);
      for (let i = 0; i < probe.blocks.length; i++) {
        const doc = new MdDoc(src);
        const out = doc.save({ dirty: [i] });
        const b = doc.blocks[i];

        // The original bytes, with their own line endings. (This used to convert every
        // LF to the file's EOL — which encoded the mixed-EOL bug instead of catching it.)
        const prefixExpected = doc.rawSlice(0, b.start);
        const prefixActual = out.slice(doc.bom.length, doc.bom.length + prefixExpected.length);
        assert.equal(prefixActual, prefixExpected, `bytes before block #${i} were altered`);

        const suffixExpected = doc.rawSlice(b.end, doc.body.length);
        const suffixActual = out.slice(out.length - suffixExpected.length);
        assert.equal(suffixActual, suffixExpected, `bytes after block #${i} were altered`);
      }
    });
  }
});

test('Layer 3 · style inference keeps the author spelling after an edit', async (t) => {
  const cases = [
    ['dash bullets', '- a\n- b\n'],
    ['plus bullets', '+ a\n+ b\n'],
    ['setext heading', 'Title\n=====\n'],
    ['tilde fence', '~~~js\nx\n~~~\n'],
    ['underscore emphasis', 'text with _em_ here\n'],
    ['underscore strong', 'text with __strong__ here\n'],
    ['closed ATX heading', '## Heading ##\n'],
    ['underscore thematic break', '___\n'],
  ];
  for (const [label, src] of cases) {
    await t.test(`${label}: still byte-identical after being dirtied`, () => {
      const doc = new MdDoc(src);
      assert.equal(doc.save({ dirty: [0] }), src);
    });
  }
});

test('Layer 3 · known irrecoverable constructs (regression lock)', async (t) => {
  // These are inherent mdast-level losses, not bugs. Locking in the current behaviour
  // prevents silent regressions. If one of them ever becomes recoverable, update this
  // list and note it in the changelog.
  const known = [
    ['HTML entities are decoded at parse time', 'A &amp; B\n'],
    ['two-space hard break becomes a backslash', 'a  \nb\n'],
    ['three-space list indent normalizes to two', '- a\n   - deep\n'],
  ];
  for (const [label, src] of known) {
    await t.test(label, () => {
      const doc = new MdDoc(src);
      assert.notEqual(doc.save({ dirty: [0] }), src, 'now recoverable — update the regression lock');
      // Untouched, however, it must still be identical.
      assert.equal(doc.save(), src, 'differs even without an edit, which is a real bug');
    });
  }
});
