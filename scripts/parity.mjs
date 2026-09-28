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

import { writeFileSync, mkdirSync, copyFileSync, readFileSync, rmSync, readdirSync, chmodSync } from 'node:fs';
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
// Media for the preview checks: a 0.2 s 440 Hz tone and a one-page PDF, made here so
// no binary fixtures live in the repository.
mkdirSync(join(WORK, 'media'), { recursive: true });
{
  const rate = 8000, n = rate / 5, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  writeFileSync(join(WORK, 'media/beep.wav'), Buffer.concat([head, data]));
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 18 Tf 20 40 Td (BlockMD PDF) Tj ET\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(WORK, 'media/doc.pdf'), pdf);
}
// Files for the editor-baseline checks, written fresh by each check.
rmSync(join(WORK, 'files'), { recursive: true, force: true });
mkdirSync(join(WORK, 'files'), { recursive: true });
function file(name, text) {
  const p = join(WORK, 'files', name).replace(/\\/g, '/');
  writeFileSync(p, text);
  return p;
}
// Images pasted by the image-paste check land here; start clean every run.
rmSync(join(WORK, 'assets'), { recursive: true, force: true });

/* ------------------------------------------------------------- the app */

async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    // The app's own page — not an embedded viewer (a PDF preview is a target of its own).
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return pages.find((t) => !t.url.startsWith('chrome-extension:')) ?? null;
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
      // No native dialogs from the first page load on (app/platform.js `stub`).
      VITE_BMD_NO_DIALOGS: '1',
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

