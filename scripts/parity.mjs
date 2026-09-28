/**
 * Notion parity check: every feature marked "must" in parity/notion.json, exercised in
 * the real desktop app.
 *
 *   npm run parity                 # launches the debug app if it isn't running
 *   npm run parity -- --only=key-bold,slash-menu
 *   npm run parity -- --keep       # leave the app open afterwards
 *
 * Why the real app and not jsdom: most of what broke so far only broke in the webview
 * — relative image paths, fonts, floating menus, native drag and drop. Input goes
 * through the DevTools protocol (Input.*), which reaches the page as trusted events;
 * Windows' SendInput does not reach WebView2 at all (see scripts/cdp.mjs).
 *
 * Each check opens a fresh document and asserts three kinds of things: it renders, it
 * works when used the way a user would, and the saved bytes are right. The report
 * lands in .cache/parity/report.md with screenshots beside it. Exit code 1 if any
 * "must" feature fails or has no check.
 */

import { writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { FIXTURE } from '../parity/fixture.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORK = join(ROOT, '.cache', 'parity');
const DOC = join(WORK, 'doc.md').replace(/\\/g, '/');
const PORT = process.env.BMD_CDP_PORT ?? '9222';
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const keep = args.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

mkdirSync(join(WORK, 'img'), { recursive: true });
copyFileSync(join(ROOT, 'src-tauri/icons/32x32.png'), join(WORK, 'img/dot.png'));

/* ------------------------------------------------------------- the app */

async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
  } catch {
    return null;
  }
}

let child = null;
if (!(await pageTarget())) {
  // Port 5174 sits in a Windows-reserved range on some machines and an installed
  // BlockMD would share the WebView2 profile (ignoring the debugging port), so the
  // debug build gets its own port and its own profile under .cache/.
  console.log('Starting the debug app…');
  const config = { build: { devUrl: 'http://localhost:1437', beforeDevCommand: 'npx vite --port 1437 --strictPort' } };
  child = spawn(process.execPath, [join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js'), 'dev', '--config', J(config)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: join(ROOT, '.cache', 'wv2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
  });
}

function stopApp() {
  if (!child || keep) return;
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
  // Vite is started by tauri but can outlive it; free the port for the next run.
  try {
    const line = execSync('netstat -ano', { encoding: 'utf8' }).split('\n').find((l) => /:1437\s.*LISTENING/.test(l));
    const pid = line?.trim().split(/\s+/).pop();
    if (pid) execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch { /* nothing listening */ }
}

let page = null;
for (let i = 0; i < 180 && !page; i++) {
  page = await pageTarget();
  if (!page) await sleep(2000);
}
if (!page) { stopApp(); throw new Error('the app never opened its debugging port'); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', e, { once: true }); });
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method) { events.forEach((f) => f(msg)); return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(J({ id, method, params }));
});
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'page threw');
  return r.result?.value;
}

for (let i = 0; i < 60; i++) {
  if (await ev('typeof window.__bmd === "object" && !!window.__bmd.openPath').catch(() => false)) break;
  await sleep(1000);
}
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });

/** Helpers that run inside the page. */
const PAGE_HELPERS = `window.__parity = {
  view: () => __bmd.view(),
  find(text, nth = 0) {
    let found = null, seen = 0;
    __bmd.view().state.doc.descendants((n, p) => {
      if (found !== null) return false;
      if (n.isText) { const i = n.text.indexOf(text); if (i >= 0 && seen++ === nth) found = p + i; }
    });
    if (found === null) throw new Error('text not in document: ' + text);
    return found;
  },
  select(from, to) {
    const v = __bmd.view();
    v.focus();
    v.dispatch(v.state.tr.setSelection(__bmd.pm.TextSelection.create(v.state.doc, from, to ?? from)));
  },
  visible(sel) {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return false;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
  },
  top() { const a = []; __bmd.view().state.doc.forEach((n) => a.push(n.type.name + (n.attrs.level ? n.attrs.level : ''))); return a; },
  blockRect(i) { const r = __bmd.view().dom.children[i].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom }; },
}; true`;

/* ------------------------------------------------------------- harness */

const MODS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const NAMED = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Delete: 46 };

