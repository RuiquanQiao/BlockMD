/**
 * Open-then-save identity against real-world Markdown.
 *
 * Hand-written fixtures cover the edge cases we thought of; real READMEs cover the
 * ones we did not. Both are necessary.
 *
 * Run `npm run corpus` to fetch the corpus. Without it this file skips entirely so
 * that offline work is not blocked — but CI always fetches, so it stays a blocking
 * check there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MdDoc } from '../src/splice.js';

const DIR = join(process.cwd(), 'test', 'corpus');
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.md')) : [];

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function firstDiff(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return `at ${i}\n  expected: ${JSON.stringify(a.slice(i, i + 60))}\n  actual:   ${JSON.stringify(b.slice(i, i + 60))}`;
}

const skipReason = files.length === 0 ? 'corpus not fetched — run npm run corpus' : false;

test('real-world corpus · open-then-save is byte-identical', { skip: skipReason }, async (t) => {
  let bytes = 0;
  let blocks = 0;

  for (const f of files) {
    await t.test(f, () => {
      const src = readFileSync(join(DIR, f), 'utf8');
      const doc = new MdDoc(src);
      const out = doc.save();
      bytes += src.length;
      blocks += doc.blocks.length;
      assert.equal(sha(out), sha(src), `bytes differ ${firstDiff(src, out)}`);
    });
  }

  await t.test('coverage', () => {
    assert.ok(files.length >= 10, `corpus too small (${files.length}) to be convincing`);
    console.log(`    covered ${bytes.toLocaleString()} bytes · ${blocks} top-level blocks · ${files.length} files`);
  });
});

test('real-world corpus · edit locality (sampled)', { skip: skipReason }, async (t) => {
  for (const f of files) {
    await t.test(f, () => {
      const src = readFileSync(join(DIR, f), 'utf8');
      const doc = new MdDoc(src);
      // Testing every block is slow; sample at a fixed stride so it stays reproducible.
      const step = Math.max(1, Math.floor(doc.blocks.length / 8));
      for (let i = 0; i < doc.blocks.length; i += step) {
        const out = doc.save({ dirty: [i] });
        const b = doc.blocks[i];
        const prefix = doc.body.slice(0, b.start);
        assert.equal(out.slice(0, prefix.length), prefix, `bytes before block #${i} were altered`);
        const suffix = doc.body.slice(b.end);
        assert.equal(out.slice(out.length - suffix.length), suffix, `bytes after block #${i} were altered`);
      }
    });
  }
});
