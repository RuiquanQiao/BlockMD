/**
 * Every function the app calls on another module must exist.
 *
 * `import * as platform from './platform.js'` followed by `platform.checkForUpdate()`
 * does not fail anywhere when checkForUpdate is missing: not in the editor, not in the
 * build (the bundler just compiles the call to `(void 0)()`), not in dev builds that
 * never take that path. That is how 0.1.3 and 0.1.4 shipped unable to find updates —
 * two exports were deleted by an overly wide edit. This test reads the source and
 * checks that every `namespace.member` used and every name imported is exported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.js$/.test(n) ? [p] : [];
  });
}

/** Names a module exports (functions, classes, consts, lets, `export { … }`). */
function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return names;
}

const sources = [...files(join(ROOT, 'app')), ...files(join(ROOT, 'src'))];

test('app imports · every namespace member and named import exists', () => {
  const missing = [];
  for (const file of sources) {
    // Comments mention files like `platform.js`; only code counts.
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const local = (spec) => spec.startsWith('.') ? resolve(dirname(file), spec) : null;

    for (const m of src.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/g)) {
      const target = local(m[2]);
      if (!target) continue;
      const exported = exportsOf(target);
      // Not preceded by `/` or `.`: `'./platform.js'` in the import line is a path.
      for (const use of src.matchAll(new RegExp(`(?<![\\w$./])${m[1]}\\.([\\w$]+)`, 'g'))) {
        if (!exported.has(use[1])) missing.push(`${relative(ROOT, file)}: ${m[1]}.${use[1]} (not exported by ${relative(ROOT, target)})`);
      }
    }
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g)) {
      const target = local(m[2]);
      if (!target) continue;
      const exported = exportsOf(target);
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !exported.has(name)) missing.push(`${relative(ROOT, file)}: { ${name} } from ${m[2]}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'missing exports:\n' + missing.join('\n'));
});