function keyInfo(k, shift) {
  if (NAMED[k]) return { key: k, code: k, windowsVirtualKeyCode: NAMED[k] };
  if (k === '/') return { key: '/', code: 'Slash', windowsVirtualKeyCode: 191 };
  if (/^[a-z]$/i.test(k)) {
    const u = k.toUpperCase();
    return { key: shift ? u : u.toLowerCase(), code: 'Key' + u, windowsVirtualKeyCode: u.charCodeAt(0) };
  }
  if (/^\d$/.test(k)) return { key: shift ? ')!@#$%^&*('[+k] : k, code: 'Digit' + k, windowsVirtualKeyCode: 48 + +k };
  throw new Error('unknown key ' + k);
}

const t = {
  ev,
  /** Open `md` as a fresh document on disk (so relative images resolve). */
  async open(md = FIXTURE) {
    writeFileSync(DOC, md);
    await ev(`__bmd.openPath(${J(DOC)})`);
    await ev(PAGE_HELPERS);
    await sleep(250);
    await ev('__bmd.view().focus()');
  },
  /** Put the caret after (or before) the given text. */
  async caret(text, where = 'end') {
    await ev(`(() => { const p = __parity.find(${J(text)}); __parity.select(p + (${J(where)} === 'end' ? ${text.length} : 0)); })()`);
    await sleep(60);
  },
  async select(text) {
    await ev(`(() => { const p = __parity.find(${J(text)}); __parity.select(p, p + ${text.length}); })()`);
    await sleep(120);
  },
  async type(s) {
    for (const ch of s) { await send('Input.insertText', { text: ch }); await sleep(25); }
    await sleep(150);
  },
  async key(combo) {
    const parts = combo.split('+');
    const k = parts.pop();
    const modifiers = parts.reduce((m, p) => m | MODS[p], 0);
    const info = keyInfo(k, parts.includes('Shift'));
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...info });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...info });
    await sleep(150);
  },
  async mouse(type, x, y, extra = {}) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra });
  },
  async hover(x, y) { await t.mouse('mouseMoved', x, y); await sleep(60); await t.mouse('mouseMoved', x + 1, y); await sleep(250); },
  async click(x, y) { await t.mouse('mouseMoved', x, y); await t.mouse('mousePressed', x, y); await t.mouse('mouseReleased', x, y); await sleep(200); },
  /** Start a new empty paragraph after a one-line document. */
  async newLine() { await t.open('start\n'); await t.caret('start'); await t.key('Enter'); },
  save: () => ev('__bmd.session.save()'),
  top: () => ev('__parity.top()'),
  vis: (sel) => ev(`__parity.visible(${J(sel)})`),
  async shot(name) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(WORK, `${name}.png`), Buffer.from(data, 'base64'));
  },
  send,
  events,
};

function expect(cond, message) { if (!cond) throw new Error(message); }
const last = (arr) => arr[arr.length - 1];

