/**
 * Fetch a real-world Markdown corpus (READMEs from well-known repositories) for the
 * fidelity tests.
 *
 * The corpus is not checked in (see .gitignore): it is upstream content, it changes,
 * and storing it buys nothing. CI and local development both run this before testing.
 *
 *   node scripts/fetch-corpus.mjs
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPOS = [
  'facebook/react',
  'microsoft/vscode',
  'rust-lang/rust',
  'vuejs/core',
  'tauri-apps/tauri',
  'Milkdown/milkdown',
  'remarkjs/remark',
  'marktext/marktext',
  'siyuan-note/siyuan',
  'denoland/deno',
  'sveltejs/svelte',
  'prettier/prettier',
  'vitejs/vite',
  'tailwindlabs/tailwindcss',
];

const OUT = join(process.cwd(), 'test', 'corpus');
mkdirSync(OUT, { recursive: true });

const headers = { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'blockmd-corpus' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

let fetched = 0;
let cached = 0;

for (const repo of REPOS) {
  const file = join(OUT, repo.replace('/', '_') + '.md');
  if (existsSync(file) && !process.env.FORCE_REFETCH) {
    cached++;
    continue;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers });
    if (!res.ok) {
      console.warn(`skipped ${repo}: HTTP ${res.status}`);
      continue;
    }
    const text = await res.text();
    writeFileSync(file, text, 'utf8');
    fetched++;
    console.log(`✓ ${repo}  ${text.length} bytes`);
  } catch (err) {
    console.warn(`skipped ${repo}: ${err.message}`);
  }
}

console.log(`\nCorpus ready: ${fetched} fetched, ${cached} already present, in ${OUT}`);