// No native dialog may open while checks run (platform.js `stub`): nothing can click
// one, and the page freezes behind it. Also start from a clean slate — a leftover
// draft or last-file would otherwise change what the app does on the next reload.
const DEV_KEYS = ['bmd.draft', 'bmd.lastFile', 'bmd.devConfirm', 'bmd.devBlocked'];
await ev(`(() => { localStorage.setItem('bmd.devNoDialogs', '1'); for (const k of ${J(DEV_KEYS)}) localStorage.removeItem(k); })()`);

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
  // Through ProseMirror, not dom.children: preview widgets (media.js) sit between blocks.
  blockDom(i) { const v = __bmd.view(); let pos = 0; for (let k = 0; k < i; k++) pos += v.state.doc.child(k).nodeSize; return v.nodeDOM(pos); },
  blockRect(i) { const r = this.blockDom(i).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom }; },
}; true`;

/* ------------------------------------------------------------- harness */

const MODS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const NAMED = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, End: 35, Home: 36, F3: 114, F11: 122, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Delete: 46 };

function keyInfo(k, shift) {
  if (NAMED[k]) return { key: k, code: k, windowsVirtualKeyCode: NAMED[k] };
  if (k === '/') return { key: '/', code: 'Slash', windowsVirtualKeyCode: 191 };
  if (k === 'Equal') return { key: shift ? '+' : '=', code: 'Equal', windowsVirtualKeyCode: 187 };
  if (k === 'Minus') return { key: shift ? '_' : '-', code: 'Minus', windowsVirtualKeyCode: 189 };
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
  /**
   * Move the pointer in a straight line, in steps, the way a hand does. Teleporting
   * the mouse hid a menu bug: a diagonal path crosses other rows on its way.
   */
  async glide(from, to, steps = 12) {
    for (let i = 1; i <= steps; i++) {
      await t.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await sleep(12);
    }
    await sleep(250);
  },
  async hover(x, y) { await t.mouse('mouseMoved', x, y); await sleep(60); await t.mouse('mouseMoved', x + 1, y); await sleep(250); },
  async click(x, y) { await t.mouse('mouseMoved', x, y); await t.mouse('mousePressed', x, y); await t.mouse('mouseReleased', x, y); await sleep(200); },
  /** Start a new empty paragraph after a one-line document. */
  async newLine() { await t.open('start\n'); await t.caret('start'); await t.key('Enter'); },
  save: () => ev('__bmd.session.save()'),
  /** Reload the app (a fresh launch as far as the page is concerned) and wait for it. */
  async reload() {
    await ev('location.reload()').catch(() => {});
    await sleep(1500);
    for (let i = 0; i < 40; i++) {
      if (await ev('typeof window.__bmd === "object" && !!window.__bmd.session').catch(() => false)) break;
      await sleep(250);
    }
    await sleep(400);
    await ev(PAGE_HELPERS);
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  },
  /**
   * Answer native dialogs for the next steps (see platform.js `stub`), recording what
   * was asked in window.__asked. `answers` maps stub name → JS returning the answer.
   */
  async stub(answers) {
    const body = Object.entries(answers).map(([k, v]) => `${J(k)}: (...a) => { __asked.push([${J(k)}, ...a]); return (${v}); }`).join(',');
    await ev(`(() => { window.__asked = []; window.__bmdStub = { ${body} }; })()`);
  },
  asked: () => ev('window.__asked ?? []'),
  /** Click File ▸ Save As… (and a third level: File ▸ Open Recent ▸ path). */
  async menu(section, label, deep) {
    const centre = (sel, text) => ev(`(() => { const e = [...document.querySelectorAll(${J(sel)})].find((x) => ${text ? `x.textContent.includes(${J(text)})` : 'true'} && __parity.visible(x)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const b = await centre('#btn-menu');
    await t.click(b.x, b.y);
    const s = await centre(`.bmd-app-menu [data-section="${section}"]`);
    expect(s, `menu has no ${section} section`);
    await t.hover(s.x, s.y);
    const item = await centre('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-item', label);
    expect(item, `${section} menu has no "${label}"`);
    await t.glide(s, item);
    expect(await ev(`[...document.querySelectorAll('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-item')].some((e) => e.textContent.includes(${J(label)}) && __parity.visible(e))`),
      `moving the pointer from ${section} to "${label}" lost the ${section} menu`);
    if (!deep) { await t.click(item.x, item.y); await sleep(250); return; }
    const d0 = await centre('.bmd-app-deep .bmd-app-item', deep);
    expect(d0, `${section} ▸ ${label} did not open`);
    await t.glide(item, d0);
    const d = await centre('.bmd-app-deep .bmd-app-item', deep);
    expect(d, `${section} ▸ ${label} has no "${deep}"`);
    await t.click(d.x, d.y);
    await sleep(250);
  },
  /** Between checks: close menus, drop stubs and dev answers, restore the viewport. */
  async cleanup() {
    await t.key('Escape');
    await ev(`(() => { window.__bmdStub = null; try { localStorage.removeItem('bmd.devConfirm'); localStorage.removeItem('bmd.draft'); } catch {} })()`).catch(() => {});
    await send('Emulation.setEmulatedMedia', { features: [] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  },
  title: () => ev('document.title'),
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
  async 'math-edit'() {
    // Insert from the slash menu, type TeX, save.
    await t.newLine(); await t.type('/equation'); await sleep(350); await t.key('Enter'); await sleep(200);
    expect(await t.vis('.bmd-math-editor textarea'), '/equation did not open the equation editor');
    await t.type('a+b'); await t.key('Ctrl+Enter');
    expect((await t.save()) === 'start\n\n$$\na+b\n$$\n', 'new block equation saved as ' + J(await t.save()));
    // Click an existing one, replace its TeX: only that block changes.
    await t.open();
    const r = await ev(`(() => { const e = document.querySelector('.bmd-math-block'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await t.click(r.x, r.y);
    expect(await t.vis('.bmd-math-editor textarea'), 'clicking the equation did not open its editor');
    await t.key('Ctrl+A'); await t.type('x+y'); await t.key('Ctrl+Enter');
    expect((await t.save()) === FIXTURE.replace('a^2 + b^2 = c^2', 'x+y'), 'editing the equation changed more than its TeX');
  },
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

  async 'shortcut-math'() {
    await t.newLine(); await t.type('see $x^2$');
    expect(await ev(`(() => { let v = null; __bmd.view().state.doc.descendants((n) => { if (n.type.name === 'math_inline') v = n.attrs.value; }); return v; })()`) === 'x^2', '$x^2$ did not become an equation');
    await t.newLine(); await t.type('costs $5 and $10');
    expect(await ev(`__bmd.view().state.doc.lastChild.textContent`) === 'costs $5 and $10', 'prices turned into an equation');
    await t.newLine(); await t.type('$$ '); await sleep(200);
    expect(last(await t.top()) === 'math_block' && (await t.vis('.bmd-math-editor textarea')), '$$ + space did not start a block equation');
    await t.key('Escape');
  },

  /* Keyboard */
  ...Object.fromEntries([
    ['key-bold', 'Ctrl+B', 'strong'], ['key-italic', 'Ctrl+I', 'em'],
    ['key-code', 'Ctrl+E', 'p > code'], ['key-strike', 'Ctrl+Shift+X', 'del, .ProseMirror s'],
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
    const cases = [['1', 'heading1'], ['2', 'heading2'], ['3', 'heading3'], ['0', 'paragraph'], ['4', 'todo'], ['5', 'bullet_list'], ['6', 'ordered_list'], ['7', 'toggle'], ['8', 'code_block']];
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

  /* Containers, media, emoji, images, multi-select, page style */
  async 'toggle'() {
    await t.open();
    const state = () => ev(`(() => { const e = document.querySelector('.bmd-toggle'); return e && { open: e.dataset.open, title: e.querySelector('.bmd-toggle-summary').textContent, body: __parity.visible(e.querySelector('.bmd-toggle-body')) }; })()`);
    const s0 = await state();
    expect(s0 && s0.title === 'Toggle title' && s0.open === 'false' && !s0.body, 'toggle not rendered closed with its title: ' + J(s0));
    const arrow = await ev(`(() => { const e = document.querySelector('.bmd-toggle-arrow'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await t.click(arrow.x, arrow.y);
    expect((await state()).body && (await ev(`document.querySelector('.bmd-toggle-body').textContent.includes('Hidden text inside.')`)), 'clicking the arrow did not open the toggle');
    // Type at the end of the body's paragraph, through the nested editor.
    const end = await ev(`(() => { const p = document.querySelector('.bmd-toggle-body p'); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 }; })()`);
    await t.click(end.x, end.y); await t.key('End'); await t.type('!');
    expect((await t.save()) === FIXTURE.replace('Hidden text inside.', 'Hidden text inside.!'), 'editing inside the toggle changed more than its body');
    // /toggle, then the title goes into the new toggle.
    await t.newLine(); await t.type('/toggle'); await sleep(350); await t.key('Enter'); await sleep(250); await t.type('Title');
    expect((await t.save()) === 'start\n\n<details>\n<summary>Title</summary>\n\n</details>\n', '/toggle saved as ' + J(await t.save()));
  },
  async 'columns'() {
    await t.open();
    const cols = await ev(`[...document.querySelectorAll('.bmd-columns .bmd-column')].map(c => { c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; })`);
    expect(cols.length === 2 && cols[1].x > cols[0].x + 100 && Math.abs(cols[1].y - cols[0].y) < 4, 'columns not side by side: ' + J(cols));
    const end = await ev(`(() => { const p = document.querySelectorAll('.bmd-column')[1].querySelector('p'); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 }; })()`);
    await t.click(end.x, end.y); await t.key('End'); await t.type('!');
    expect((await t.save()) === FIXTURE.replace('Right column', 'Right column!'), 'editing the right column changed more than that column');
    await t.newLine(); await t.type('/columns'); await sleep(350); await t.key('Enter'); await sleep(250);
    expect(last(await t.top()) === 'column_row', '/2 columns did not insert columns');
  },
  async 'media'() {
    // A preview must display, never download: an untyped blob in a frame once put a
    // copy of the PDF into Downloads on every render. Count what lands there.
    const downloads = join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Downloads');
    const before = (() => { try { return readdirSync(downloads).length; } catch { return null; } })();
    await t.open();
    const bm = await ev(`(() => { const e = document.querySelector('.bmd-media-bookmark'); return e && e.querySelector('.bmd-bookmark-title').textContent; })()`);
    expect(bm === 'BlockMD website', 'no bookmark card for a lone web link: ' + J(bm));
    let audio = null;
    for (let i = 0; i < 20 && !(audio?.ready >= 1); i++) {
      await sleep(200);
      audio = await ev(`(() => { const a = document.querySelector('.bmd-media-audio audio'); return a && { ready: a.readyState, error: a.error && a.error.code }; })()`);
    }
    expect(audio && audio.ready >= 1 && !audio.error, 'local audio did not load: ' + J(audio));
    expect(await ev(`(document.querySelector('.bmd-media-pdf iframe')?.src ?? '').startsWith('blob:')`), 'no PDF preview');
    expect((await t.save()) === FIXTURE, 'previews changed the saved file');
    await sleep(1500);
    const after = (() => { try { return readdirSync(downloads).length; } catch { return null; } })();
    expect(before === null || after === before, `a preview started a download (${after - before} new file(s) in Downloads)`);
    const prompt = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).some((x) => x.url.startsWith('edge://permission'));
    expect(!prompt, 'the page raised a permission prompt');
  },
  async 'emoji'() {
    await t.newLine(); await t.type('hi :smi'); await sleep(150);
    expect(await t.vis('.bmd-emoji'), ':smi did not open the emoji picker');
    await t.key('Enter');
    const text = await ev(`__bmd.view().state.doc.lastChild.textContent`);
    expect(/^hi \p{Extended_Pictographic}/u.test(text) && !text.includes(':'), 'Enter did not insert an emoji: ' + J(text));
    await t.newLine(); await t.type('/emoji'); await sleep(350); await t.key('Enter'); await sleep(200);
    expect(await t.vis('.bmd-emoji'), '/emoji did not open the picker');
    await t.key('Escape');
  },
  async 'image-paste'() {
    await t.newLine();
    const b64 = readFileSync(join(ROOT, 'src-tauri/icons/32x32.png')).toString('base64');
    await ev(`(() => { const bin = atob(${J(b64)}); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      __bmd.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await sleep(800);
    let saved = [];
    try { saved = readdirSync(join(WORK, 'assets')); } catch { /* not created */ }
    expect(saved.length === 1 && /^image-\d{8}-\d{6}\.png$/.test(saved[0]), 'pasted image not saved to assets/: ' + J(saved));
    const w = await ev(`document.querySelector('.ProseMirror img[data-src^="assets/"]')?.naturalWidth ?? -1`);
    expect(w > 0, 'pasted image not shown');
    expect((await t.save()) === `start\n\n![](assets/${saved[0]})\n`, 'pasted image saved as ' + J(await t.save()));
  },
  async 'multi-select'() {
    await t.open('a\n\nb\n\nc\n\nd\n'); await t.caret('b'); await t.key('Escape'); await t.key('Shift+ArrowDown');
    expect((await ev(`document.querySelectorAll('.bmd-block-selected').length`)) === 2, 'Shift+↓ did not select two blocks');
    await t.key('Ctrl+Shift+ArrowUp');
    expect((await t.save()) === 'b\n\nc\n\na\n\nd\n', 'Ctrl+Shift+↑ did not move both blocks: ' + J(await t.save()));
    await t.key('Ctrl+D');
    expect((await t.save()) === 'b\n\nc\n\nb\n\nc\n\na\n\nd\n', 'Ctrl+D did not duplicate both blocks: ' + J(await t.save()));
    await t.key('Backspace');
    expect((await t.save()) === 'b\n\nc\n\na\n\nd\n', 'Backspace did not delete both blocks: ' + J(await t.save()));
  },
  async 'page-style'() {
    await t.open('Some text.\n');
    const centre = (sel) => ev(`(() => { const r = document.querySelector(${J(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const b = await centre('#btn-style');
    await t.click(b.x, b.y);
    expect(await t.vis('.bmd-style-menu'), 'the ··· button did not open the style menu');
    const clickIn = async (sel) => { const r = await centre(sel); await t.click(r.x, r.y); };
    try {
      await clickIn('[data-font="serif"]');
      expect(/Georgia/.test(await ev(`getComputedStyle(document.querySelector('.ProseMirror')).fontFamily`)), 'Serif did not change the font');
      await clickIn('[data-toggle="wide"]');
      expect((await ev(`document.querySelector('.editor-host').getBoundingClientRect().width`)) > 1000, 'Full width did not widen the page');
      await clickIn('[data-toggle="small"]');
      expect((await ev(`getComputedStyle(document.querySelector('.milkdown')).fontSize`)) === '14px', 'Small text did not shrink the text');
      expect((await t.save()) === 'Some text.\n', 'page style changed the file');
    } finally {
      await ev(`(() => { try { localStorage.removeItem('bmd.pageStyle'); } catch {} document.documentElement.classList.remove('style-serif', 'style-mono', 'style-small', 'style-wide'); })()`);
      await t.key('Escape');
    }
  },

  /* ——— Editor baseline (parity/editor.json) ——— */
  async 'launch-untitled'() {
    await ev(`(() => { for (const k of ['lastFile', 'draft', 'devConfirm']) localStorage.removeItem('bmd.' + k); })()`);
    await t.reload();
    const s = await ev(`({ name: __bmd.session.name, path: __bmd.path, text: __bmd.view().state.doc.textContent, status: document.getElementById('status-text').textContent })`);
    expect(s.name === 'Untitled.md' && s.path === null && s.text === '' && s.status === 'New document', 'launch without a file: ' + J(s));
  },
  async 'launch-last'() {
    const a = file('last.md', 'Reopen me.\n');
    await t.stub({ pickOpenPath: J(a) });
    await t.key('Ctrl+O'); await sleep(300);
    await t.reload();
    expect((await ev('__bmd.path')) === a, 'the last opened file was not reopened');
    await t.reload();
    expect((await ev('__bmd.session.name')) === 'Untitled.md', 'closing without doing anything did not give a new document next time');
  },
  async 'empty-file'() {
    const p = file('empty.md', '');
    await t.open(''); await ev(`__bmd.openPath(${J(p)})`); await ev(PAGE_HELPERS);
    expect((await ev('__bmd.session.status().ok')), 'an empty file failed the mapping');
    await ev('__bmd.view().focus()'); await t.type('Hello');
    await t.key('Ctrl+S'); await sleep(300);
    expect(readFileSync(p, 'utf8') === 'Hello', 'saved empty file contains ' + J(readFileSync(p, 'utf8')));
  },
  async 'new'() {
    await t.open('Some text.\n'); await t.caret('text'); await t.type('!');
    await t.stub({ confirm: 'true' });
    await t.key('Ctrl+N'); await sleep(300);
    const asked = await t.asked();
    expect(asked.some(([k, m]) => k === 'confirm' && /unsaved changes/.test(m)), 'New did not ask about unsaved changes');
    expect((await ev('__bmd.session.name')) === 'Untitled.md' && (await ev('__bmd.view().state.doc.textContent')) === '', 'New did not start an empty document');
  },
  async 'open'() {
    const b = file('open-me.md', '# Opened\n');
    await t.open('x\n'); await t.stub({ pickOpenPath: J(b) });
    await t.key('Ctrl+O'); await sleep(300);
    expect((await ev('__bmd.path')) === b && (await ev('__bmd.view().state.doc.textContent')) === 'Opened', 'Ctrl+O did not open the chosen file');
  },
  async 'open-recent'() {
    const a = file('recent-a.md', 'A\n'), b = file('recent-b.md', 'B\n');
    for (const p of [a, b]) { await t.stub({ pickOpenPath: J(p) }); await t.key('Ctrl+O'); await sleep(250); }
    await t.menu('File', 'Open Recent', 'recent-a.md');
    expect((await ev('__bmd.path')) === a, 'Open Recent did not open the file');
    rmSync(b);
    await t.menu('File', 'Open Recent', 'recent-b.md');
    expect(!(await ev(`JSON.parse(localStorage.getItem('bmd.recent') || '[]').includes(${J(b)})`)), 'a missing file stayed in Open Recent');
  },
  async 'save'() {
    const p = file('save.md', 'One.\n');
    await t.open(''); await ev(`__bmd.openPath(${J(p)})`); await ev(PAGE_HELPERS);
    await t.caret('One'); await t.type('!');
    await sleep(400); // the editor reports changes in batches of ~200 ms
    expect((await t.title()).includes('•'), 'the title shows no unsaved mark: ' + J(await ev(`({ title: document.title, dirty: __bmd.dirty, text: __bmd.view().state.doc.textContent, path: __bmd.path })`)));
    const expected = await t.save();
    await t.key('Ctrl+S'); await sleep(300);
    expect(readFileSync(p, 'utf8') === expected, 'Ctrl+S did not write the document');
    expect(!(await t.title()).includes('•'), 'the unsaved mark stayed after saving');
  },
  async 'save-untitled'() {
    const p = join(WORK, 'files', 'saved-untitled.md').replace(/\\/g, '/');
    rmSync(p, { force: true });
    await t.stub({ confirm: 'true', pickSavePath: J(p) });
    await t.key('Ctrl+N'); await sleep(300); await ev('__bmd.view().focus()'); await t.type('abc');
    await t.key('Ctrl+S'); await sleep(400);
    expect((await t.asked()).some(([k]) => k === 'pickSavePath'), 'saving an untitled document did not ask where');
    expect(readFileSync(p, 'utf8') === 'abc' && (await ev('__bmd.session.name')) === 'saved-untitled.md', 'untitled save wrote ' + J(readFileSync(p, 'utf8')));
  },
  async 'save-as'() {
    const a = file('orig.md', 'Original.\n');
    const copy = join(WORK, 'files', 'copy.md').replace(/\\/g, '/');
    rmSync(copy, { force: true });
    await t.open(''); await ev(`__bmd.openPath(${J(a)})`); await ev(PAGE_HELPERS);
    await t.caret('Original'); await t.type('!');
    await t.stub({ pickSavePath: J(copy) });
    await t.key('Ctrl+Shift+S'); await sleep(400);
    expect(readFileSync(copy, 'utf8') === 'Original!.\n' && readFileSync(a, 'utf8') === 'Original.\n', 'Save As did not write only the copy');
    expect((await ev('__bmd.path')) === copy, 'Save As did not continue in the new file');
  },
  async 'save-fails'() {
    const p = file('readonly.md', 'Locked.\n');
    chmodSync(p, 0o444);
    try {
      await t.open(''); await ev(`__bmd.openPath(${J(p)})`); await ev(PAGE_HELPERS);
      await t.caret('Locked'); await t.type('!');
      await t.key('Ctrl+S'); await sleep(400);
      const status = await ev(`document.getElementById('status-text').textContent`);
      expect(/Save failed/.test(status), 'no error for a failed save: ' + J(status));
      expect(await ev('__bmd.dirty') && (await t.title()).includes('•'), 'a failed save was shown as saved');
    } finally {
      chmodSync(p, 0o666);
    }
  },
  async 'disk-change'() {
    const p = file('external.md', 'Before.\n');
    await t.open(''); await ev(`__bmd.openPath(${J(p)})`); await ev(PAGE_HELPERS);
    await sleep(50); writeFileSync(p, 'After.\n'); await ev('__bmd.checkDisk()'); await sleep(300);
    expect((await ev('__bmd.view().state.doc.textContent')) === 'After.', 'a clean document was not reloaded after an outside change');
    await t.caret('After'); await t.type('!');
    await t.stub({ confirm: 'false' });
    await sleep(50); writeFileSync(p, 'Third.\n'); await ev('__bmd.checkDisk()'); await sleep(300);
    expect((await t.asked()).some(([k, m]) => k === 'confirm' && /changed by another program/.test(m)), 'no question about unsaved changes');
    expect((await ev('__bmd.view().state.doc.textContent')) === 'After!.', 'unsaved changes were lost although "keep" was chosen');
  },
  async 'drafts'() {
    const p = file('draft.md', 'Saved text.\n');
    await t.open(''); await ev(`__bmd.openPath(${J(p)})`); await ev(PAGE_HELPERS);
    await t.caret('Saved text'); await t.type(' plus unsaved');
    await sleep(900); // drafts are written 600 ms after the last change
    await ev(`localStorage.setItem('bmd.devConfirm', 'yes')`);
    await t.reload(); // as if BlockMD had crashed: no save, no close
    const s = await ev(`({ text: __bmd.view().state.doc.textContent, dirty: __bmd.dirty, path: __bmd.path })`);
    expect(s.text === 'Saved text plus unsaved.' && s.dirty && s.path === p, 'unsaved changes were not offered back: ' + J(s));
    await ev(`localStorage.removeItem('bmd.devConfirm')`);
    await t.key('Ctrl+S'); await sleep(400);
    expect(readFileSync(p, 'utf8') === 'Saved text plus unsaved.\n' && !(await ev(`localStorage.getItem('bmd.draft')`)), 'saving the recovered text did not write it and clear the draft');
  },
  async 'drop-md'() {
    const p = file('dropped.md', '# Dropped\n');
    await t.open('x\n');
    await ev(`__bmd.drop({ path: ${J(p)}, name: 'dropped.md', x: 10, y: 10, bytes: async () => new Uint8Array() })`); await sleep(300);
    expect((await ev('__bmd.path')) === p, 'dropping a .md file did not open it');
  },
  async 'close'() {
    await t.open('x\n'); await t.stub({ closeWindow: 'true' });
    await t.key('Ctrl+W');
    expect((await t.asked()).some(([k]) => k === 'closeWindow'), 'Ctrl+W did not close the window');
  },
  async 'print'() {
    await t.open('Printed text.\n'); await t.stub({ print: 'true' });
    await t.key('Ctrl+P');
    expect((await t.asked()).some(([k]) => k === 'print'), 'Ctrl+P did not print');
    await send('Emulation.setEmulatedMedia', { media: 'print' });
    const hidden = await ev(`['.topbar', '.statusbar'].every((s) => getComputedStyle(document.querySelector(s)).display === 'none')`);
    expect(hidden, 'printing includes the toolbar and status bar');
  },
  async 'menu'() {
    await t.open('x\n');
    const b = await ev(`(() => { const r = document.getElementById('btn-menu').getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 }; })()`);
    await t.click(b.x, b.y);
    const sections = await ev(`[...document.querySelectorAll('.bmd-app-menu [data-section]')].map((e) => e.dataset.section)`);
    expect(J(sections) === J(['File', 'Edit', 'View', 'Help']), 'menu sections: ' + J(sections));
    const got = {};
    for (const s of sections) {
      const r = await ev(`(() => { const e = document.querySelector('.bmd-app-menu [data-section="${s}"]'); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
      await t.hover(r.x, r.y);
      got[s] = await ev(`[...document.querySelectorAll('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-item')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
    }
    const want = { File: ['New Ctrl+N', 'Save As… Ctrl+Shift+S', 'Close Window Ctrl+W'], Edit: ['Undo Ctrl+Z', 'Replace… Ctrl+H', 'Copy as Markdown Ctrl+Shift+C'], View: ['Zoom In Ctrl+=', 'Toggle Full Screen F11'], Help: ['Check for Updates…', 'About BlockMD'] };
    for (const [s, items] of Object.entries(want)) for (const i of items) expect(got[s].some((g) => g.includes(i)), `${s} menu lacks "${i}": ${J(got[s])}`);
  },
  async 'undo-menu'() {
    await t.open('abc\n'); await t.caret('abc'); await t.type('d');
    await t.menu('Edit', 'Undo');
    expect((await ev('__bmd.view().state.doc.textContent')) === 'abc', 'Edit ▸ Undo did not undo');
    await t.menu('Edit', 'Redo');
    expect((await ev('__bmd.view().state.doc.textContent')) === 'abcd', 'Edit ▸ Redo did not redo');
  },
  async 'copy-md'() {
    await t.open('Some **bold** and _em_ text.\n');
    // Never the real clipboard: a check once overwrote the user's. execCommand('copy')
    // is swapped for a synthetic copy event with its own DataTransfer.
    await ev(`(() => { window.__copied = null; window.__execCommand = document.execCommand;
      document.execCommand = (cmd) => { if (cmd !== 'copy') return window.__execCommand.call(document, cmd);
        const dt = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
        window.__copied = dt.getData('text/plain'); return true; }; })()`);
    await ev(`(() => { const v = __bmd.view(); __parity.select(1, v.state.doc.content.size - 1); })()`);
    try {
      await t.key('Ctrl+Shift+C'); await sleep(200);
      expect((await ev('window.__copied')) === 'Some **bold** and _em_ text.', 'Copy as Markdown gave ' + J(await ev('window.__copied')));
    } finally {
      await ev('document.execCommand = window.__execCommand');
    }
  },
  async 'paste-plain'() {
    await t.newLine();
    // A synthetic Ctrl+Shift+V: a real one would paste the user's actual clipboard.
    await ev(`__bmd.view().dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`);
    await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', '# not a heading\\n- not a list');
      __bmd.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await sleep(200);
    const top = await t.top();
    expect(!top.includes('heading1') && !top.includes('bullet_list') && (await ev('__bmd.view().state.doc.textContent')).includes('# not a heading'), 'plain-text paste was parsed as Markdown: ' + J(top) + ' ' + J(await ev('__bmd.view().state.doc.textContent')));
  },
  async 'replace'() {
    await t.open('cat and cat\n\nother cat\n\nnone\n'); await t.caret('none');
    await t.key('Ctrl+H'); await t.type('cat');
    await ev(`document.querySelector('.bmd-replace-input').focus()`); await t.type('dog');
    await t.key('Enter');
    expect((await t.save()) === 'dog and cat\n\nother cat\n\nnone\n', 'Replace changed ' + J(await t.save()));
    await t.key('Ctrl+Enter');
    expect((await t.save()) === 'dog and dog\n\nother dog\n\nnone\n', 'Replace all gave ' + J(await t.save()));
  },
  async 'find-next'() {
    await t.open('a x a x a\n'); await t.caret('a');
    await t.key('Ctrl+F'); await t.type('a');
    const count = () => ev(`document.querySelector('.bmd-find-count').textContent`);
    expect((await count()) === '1/3', 'find count ' + (await count()));
    await t.key('F3'); expect((await count()) === '2/3', 'F3 did not go to the next match: ' + (await count()));
    await t.key('Shift+F3'); expect((await count()) === '1/3', 'Shift+F3 did not go back');
  },
  async 'source-view'() {
    await t.open('# Title\n\n* item\n');
    await t.menu('View', 'Show Source');
    expect(await ev(`__parity.visible('#source-pane') && document.getElementById('source-body').textContent === '# Title\\n\\n* item\\n'`), 'the source pane does not show the file');
    await t.menu('View', 'Show Source');
  },
  async 'zoom'() {
    await t.open('x\n');
    await send('Emulation.clearDeviceMetricsOverride');
    const w0 = await ev('innerWidth');
    await t.key('Ctrl+Equal'); await sleep(300);
    const w1 = await ev('innerWidth');
    await t.key('Ctrl+0'); await sleep(300);
    const w2 = await ev('innerWidth');
    expect(w1 < w0 && Math.abs(w2 - w0) <= 1, `zoom did not change the page: ${w0} → ${w1} → ${w2}`);
    expect((await ev(`localStorage.getItem('bmd.zoom')`)) === '1', 'zoom level not remembered');
  },
  async 'fullscreen'() {
    await t.open('x\n');
    await send('Emulation.clearDeviceMetricsOverride');
    const h0 = await ev('innerHeight');
    await t.key('F11'); await sleep(700);
    const h1 = await ev('innerHeight');
    await t.key('F11'); await sleep(700);
    expect(h1 > h0, `F11 did not go full screen (${h0} → ${h1})`);
  },
  async 'word-count'() {
    await t.open('Hello world, it’s me.\n\n你好世界\n');
    const words = await ev(`document.getElementById('stat-words').textContent`);
    expect(words === '8 words', 'word count: ' + J(words));
  },
  async 'links'() {
    const other = file('linked.md', '# Linked\n');
    await t.open(''); const here = file('links.md', '[site](https://example.com) and [other](linked.md)\n');
    await ev(`__bmd.openPath(${J(here)})`); await ev(PAGE_HELPERS);
    await t.stub({ openExternal: 'true' });
    const at = (text) => ev(`(() => { const p = __parity.find(${J(text)}) + 1; const c = __bmd.view().coordsAtPos(p); return { x: c.left + 2, y: (c.top + c.bottom) / 2 }; })()`);
    const site = await at('site');
    await t.mouse('mouseMoved', site.x, site.y); await t.mouse('mousePressed', site.x, site.y, { modifiers: 2 }); await t.mouse('mouseReleased', site.x, site.y, { modifiers: 2 }); await sleep(200);
    expect((await t.asked()).some(([k, u]) => k === 'openExternal' && u === 'https://example.com'), 'Ctrl+click did not open the web link');
    const o = await at('other');
    await t.mouse('mouseMoved', o.x, o.y); await t.mouse('mousePressed', o.x, o.y, { modifiers: 2 }); await t.mouse('mouseReleased', o.x, o.y, { modifiers: 2 }); await sleep(400);
    expect((await ev('__bmd.path')) === other, 'Ctrl+click did not open the linked .md file');
  },
  async 'update-check'() {
    await t.open('x\n'); await t.stub({ message: 'true' });
    await t.menu('Help', 'Check for Updates');
    await sleep(500);
    expect((await t.asked()).some(([k, m]) => k === 'message' && /latest version|update/i.test(m)), 'Check for Updates said nothing');
  },
  async 'about'() {
    await t.open('x\n'); await t.stub({ message: 'true' });
    await t.menu('Help', 'About BlockMD');
    await sleep(300);
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    expect((await t.asked()).some(([k, m]) => k === 'message' && m.includes(version)), 'About does not show version ' + version);
  },

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

// Two lists, one runner: what Notion does inside a page, and what any desktop editor
// is expected to do (the gaps Notion parity doesn't cover — see editor.json).
const LISTS = [
  ['Notion parity', 'parity/notion.json'],
  ['Editor baseline', 'parity/editor.json'],
];
const results = [];
for (const [list, file] of LISTS) {
  const { features } = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  for (const f of features) {
    const row = { ...f, list };
    if (f.status !== 'must') { results.push({ ...row, result: f.status }); continue; }
    if (only && !only.includes(f.check) && !only.includes(f.id)) continue;
    const run = checks[f.check];
    if (!run) { results.push({ ...row, result: 'fail', detail: `no check named "${f.check}" in scripts/parity.mjs` }); continue; }
    // Several features can share one check; run it once.
    const prior = results.find((r) => r.check === f.check && (r.result === 'pass' || r.result === 'fail'));
    if (prior) { results.push({ ...row, result: prior.result, detail: prior.detail }); continue; }
    let result = 'pass', detail = '';
    try {
      await Promise.race([run(), sleep(45000).then(() => { throw new Error('timed out'); })]);
    } catch (err) {
      result = 'fail';
      detail = String(err.message ?? err).split('\n').slice(0, 3).join(' ');
    }
    // A dialog that would have opened is a failure even if the check passed otherwise.
    const blocked = await ev(`(() => { const b = localStorage.getItem('bmd.devBlocked'); localStorage.removeItem('bmd.devBlocked'); return b; })()`).catch(() => null);
    if (blocked && blocked !== '[]' && result === 'pass') { result = 'fail'; detail = 'a native dialog would have opened: ' + blocked; }
    try { await t.cleanup(); } catch { /* best effort */ }
    results.push({ ...row, result, detail });
    console.log(`${result === 'pass' ? '✅' : '❌'} ${list} · ${f.area} · ${f.feature}${detail ? ' — ' + detail : ''}`);
  }
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

const icon = { pass: '✅', fail: '❌', planned: '🕓 planned', wontdo: "⛔ won't do" };
const lines = [`# Parity report — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, ''];
let allPass = true;
for (const [list] of LISTS) {
  const rows = results.filter((r) => r.list === list);
  const must = rows.filter((r) => r.status === 'must');
  const passed = must.filter((r) => r.result === 'pass').length;
  if (passed !== must.length) allPass = false;
  console.log(`${list}: ${passed} / ${must.length} must-have features passing.`);
  lines.push(`## ${list}: ${passed} / ${must.length} must-haves passing`, '',
    '| Area | Feature | Result | Detail |', '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.area} | ${r.feature} | ${icon[r.result]} | ${(r.detail || r.note || '').replace(/\|/g, '\\|')} |`), '');
}
writeFileSync(join(WORK, 'report.md'), lines.join('\n'));

// For the release gate (scripts/release-gate.mjs): which commit this result belongs
// to. Uncommitted changes to the app mean it belongs to no commit.
if (!only) {
  const git = (...a) => execSync(`git ${a.join(' ')}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = git('status', '--porcelain', '--', 'app', 'src', 'src-tauri', 'parity', 'scripts/parity.mjs', 'package.json');
  const summary = LISTS.map(([list]) => {
    const must = results.filter((r) => r.list === list && r.status === 'must');
    return `${list} ${must.filter((r) => r.result === 'pass').length}/${must.length}`;
  }).join(', ');
  writeFileSync(join(WORK, 'result.json'), JSON.stringify({
    commit: dirty ? null : git('rev-parse', 'HEAD'), allPass, summary, time: new Date().toISOString(),
  }, null, 2));
}
console.log('Report: .cache/parity/report.md');

// Leave the debug profile as a person would find it: dialogs on, nothing pending.
await ev(`(() => { for (const k of ${J([...DEV_KEYS, 'bmd.devNoDialogs'])}) localStorage.removeItem(k); })()`).catch(() => {});
ws.close();
stopApp();
process.exit(allPass ? 0 : 1);
