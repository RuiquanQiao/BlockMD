/**
 * Layer 0 · the I/O boundary.
 *
 * The splice layer can only preserve bytes it is given. Two ordinary-looking choices
 * in the file-reading path destroy them before `MdDoc` ever runs, and neither shows
 * up in any other test:
 *
 *   - `Blob.text()` performs "UTF-8 decode", which strips a leading BOM. The file
 *     comes back one character short, saves one character short, and every fidelity
 *     test still passes because they all start from a string.
 *   - Lossy decoding turns invalid UTF-8 into U+FFFD, which no later stage can undo.
 *
 * These tests pin the decision to refuse rather than corrupt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFile, encodeFile, basename } from '../app/platform.js';

const BOM_BYTES = [0xef, 0xbb, 0xbf];

test('decodeFile · keeps a BOM as U+FEFF instead of swallowing it', () => {
  const bytes = new Uint8Array([...BOM_BYTES, 0x23, 0x20, 0x68, 0x69, 0x0a]); // "# hi\n"
  const text = decodeFile(bytes);

  assert.equal(text.charCodeAt(0), 0xfeff, 'BOM must survive decoding');
  assert.equal(text.slice(1), '# hi\n');
});

test('decodeFile · a document with no BOM does not gain one', () => {
  assert.equal(decodeFile(new TextEncoder().encode('# hi\n')).charCodeAt(0), 0x23);
});

test('decode → encode · byte-exact round trip for BOM + CRLF + non-ASCII', () => {
  const original = new Uint8Array([
    ...BOM_BYTES,
    ...new TextEncoder().encode('# 标题\r\n\r\n- dash, _underscore_\r\n\r\n~~~txt\r\ntilde\r\n~~~\r\n'),
  ]);

  assert.deepEqual([...encodeFile(decodeFile(original))], [...original]);
});

test('decodeFile · refuses invalid UTF-8 rather than substituting U+FFFD', () => {
  // 0xFF never appears in valid UTF-8. A lossy decoder would return "h\uFFFDi",
  // which saves back as three different bytes.
  assert.throws(
    () => decodeFile(new Uint8Array([0x68, 0xff, 0x69])),
    /not valid UTF-8/,
    'a file whose bytes cannot round trip must not open at all',
  );
});

test('decodeFile · a lone BOM and an empty file are both accepted', () => {
  assert.equal(decodeFile(new Uint8Array([])), '');
  assert.equal(decodeFile(new Uint8Array(BOM_BYTES)), '\uFEFF');
});

test('basename · handles both separators', () => {
  assert.equal(basename('C:\\notes\\a.md'), 'a.md');
  assert.equal(basename('/home/x/a.md'), 'a.md');
  assert.equal(basename('a.md'), 'a.md');
});
