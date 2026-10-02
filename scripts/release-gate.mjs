/**
 * Release gate: nothing is published unless everything about that commit is green.
 *
 *   node scripts/release-gate.mjs v0.1.4 --wait      # before `gh release edit --draft=false`
 *   node scripts/release-gate.mjs v0.1.4 --published # after: the website deploy and manifest
 *
 * Why: for three releases the installer audit failed on every release commit and
 * nobody looked, because only the Release and Pages runs were being watched. This
 * checks *every* check run GitHub has for the commit, requires the ones that matter to
 * exist at all, and requires `npm run parity` to have passed on this exact commit.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [tag, ...flags] = process.argv.slice(2);
if (!tag) { console.error('usage: node scripts/release-gate.mjs <tag> [--wait] [--published]'); process.exit(2); }
const repo = process.env.GITHUB_REPOSITORY ?? 'RuiquanQiao/BlockMD';
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' });
const sha = execFileSync('git', ['rev-list', '-n', '1', tag], { cwd: ROOT, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

/** Checks every release commit must have, by name. */
const REQUIRED = [
  [/Fidelity/, 'unit and fidelity tests (CI)'],
  [/Windows \(x64\)/, 'Windows installer build'],
  [/macOS \(Apple silicon\)/, 'macOS Apple silicon build'],
  [/macOS \(Intel\)/, 'macOS Intel build'],
  [/Update manifest/, 'update manifest (latest.json)'],
  [/Install \/ uninstall/, 'installer audit on a clean Windows machine'],
];
const OK = new Set(['success', 'skipped', 'neutral']);

async function checkRuns() {
  for (let i = 0; ; i++) {
    const runs = JSON.parse(gh('api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`)).check_runs;
    const pending = runs.filter((r) => r.status !== 'completed');
    // A required check that hasn't appeared yet is pending too, not missing: runs show up
    // seconds after the tag is pushed, and the manifest job only once the builds are done.
    // (v0.1.8's first gate looked before any had appeared and gave up.)
    const notYet = REQUIRED.filter(([p]) => !runs.some((r) => p.test(r.name))).map(([, what]) => what);
    if ((!pending.length && !notYet.length) || !flags.includes('--wait') || i > 120) return runs;
    console.log(`waiting for ${pending.length + notYet.length} check(s): ${[...pending.map((r) => r.name), ...notYet.map((w) => `${w} (not started)`)].join(', ')}`);
    await sleep(30000);
  }
}

// 1. Every check on the commit, finished and green.
const runs = await checkRuns();
for (const r of runs) {
  if (r.status !== 'completed') problems.push(`still running: ${r.name}`);
  else if (!OK.has(r.conclusion)) problems.push(`${r.conclusion}: ${r.name} — ${r.html_url}`);
}
for (const [pattern, what] of REQUIRED) {
  if (!runs.some((r) => pattern.test(r.name))) problems.push(`missing: ${what} never ran on ${sha.slice(0, 7)}`);
}

// 2. The parity check, on this exact commit (scripts/parity.mjs writes result.json).
let parity = null;
try { parity = JSON.parse(readFileSync(join(ROOT, '.cache/parity/result.json'), 'utf8')); } catch { /* none */ }
if (!parity) problems.push('npm run parity has not been run');
else if (parity.commit !== sha) problems.push(`npm run parity last ran on ${parity.commit?.slice(0, 7) ?? 'uncommitted changes'}, not ${sha.slice(0, 7)}`);
else if (!parity.allPass) problems.push(`npm run parity failed on this commit: ${parity.summary}`);

// 3. After publishing: the website deployed from the release, and the manifest is live.
if (flags.includes('--published')) {
  const version = tag.replace(/^v/, '');
  // The website deploy starts only once the release is published: with --wait, wait for
  // it to appear and finish (v0.1.8's check looked while it was still running).
  let deploy;
  for (let i = 0; ; i++) {
    const pages = JSON.parse(gh('run', 'list', '--repo', repo, '--workflow', 'pages.yml', '--event', 'release', '--limit', '5', '--json', 'conclusion,status,displayTitle'));
    deploy = pages.find((p) => p.displayTitle.includes(tag));
    if ((deploy && deploy.status === 'completed') || !flags.includes('--wait') || i > 40) break;
    console.log(`waiting for the website deploy (${deploy?.status ?? 'not started'})`);
    await sleep(15000);
  }
  if (!deploy) problems.push('no website deploy for this release');
  else if (deploy.conclusion !== 'success') problems.push(`website deploy: ${deploy.status} ${deploy.conclusion ?? ''}`);
  const live = await (await fetch(`https://github.com/${repo}/releases/latest/download/latest.json`)).json().catch(() => null);
  if (live?.version !== version) problems.push(`live latest.json is ${live?.version ?? 'unreadable'}, not ${version}`);
  const site = await (await fetch(`https://ruiquanqiao.github.io/BlockMD/releases.json`, { cache: 'no-store' })).json().catch(() => []);
  if (site[0]?.tag_name !== tag) problems.push(`website lists ${site[0]?.tag_name ?? 'nothing'} first, not ${tag}`);
}

if (problems.length) {
  console.error(`✗ ${tag} (${sha.slice(0, 7)}) is not releasable:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✓ ${tag} (${sha.slice(0, 7)}): ${runs.length} checks green, parity ${parity.summary}${flags.includes('--published') ? ', website and update manifest live' : ''}`);
