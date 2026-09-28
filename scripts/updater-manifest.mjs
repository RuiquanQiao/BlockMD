/**
 * Write latest.json — the file installed apps poll for updates — for one release.
 *
 *   node scripts/updater-manifest.mjs v0.1.2          # builds it and uploads it
 *   node scripts/updater-manifest.mjs v0.1.2 --dry    # prints it only
 *
 * Why not tauri-action's own latest.json: every matrix job rewrites that one shared
 * asset (delete + upload), and jobs that finish together race. In v0.1.2 the macOS
 * jobs replaced it while the Windows job was updating it; the Windows job's delete got
 * 404 and failed, and Windows vanished from the manifest — so Windows users would
 * never have been offered the update. Built once, after every platform has uploaded
 * its signed files, there is nothing to race.
 *
 * Needs the `gh` CLI (authenticated; GH_TOKEN in Actions).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tag, flag] = process.argv.slice(2);
if (!tag) { console.error('usage: node scripts/updater-manifest.mjs <tag> [--dry]'); process.exit(2); }
const repo = process.env.GITHUB_REPOSITORY ?? 'RuiquanQiao/BlockMD';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });
// Scratch space inside the checkout (git-ignored), not the system temp folder.
const WORK = join(fileURLToPath(new URL('..', import.meta.url)), '.cache', 'updater-manifest');

// `gh release view` also finds drafts, which the releases/tags API endpoint does not.
const release = JSON.parse(gh('release', 'view', tag, '--repo', repo, '--json', 'assets,body'));
const assets = new Map(release.assets.map((a) => [a.name, a]));

/** Updater target → the bundle the updater downloads for it. */
const TARGETS = [
  ['windows-x86_64-nsis', /_x64-setup\.exe$/],
  ['windows-x86_64-msi', /_x64_en-US\.msi$/],
  ['darwin-aarch64-app', /_aarch64\.app\.tar\.gz$/],
  ['darwin-x86_64-app', /_x64\.app\.tar\.gz$/],
];

const dir = join(WORK, 'sig');
mkdirSync(dir, { recursive: true });
const platforms = {};
const missing = [];
try {
  for (const [target, pattern] of TARGETS) {
    const bundle = [...assets.keys()].find((n) => pattern.test(n));
    if (!bundle || !assets.has(`${bundle}.sig`)) { missing.push(target); continue; }
    gh('release', 'download', tag, '--repo', repo, '--pattern', `${bundle}.sig`, '--dir', dir, '--clobber');
    platforms[target] = {
      signature: readFileSync(join(dir, `${bundle}.sig`), 'utf8').trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(bundle)}`,
    };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (missing.length) {
  console.error(`Missing signed bundles for: ${missing.join(', ')}. Not writing a manifest that would strand those users.`);
  process.exit(1);
}

// Updaters that can't tell how they were installed fall back to the plain keys.
platforms['windows-x86_64'] = platforms['windows-x86_64-nsis'];
platforms['darwin-aarch64'] = platforms['darwin-aarch64-app'];
platforms['darwin-x86_64'] = platforms['darwin-x86_64-app'];

const manifest = {
  version: tag.replace(/^v/, ''),
  notes: release.body ?? '',
  pub_date: new Date().toISOString(),
  platforms,
};
const json = JSON.stringify(manifest, null, 2) + '\n';

if (flag === '--dry') {
  console.log(json);
} else {
  const out = join(WORK, 'latest.json');
  writeFileSync(out, json);
  gh('release', 'upload', tag, out, '--repo', repo, '--clobber');
  console.log(`latest.json uploaded to ${tag}: ${Object.keys(platforms).join(', ')}`);
}