/** Hover a block so its handle appears; returns the grip's centre. */
async function grip(index) {
  const r = await ev(`__parity.blockRect(${index})`);
  await t.hover(r.x + 30, r.y + 8);
  const g = await ev(`(() => { const e = document.querySelector('.bmd-handle-grip'); if (!e || !__parity.visible(e.closest('.bmd-handle'))) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  expect(g, 'the drag handle did not appear on hover');
  return g;
}

/* ------------------------------------------------------------- checks */

const checks = {
  /* Fidelity */
  async 'fidelity-untouched'() {
    await t.open();
    const s = await ev('__bmd.session.status()');
    expect(s.ok, 'block mapping failed: ' + s.message);
    expect(s.identical && (await t.save()) === FIXTURE, 'saving without edits changed the file');
  },
  async 'fidelity-edit-style'() {
    const src = '* a\n* b\n\nPara _x_ end.\n\n```\ncode\n```\n';
    await t.open(src);
    await t.caret('a'); await t.type('!');
    await t.caret('end'); await t.type('!');
    const out = await t.save();
    expect(out === '* a!\n* b\n\nPara _x_ end!.\n\n```\ncode\n```\n', 'style changed on edit:\n' + out);
  },
  async 'fidelity-edit-isolated'() {
    await t.open();
    await t.caret('bullet one'); await t.type('!');
    const out = await t.save();
    expect(out === FIXTURE.replace('- bullet one', '- bullet one!'), 'other blocks changed too');
  },

  /* Rendering */
  async 'render-paragraph'() { await t.open(); expect(await ev(`[...document.querySelectorAll('.ProseMirror > p')].some(p => p.textContent.startsWith('Plain paragraph'))`), 'no paragraph'); },
  async 'render-headings'() {
    await t.open();
    const h = await ev(`['h1','h2','h3'].map(s => document.querySelector('.ProseMirror ' + s)?.textContent)`);
    expect(J(h) === J(['Heading one', 'Heading two', 'Heading three']), 'headings: ' + J(h));
  },
  async 'render-bullets'() { await t.open(); expect(await ev(`!!document.querySelector('.ProseMirror ul li ul li')?.textContent.includes('nested bullet')`), 'nested bullet missing'); },
  async 'render-numbered'() { await t.open(); expect((await ev(`document.querySelectorAll('.ProseMirror ol > li').length`)) === 2, 'numbered list missing'); },
  async 'render-todo'() {
    await t.open();
    const state = () => ev(`[...document.querySelectorAll('li[data-item-type=task]')].map(l => l.dataset.checked)`);
    expect(J(await state()) === J(['false', 'true']), 'tasks not rendered as tasks');
    const box = await ev(`(() => { const li = document.querySelector('li[data-item-type=task]'); const r = li.getBoundingClientRect(); const b = getComputedStyle(li, '::before'); return { x: r.left + parseFloat(b.left) + 8, y: r.top + parseFloat(b.top) + 8, shown: b.content !== 'none' }; })()`);
    expect(box.shown, 'no checkbox drawn');
    await t.click(box.x, box.y);
    expect(J(await state()) === J(['true', 'true']), 'clicking the box did not tick it');
  },
  async 'render-quote'() { await t.open(); expect(await ev(`[...document.querySelectorAll('.ProseMirror blockquote:not(.bmd-callout)')].some(b => b.textContent.includes('A plain quote'))`), 'quote missing'); },
  async 'render-callout'() { await t.open(); expect(await ev(`!!document.querySelector('.bmd-callout[data-callout=tip]')`), 'callout not styled'); },
  async 'render-divider'() { await t.open(); expect(await ev(`!!document.querySelector('.ProseMirror hr')`), 'no divider'); },
  async 'render-code'() { await t.open(); expect(await ev(`!!document.querySelector('.ProseMirror pre')?.textContent.includes('answer')`), 'no code block'); },
  async 'render-code-highlight'() {
    await t.open();
    expect(await ev(`document.querySelectorAll('.ProseMirror pre span[class]').length > 0`), 'code is not syntax-highlighted');
  },
  async 'code-language-picker'() {
    await t.open();
    expect(await ev(`__parity.visible('.bmd-code-lang') && document.querySelector('.bmd-code-lang').dataset.language === 'js'`), 'no language control on the code block');
    // Changing it rewrites only that block's info string, keeping the fence.
    const b = await ev(`(() => { const r = document.querySelector('.bmd-code-lang').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await t.click(b.x, b.y); await t.type('python'); await t.key('Enter');
    expect((await t.save()) === FIXTURE.replace('```js', '```python'), 'choosing a language did not save as ```python');
  },
  async 'render-table'() {
    await t.open();
    expect(await ev(`document.querySelector('.ProseMirror table th')?.textContent.trim() === 'Name' && document.querySelector('.ProseMirror table td')?.textContent.trim() === 'a'`), 'table not rendered');
  },
  async 'render-image-local'() {
    await t.open(); await sleep(800);
    const w = await ev(`document.querySelector('.ProseMirror img[data-src="img/dot.png"]')?.naturalWidth ?? -1`);
    expect(w > 0, 'local image did not load (naturalWidth ' + w + ')');
  },
  async 'render-image-web'() {
    await t.open();
    let w = 0;
    for (let i = 0; i < 20 && !(w > 0); i++) { await sleep(250); w = await ev(`[...document.querySelectorAll('.ProseMirror img')].find(i => (i.dataset.src ?? i.getAttribute('src') ?? '').startsWith('https:'))?.naturalWidth ?? -1`); }
    expect(w > 0, 'web image did not load (naturalWidth ' + w + ')');
  },
  async 'render-math-inline'() { await t.open(); expect(await ev(`!!document.querySelector('.ProseMirror .katex')`), 'inline math is not typeset'); },
  async 'render-math-block'() { await t.open(); expect(await ev(`!!document.querySelector('.ProseMirror .katex-display')`), 'block math is not typeset'); },
  async 'render-inline'() {
    await t.open();
    const r = await ev(`(() => { const q = (s) => document.querySelector('.ProseMirror ' + s)?.textContent;
      return { b: q('strong'), i: q('em'), c: q('p > code'), s: q('del') ?? q('s'), a: document.querySelector('.ProseMirror a[href="https://example.com"]')?.textContent }; })()`);
    expect(J(r) === J({ b: 'bold', i: 'italic', c: 'code', s: 'strike', a: 'link' }), 'inline marks: ' + J(r));
  },

  /* Markdown shortcuts */
  async 'shortcut-headings'() {
    for (const n of [1, 2, 3]) {
      await t.newLine(); await t.type('#'.repeat(n) + ' Title');
      expect(last(await t.top()) === 'heading' + n, `${'#'.repeat(n)} + space did not make H${n}`);
    }
  },
  async 'shortcut-bullet'() {
    for (const m of ['-', '*', '+']) {
      await t.newLine(); await t.type(m + ' item');
      expect(last(await t.top()) === 'bullet_list', `"${m} " did not start a bulleted list`);
    }
  },
  async 'shortcut-todo'() {
    await t.newLine(); await t.type('[] task');
    expect(await ev(`__bmd.view().state.doc.lastChild.firstChild?.attrs.checked === false`), '"[] " did not make a to-do');
  },
  async 'shortcut-numbered'() { await t.newLine(); await t.type('1. item'); expect(last(await t.top()) === 'ordered_list', '"1. " did not start a numbered list'); },
  async 'shortcut-quote'() {
    for (const m of ['"', '>']) {
      await t.newLine(); await t.type(m + ' quoted');
      expect(last(await t.top()) === 'blockquote', `"${m} " did not make a quote`);
    }
  },
  async 'shortcut-divider'() { await t.newLine(); await t.type('---'); expect((await t.top()).includes('hr'), '--- did not make a divider'); },
  async 'shortcut-code-block'() { await t.newLine(); await t.type('```'); expect((await t.top()).includes('code_block'), '``` did not make a code block'); },
  async 'shortcut-inline-bold'() { await t.newLine(); await t.type('**bold** '); expect(await ev(`!!document.querySelector('.ProseMirror strong')`), '**text** did not become bold'); },
  async 'shortcut-inline-italic'() { await t.newLine(); await t.type('*it* '); expect(await ev(`!!document.querySelector('.ProseMirror em')`), '*text* did not become italic'); },
  async 'shortcut-inline-code'() { await t.newLine(); await t.type('`c` '); expect(await ev(`!!document.querySelector('.ProseMirror p > code')`), '`text` did not become code'); },
  async 'shortcut-inline-strike'() { await t.newLine(); await t.type('~s~ '); expect(await ev(`!!document.querySelector('.ProseMirror del, .ProseMirror s')`), '~text~ did not become strikethrough'); },

  /* Keyboard */
  ...Object.fromEntries([
    ['key-bold', 'Ctrl+B', 'strong'], ['key-italic', 'Ctrl+I', 'em'],
    ['key-code', 'Ctrl+E', 'p > code'], ['key-strike', 'Ctrl+Shift+S', 'del, .ProseMirror s'],
  ].map(([id, combo, sel]) => [id, async () => {
    await t.open('hello world\n'); await t.select('world'); await t.key(combo);
    expect((await ev(`document.querySelector('.ProseMirror ${sel}')?.textContent`)) === 'world', `${combo} did nothing`);
  }])),
  async 'key-link'() {
    await t.open('hello world\n'); await t.select('world'); await t.key('Ctrl+K');
    await t.type('https://x.dev'); await t.key('Enter');
    expect((await ev(`document.querySelector('.ProseMirror a[href="https://x.dev"]')?.textContent`)) === 'world', 'Ctrl+K, URL, Enter did not make a link');
  },
  async 'key-undo-redo'() {
    await t.open('abc\n'); await t.caret('abc'); await t.type('d');
    const text = () => ev(`__bmd.view().state.doc.textContent`);
    await t.key('Ctrl+Z'); expect((await text()) === 'abc', 'Ctrl+Z did not undo');
    await t.key('Ctrl+Shift+Z'); expect((await text()) === 'abcd', 'Ctrl+Shift+Z did not redo');
    await t.key('Ctrl+Z'); await t.key('Ctrl+Y'); expect((await text()) === 'abcd', 'Ctrl+Y did not redo');
  },
  async 'key-indent'() {
    await t.open('- a\n- b\n'); await t.caret('b'); await t.key('Tab');
    expect(await ev(`!!document.querySelector('.ProseMirror li li')`), 'Tab did not nest the item');
    await t.key('Shift+Tab');
    expect(await ev(`!document.querySelector('.ProseMirror li li')`), 'Shift+Tab did not un-nest it');
  },
  async 'key-turn-into'() {
    const cases = [['1', 'heading1'], ['2', 'heading2'], ['3', 'heading3'], ['0', 'paragraph'], ['4', 'todo'], ['5', 'bullet_list'], ['6', 'ordered_list'], ['8', 'code_block']];
    const failed = [];
    for (const [d, want] of cases) {
      await t.open('text\n'); await t.caret('text'); await t.key('Ctrl+Shift+' + d);
      const top = (await t.top())[0];
      const got = top === 'bullet_list' && (await ev(`__bmd.view().state.doc.firstChild.firstChild.attrs.checked != null`)) ? 'todo' : top;
      if (got !== want) failed.push(`Ctrl+Shift+${d}→${got}`);
    }
    expect(!failed.length, failed.join(', '));
  },
  async 'key-duplicate'() {
    await t.open('a\n\nb\n'); await t.caret('a'); await t.key('Ctrl+D');
    expect((await ev(`__bmd.view().state.doc.textContent`)) === 'aab', 'Ctrl+D did not duplicate the block');
  },
  async 'key-move'() {
    await t.open('a\n\nb\n'); await t.caret('a'); await t.key('Ctrl+Shift+ArrowDown');
    expect((await t.save()) === 'b\n\na\n', 'Ctrl+Shift+↓ did not move the block');
  },
  async 'key-select-delete'() {
    await t.open('a\n\nb\n'); await t.caret('a'); await t.key('Escape');
    expect(await ev(`!!__bmd.view().state.selection.node`), 'Esc did not select the block');
    await t.key('Backspace');
    expect((await t.save()) === 'b\n', 'Backspace did not delete the selected block');
  },
  async 'key-block-menu'() { await t.open('a\n'); await t.caret('a'); await t.key('Ctrl+/'); expect(await t.vis('.bmd-menu'), 'Ctrl+/ did not open the block menu'); await t.key('Escape'); },
  async 'key-find'() { await t.open('a\n'); await t.caret('a'); await t.key('Ctrl+F'); expect(await t.vis('.bmd-find input'), 'Ctrl+F did not open find'); await t.key('Escape'); },

  /* Interaction */
  async 'slash-menu'() {
    await t.newLine(); await t.type('/');
    await sleep(300); // plugin-slash shows the menu 200 ms after the keystroke
    expect(await t.vis('.bmd-slash'), '/ did not open the menu');
    await t.type('head'); await sleep(300);
    expect(await ev(`[...document.querySelectorAll('.bmd-slash-item')].every(e => /head/i.test(e.textContent))`), 'typing did not filter the menu');
    await t.key('Enter');
    expect(last(await t.top()).startsWith('heading'), 'Enter did not insert the chosen block');
  },
  async 'plus-button'() {
    await t.open('a\n');
    await grip(0);
    const add = await ev(`(() => { const r = document.querySelector('.bmd-handle-add').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await t.click(add.x, add.y); await sleep(300);
    expect((await t.top()).length === 2 && (await t.vis('.bmd-slash')), '+ did not add a block with the menu open');
    await t.key('Escape');
  },
  async 'drag-reorder'() {
    await t.open('first\n\nsecond\n\nthird\n');
    const ok = await dragBlock(2, 0);
    expect(ok.moved === 'third\n\nfirst\n\nsecond\n', 'drag did not move the block: ' + J(ok.moved));
  },
  async 'drop-indicator'() {
    await t.open('first\n\nsecond\n\nthird\n');
    const r = await dragBlock(2, 0);
    expect(r.indicator, 'no drop line while dragging');
  },
  async 'block-menu'() {
    await t.open('a\n\nb\n');
    const g = await grip(0);
    await t.click(g.x, g.y); await sleep(200);
    const text = await ev(`__parity.visible('.bmd-menu') ? document.querySelector('.bmd-menu').textContent : ''`);
    expect(/Turn into/.test(text) && /Duplicate/.test(text) && /Delete/.test(text), 'block menu missing items: ' + J(text));
    await t.key('Escape');
  },
  async 'format-toolbar'() {
    await t.open('hello world\n'); await t.select('world'); await sleep(300);
    expect(await t.vis('.bmd-toolbar'), 'no toolbar appears for selected text');
  },
  async 'paste-markdown'() {
    // Into an empty line. Pasted into text, the first block merges into that line — as in Notion.
    await t.newLine();
    await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', '# Pasted\\n\\n- one\\n- two\\n');
      __bmd.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await sleep(300);
    const top = await t.top();
    expect(top.includes('heading1') && top.includes('bullet_list'), 'pasted Markdown stayed plain text: ' + J(top));
  },
  async 'dark-mode'() {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(200);
    const bg = await ev(`getComputedStyle(document.body).backgroundColor`);
    await send('Emulation.setEmulatedMedia', { features: [] });
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    expect(r + g + b < 150, 'background stays light in dark mode: ' + bg);
  },
};

/** Drag top-level block `from` to before block `to` with native drag and drop. */
async function dragBlock(from, to) {
  const g = await grip(from);
  await send('Input.setInterceptDrags', { enabled: true });
  let data = null;
  const onDrag = (m) => { if (m.method === 'Input.dragIntercepted') data = m.params.data; };
  events.push(onDrag);
  await t.mouse('mousePressed', g.x, g.y);
  await t.mouse('mouseMoved', g.x, g.y - 6, { buttons: 1 });
  await sleep(200);
  let indicator = false;
  try {
    expect(data, 'dragging the handle did not start a drag');
    const target = await ev(`__parity.blockRect(${to})`);
    const y = target.y + 2;
    await send('Input.dispatchDragEvent', { type: 'dragEnter', x: g.x, y: g.y, data });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchDragEvent', { type: 'dragOver', x: target.x + 40, y: g.y + ((y - g.y) * i) / 6, data });
      await sleep(40);
    }
    indicator = await ev(`[...document.querySelectorAll('.ProseMirror-dropcursor, .bmd-drop-indicator')].some(e => __parity.visible(e))`);
    await send('Input.dispatchDragEvent', { type: 'drop', x: target.x + 40, y, data });
  } finally {
    await t.mouse('mouseReleased', g.x, g.y);
    await send('Input.setInterceptDrags', { enabled: false });
    events.splice(events.indexOf(onDrag), 1);
  }
  await sleep(250);
  return { moved: await t.save(), indicator };
}

/* ------------------------------------------------------------- run */

const { features } = JSON.parse(readFileSync(join(ROOT, 'parity/notion.json'), 'utf8'));
const results = [];
for (const f of features) {
  if (f.status !== 'must') { results.push({ ...f, result: f.status }); continue; }
  if (only && !only.includes(f.check) && !only.includes(f.id)) continue;
  const run = checks[f.check];
  if (!run) { results.push({ ...f, result: 'fail', detail: `no check named "${f.check}" in scripts/parity.mjs` }); continue; }
  // Several features can share one check; run it once.
  const prior = results.find((r) => r.check === f.check && (r.result === 'pass' || r.result === 'fail'));
  if (prior) { results.push({ ...f, result: prior.result, detail: prior.detail }); continue; }
  let result = 'pass', detail = '';
  try {
    await Promise.race([run(), sleep(30000).then(() => { throw new Error('timed out'); })]);
  } catch (err) {
    result = 'fail';
    detail = String(err.message ?? err).split('\n').slice(0, 3).join(' ');
  }
  try { await t.key('Escape'); } catch { /* best effort */ }
  results.push({ ...f, result, detail });
  console.log(`${result === 'pass' ? '✅' : '❌'} ${f.area} · ${f.feature}${detail ? ' — ' + detail : ''}`);
}

// Pictures of the whole fixture, light and dark, for a human look at the result.
if (!only) {
  await t.open();
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 2600, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  await t.shot('fixture-light');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(300);
  await t.shot('fixture-dark');
  await send('Emulation.setEmulatedMedia', { features: [] });
}
await send('Emulation.clearDeviceMetricsOverride');

const must = results.filter((r) => r.status === 'must');
const passed = must.filter((r) => r.result === 'pass').length;
const icon = { pass: '✅', fail: '❌', planned: '🕓 planned', wontdo: '⛔ won\'t do' };
const report = [
  `# Notion parity — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  '',
  `**Must-have features passing: ${passed} / ${must.length}**`,
  '',
  '| Area | Feature | Result | Detail |',
  '| --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.area} | ${r.feature} | ${icon[r.result]} | ${(r.detail || r.note || '').replace(/\|/g, '\\|')} |`),
  '',
].join('\n');
writeFileSync(join(WORK, 'report.md'), report);
console.log(`\nMust-have features passing: ${passed} / ${must.length}. Report: .cache/parity/report.md`);

ws.close();
stopApp();
process.exit(passed === must.length ? 0 : 1);
