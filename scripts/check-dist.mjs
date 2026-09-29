/**
 * Fail if a release bundle contains the test hooks (app/test-hooks.js).
 *
 *   npm run build && node scripts/check-dist.mjs        # checks dist/
 *   node scripts/check-dist.mjs .cache/parity-dist --expect-hooks
 *
 * The hooks answer native dialogs for the parity checks and expose the editor on
 * `window`. Harmless in themselves, but not something a user's copy should carry — and
 * their absence is decided by a minifier removing dead code, so it is checked, not
 * assumed. `--expect-hooks` checks the opposite for the parity build: that the hooks
 * really are there (otherwise the checks would silently test nothing).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const dir = join(ROOT, args.find((a) => !a.startsWith('--')) ?? 'dist');
const expectHooks = args.includes('--expect-hooks');

// Strings only the hooks contain.
const MARKERS = ['__bmdStub', 'bmd.devNoDialogs', 'bmd.devConfirm', '__bmdHandle'];

const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js|html)$/.test(name)) files.push(p);
  }
})(dir);
if (!files.length) { console.error(`no scripts in ${dir} — build first`); process.exit(2); }

const found = new Map();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of MARKERS) if (text.includes(m)) found.set(m, f.slice(ROOT.length));
}

if (expectHooks) {
  const missing = MARKERS.filter((m) => !found.has(m));
  if (missing.length) { console.error(`✗ the parity build lacks test hooks: ${missing.join(', ')}`); process.exit(1); }
  console.log(`✓ ${dir.slice(ROOT.length)}: test hooks present`);
} else {
  if (found.size) {
    console.error(`✗ test hooks in a release bundle:\n${[...found].map(([m, f]) => `  ${m} in ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`✓ ${dir.slice(ROOT.length)}: no test hooks (${files.length} files)`);
}
