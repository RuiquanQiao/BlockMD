# Fidelity test suite

BlockMD's promise is **"the file is just plain `.md`"**. Its machine-checkable form is
one sentence:

> Open a file, change nothing, save — the SHA-256 must be unchanged.

This suite is that sentence in executable form, and it is a CI blocking check.

## Running

```bash
npm run corpus   # fetch the real-world corpus (once)
npm test
```

## Structure

| Layer | File | Assertion |
|---|---|---|
| 1 | `fidelity.test.js` | `sha256(save(open(md))) === sha256(md)` |
| 2 | `fidelity.test.js` | Dirtying one block leaves every other byte untouched |
| 3 | `fidelity.test.js` | Edited blocks keep their spelling (`-` stays `-`, `~~~` stays `~~~`) |
| — | `reconcile.test.js` | Identity reconciliation, hidden-block placement, zero-normalization reorder |
| — | `mapping.test.js` | mdast ↔ ProseMirror mapping and its safety gate |
| — | `integration.test.js` | The same invariants against a real Milkdown instance |
| — | `corpus.test.js` | 14 real-world READMEs, ~98,000 bytes, 610 top-level blocks |

## Why fixtures are `.js` and not `.md`

The corpus in `fixtures.js` deliberately contains **CRLF line endings, a UTF-8 BOM and
a missing trailing newline**. Stored as `.md` files, git's `autocrlf` / `eol`
normalization would rewrite them on checkout — the tests would still pass, but they
would be validating a file git had already modified, which makes the result
meaningless.

String literals sidestep version control entirely. `.gitattributes` at the repository
root sets `* -text` as a second line of defence.

## Known irrecoverable constructs

The end of `fidelity.test.js` holds a set of regression locks pinning the losses that
are currently **known and accepted**:

- HTML entities are decoded at parse time (`&amp;` → `&`)
- Two-space hard breaks become backslashes (`mdast-util-to-markdown` deliberately
  refuses to emit trailing whitespace)
- Three- and four-space list indentation normalizes to two

These only occur when the containing block is **edited**; an untouched document is
always byte-identical. If one of them is ever fixed upstream, the test fails and asks
for the lock to be updated — that is intentional, and it prevents silent regressions.

## Adding syntax support

Find any spelling whose bytes change across open → save, **add a fixture that fails
first**, then fix the implementation. This is the one discipline the project does not
bend on.
